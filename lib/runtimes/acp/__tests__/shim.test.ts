// @vitest-environment node
//
// The generic ACP shim, between a hand-held sidecar and the scripted agent.
// What it adds to the client: the door's yes must carry the hash of the call
// that was asked about, a tool the turn was not offered is never put to the
// door, and an agent that ran something without a yes has its turn reported
// as an error and its process and session dropped.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { callHash } from '../../../core/tools/call.ts'
import { createBrainServer, type BrainServer, type ShimLink } from '../../../door/brain-server.ts'
import type { Envelope, FromShim } from '../../../door/protocol.ts'
import { OPENCODE_CAPS } from '../../opencode/caps.ts'
import { startAcpShim, type AcpShim } from '../shim.ts'

const TOKEN = 'cell-test-token'
const AGENT = path.join(import.meta.dirname, 'scripted-agent.ts')

let dir: string
let brain: BrainServer | undefined
let shim: AcpShim | undefined
let link: ShimLink
let got: FromShim[]

const envelope = (patch: Partial<Envelope> = {}): Envelope => ({
  id: 'm-1', turnId: 'turn-1', sessionKey: 'fake:room:r-general', surface: 'fake', room: { id: 'r-general', kind: 'channel' },
  sender: { id: 'u-alice', display: 'Alice', isBot: false }, text: 'hello', attachments: [], context: {},
  tools: ['bash'], whenBusy: 'queue', deadlineMs: 5000, ...patch,
})
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(done()).toBe(true)
}
const agentLog = (): Record<string, unknown>[] => {
  const file = path.join(dir, 'agent.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
}
const outcomes = () => agentLog().filter((e) => 'ask' in e).map((e) => (e.got as { result: { outcome: unknown } }).result.outcome)
const shell = (id: string, command: string) => ({ ask: { toolCall: { toolCallId: id, kind: 'execute', rawInput: { command } } } })

async function start(steps: unknown[], o: { loadSession?: boolean } = {}): Promise<void> {
  dir = mkdtempSync(path.join(os.tmpdir(), 'acp-shim-'))
  mkdirSync(path.join(dir, 'work'))
  const script = path.join(dir, 'script.json')
  writeFileSync(script, JSON.stringify({ steps, log: path.join(dir, 'agent.log'), agentInfo: { name: 'Scripted', version: '1' }, loadSession: o.loadSession }))
  got = []
  const ready = new Promise<void>((resolve) => {
    void createBrainServer({ token: TOKEN, onShim: (l) => { link = l; l.onMessage((m) => got.push(m)); resolve() } })
      .then((b) => { brain = b; return startAcpShim({
        host: '127.0.0.1', port: b.port, token: TOKEN, caps: OPENCODE_CAPS, workDir: path.join(dir, 'work'),
        kinds: { execute: 'bash', read: 'read', edit: 'edit' }, expect: { name: 'Scripted', version: '1' },
        launch: () => ({ command: [process.execPath, AGENT, script], env: { PATH: process.env.PATH ?? '' } }),
        verdictTimeoutMs: 2000, vetoTimeoutMs: 3000, startMs: 10_000,
      }) }).then((s) => { shim = s })
  })
  await ready
  await until(() => shim !== undefined)
}

afterEach(async () => {
  shim?.close()
  shim = undefined
  await brain?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Answer every tool request the door gets with a yes, carrying the hash `hashFor` gives. */
function answerYes(hashFor: (tool: string, input: unknown) => string): void {
  link.onMessage((m) => {
    if (m.t === 'tool_request') link.send({ t: 'tool_verdict', callId: m.callId, allow: true, hash: hashFor(m.tool, m.input) })
  })
}

describe('the ACP shim', () => {
  it('[U:acp-hash-bound] a yes runs the call only when it carries the hash of that call', async () => {
    await start([shell('a', 'ls'), shell('b', 'ls -la'), { say: 'done' }])
    let n = 0
    // The first yes names the call; the second names a different one.
    answerYes((tool, input) => (n++ === 0 ? callHash(tool, input) : callHash(tool, { command: 'something else' })))
    link.send({ t: 'turn', env: envelope() })
    await until(() => got.some((m) => m.t === 'settled'))
    expect(outcomes()).toEqual([{ outcome: 'selected', optionId: 'once' }, { outcome: 'selected', optionId: 'reject' }])
    expect(got.filter((m) => m.t === 'tool_request').map((m) => m.t === 'tool_request' && m.input)).toEqual([{ command: 'ls' }, { command: 'ls -la' }])
  })

  it('[U:acp-offered] a tool the turn was not offered is refused without asking the door', async () => {
    await start([shell('a', 'ls'), { ask: { toolCall: { toolCallId: 'r', kind: 'read', rawInput: { filePath: 'x' } } } }, { say: 'done' }])
    answerYes(callHash)
    link.send({ t: 'turn', env: envelope({ tools: ['read'] }) })
    await until(() => got.some((m) => m.t === 'settled'))
    expect(got.filter((m) => m.t === 'tool_request').map((m) => m.t === 'tool_request' && m.tool)).toEqual(['read'])
    expect(outcomes()).toEqual([{ outcome: 'selected', optionId: 'reject' }, { outcome: 'selected', optionId: 'once' }])
  })

  it('[U:acp-breach] an agent that runs a refused call has its turn reported as an error, and the next turn gets a new process', async () => {
    await start([shell('a', 'touch x'), { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' } }, { say: 'did it' }], { loadSession: true })
    link.onMessage((m) => { if (m.t === 'tool_request') link.send({ t: 'tool_verdict', callId: m.callId, allow: false }) })
    link.send({ t: 'turn', env: envelope() })
    await until(() => got.some((m) => m.t === 'error'))
    expect(got.find((m) => m.t === 'error')).toEqual({ t: 'error', turnId: 'turn-1', message: 'the agent ran a call the door said no to' })
    expect(got.filter((m) => m.t === 'reply')).toEqual([])
    link.send({ t: 'turn', env: envelope({ turnId: 'turn-2' }) })
    await until(() => got.filter((m) => m.t === 'error').length === 2)
    expect(agentLog().filter((e) => 'initialize' in e)).toHaveLength(2)
    // What it did is in that session, so the new process is given a new one, not the old one back.
    expect(agentLog().filter((e) => 'load' in e)).toEqual([])
  })
})
