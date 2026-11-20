// @vitest-environment node
//
// The ACP client against a scripted agent: a real child process speaking
// JSON-RPC over stdio (scripted-agent.ts). No Docker, no model, no door.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAcpClient, type AcpClient, type GateCall } from '../client.ts'
import type { AcpToolKind } from '../permission.ts'

const AGENT = path.join(import.meta.dirname, 'scripted-agent.ts')
const KINDS: Partial<Record<AcpToolKind, string>> = { execute: 'bash', read: 'read', edit: 'edit' }
const open: AcpClient[] = []
afterEach(() => { for (const c of open.splice(0)) c.close() })

interface Run { client: AcpClient; asked: GateCall[]; breaches: string[]; work: string; log(): Record<string, unknown>[] }

function start(steps: unknown[], o: { allow?: (call: GateCall) => boolean | Promise<boolean>; agentInfo?: unknown; expect?: { name: string; version: string }; vetoTimeoutMs?: number } = {}): Run {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-client-'))
  const work = path.join(dir, 'work')
  const log = path.join(dir, 'agent.log')
  const scriptFile = path.join(dir, 'script.json')
  writeFileSync(scriptFile, JSON.stringify({ steps, log, ...(o.agentInfo ? { agentInfo: o.agentInfo } : {}) }))
  const child = spawn(process.execPath, [AGENT, scriptFile], { stdio: ['pipe', 'pipe', 'inherit'] })
  const asked: GateCall[] = []
  const breaches: string[] = []
  const client = createAcpClient({
    stdin: child.stdin, stdout: child.stdout,
    onExit: (cb) => { child.on('exit', cb) }, kill: () => { child.kill() },
  }, {
    workDir: work, kinds: KINDS, expect: o.expect, vetoTimeoutMs: o.vetoTimeoutMs ?? 2000, startMs: 10_000,
    gate: async (call) => { asked.push(call); return o.allow ? o.allow(call) : false },
    onBreach: (why) => breaches.push(why),
  })
  open.push(client)
  return {
    client, asked, breaches, work,
    log: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  }
}

const shell = (id: string, command: string) => ({ toolCallId: id, kind: 'execute', title: command, status: 'pending', rawInput: { command } })
const answers = (r: Run) => r.log().filter((e) => 'ask' in e).map((e) => (e.got as { result?: { outcome: unknown } }).result?.outcome)
const done = (id: string) => ({ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } })

describe('ACP client: what it offers', () => {
  it('[U:acp-no-client-methods] advertises no file or terminal methods, and answers a call to one with "method not found"', async () => {
    const r = start([
      { call: { method: 'fs/write_text_file', params: { sessionId: 'ses-1', path: '/etc/x', content: 'x' } } },
      { call: { method: 'fs/read_text_file', params: { sessionId: 'ses-1', path: '/etc/passwd' } } },
      { call: { method: 'terminal/create', params: { sessionId: 'ses-1', command: 'sh' } } },
      { say: 'ok' },
    ])
    await r.client.open()
    expect(await r.client.prompt('hi')).toEqual({ text: 'ok', stopReason: 'end_turn' })
    const init = r.log().find((e) => 'initialize' in e)?.initialize as { clientCapabilities: unknown }
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false })
    const calls = r.log().filter((e) => 'call' in e).map((e) => (e.got as { error?: { code: number } }).error?.code)
    expect(calls).toEqual([-32601, -32601, -32601])
  })

  it('[U:acp-pinned-version] an agent that reports another name or version is sent no prompt', async () => {
    const r = start([{ say: 'should not be heard' }], { agentInfo: { name: 'OpenCode', version: '0.0.1' }, expect: { name: 'OpenCode', version: '1.19.5' } })
    await expect(r.client.open()).rejects.toThrow('this is not the pinned agent version')
    const ok = start([{ say: 'heard' }], { agentInfo: { name: 'OpenCode', version: '1.19.5' }, expect: { name: 'OpenCode', version: '1.19.5' } })
    await ok.client.open()
    expect((await ok.client.prompt('hi')).text).toBe('heard')
  })
})

describe('ACP client: permission requests', () => {
  it('[U:acp-once-only] a yes is answered allow_once and a no reject_once; "always" is never picked', async () => {
    const r = start([{ ask: { toolCall: shell('a', 'ls') } }, { ask: { toolCall: shell('b', 'rm x') } }], { allow: (c) => c.input.command === 'ls' })
    await r.client.open()
    await r.client.prompt('go')
    expect(answers(r)).toEqual([{ outcome: 'selected', optionId: 'once' }, { outcome: 'selected', optionId: 'reject' }])
    expect(r.asked.map((c) => c.input)).toEqual([{ command: 'ls' }, { command: 'rm x' }])
  })

  it('[U:acp-once-only] offered only "always" options, the answer is cancelled, even when the door said yes', async () => {
    const always = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'ra', kind: 'reject_always' }]
    const r = start([{ ask: { toolCall: shell('a', 'ls'), options: always } }], { allow: () => true })
    await r.client.open()
    await r.client.prompt('go')
    expect(answers(r)).toEqual([{ outcome: 'cancelled' }])
  })

  it('[U:acp-unclassified] a tool kind the adapter does not map is refused without asking the door', async () => {
    const r = start([
      { ask: { toolCall: { toolCallId: 'x', kind: 'other', title: 'external_directory', rawInput: { parentDir: '/' } } } },
      { ask: { toolCall: { toolCallId: 'y', kind: 'fetch', title: 'webfetch', rawInput: { url: 'https://example.com' } } } },
      { ask: { toolCall: { toolCallId: 'z', kind: 'made-up', rawInput: {} } } },
    ], { allow: () => true })
    await r.client.open()
    await r.client.prompt('go')
    expect(r.asked).toEqual([])
    expect(answers(r)).toEqual([0, 1, 2].map(() => ({ outcome: 'selected', optionId: 'reject' })))
  })

  it('[U:acp-scratch-folder] a call that names a path outside the scratch folder is refused without asking the door', async () => {
    const r = start([
      { ask: { toolCall: { toolCallId: 'r1', kind: 'read', rawInput: { filePath: '/etc/passwd' } } } },
      { ask: { toolCall: { toolCallId: 'r2', kind: 'read', rawInput: { filePath: '../outside.txt' } } } },
      { ask: { toolCall: { toolCallId: 'e1', kind: 'edit', rawInput: { filepath: 'ok.txt' }, locations: [{ path: '/tmp/elsewhere' }] } } },
      { ask: { toolCall: { toolCallId: 's1', kind: 'execute', rawInput: { command: 'ls', cwd: '/' } } } },
      { ask: { toolCall: { toolCallId: 'r3', kind: 'read', rawInput: { filePath: 'inside.txt' } } } },
    ], { allow: () => true })
    await r.client.open()
    await r.client.prompt('go')
    expect(r.asked).toEqual([{ toolCallId: 'r3', tool: 'read', input: { path: 'inside.txt' } }])
  })

  it('[U:acp-read-input] a read that asks with an empty input is put to the door with the file the agent reported for that call', async () => {
    const r = start([
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'r', status: 'in_progress', kind: 'read', rawInput: { filePath: 'notes.txt' } } },
      { ask: { toolCall: { toolCallId: 'r', kind: 'read', rawInput: {} } } },
    ], { allow: () => true })
    await r.client.open()
    await r.client.prompt('go')
    expect(r.asked).toEqual([{ toolCallId: 'r', tool: 'read', input: { path: 'notes.txt' } }])
  })

  it('[U:acp-veto-fails-closed] a gate that throws, or answers late, is a no', async () => {
    const r = start([{ ask: { toolCall: shell('a', 'ls') } }], { allow: () => { throw new Error('boom') } })
    await r.client.open()
    await r.client.prompt('go')
    const slow = start([{ ask: { toolCall: shell('a', 'ls') } }], { allow: () => new Promise((resolve) => setTimeout(() => resolve(true), 600)), vetoTimeoutMs: 100 })
    await slow.client.open()
    await slow.client.prompt('go')
    for (const run of [r, slow]) expect(answers(run)).toEqual([{ outcome: 'selected', optionId: 'reject' }])
  })

  it('[U:acp-reask] a changed command under the same call id is asked again, with its own input', async () => {
    const r = start([
      { ask: { toolCall: shell('a', 'ls') } },
      { ask: { toolCall: shell('a', 'ls; rm -rf .') } },
    ], { allow: (c) => c.input.command === 'ls' })
    await r.client.open()
    await r.client.prompt('go')
    expect(r.asked.map((c) => c.input.command)).toEqual(['ls', 'ls; rm -rf .'])
    expect(answers(r)).toEqual([{ outcome: 'selected', optionId: 'once' }, { outcome: 'selected', optionId: 'reject' }])
  })
})

describe('ACP client: an agent that acts without a yes is caught', () => {
  it('[U:acp-breach] a call reported finished after a no is a breach, and the prompt fails', async () => {
    const r = start([{ ask: { toolCall: shell('a', 'touch x') } }, done('a'), { say: 'did it anyway' }])
    await r.client.open()
    await expect(r.client.prompt('go')).rejects.toThrow('the agent ran a call the door said no to')
    expect(r.breaches).toEqual(['the agent ran a call the door said no to'])
  })

  it('[U:acp-breach] a call reported finished that was never asked about is a breach', async () => {
    const r = start([{ update: { sessionUpdate: 'tool_call', toolCallId: 'q', kind: 'execute', status: 'pending', rawInput: { command: 'touch x' } } }, done('q')])
    await r.client.open()
    await expect(r.client.prompt('go')).rejects.toThrow('the agent ran a call it never asked the door about')
  })

  it('[U:acp-breach] a call said yes to and then reported running another command is a breach', async () => {
    const r = start([
      { ask: { toolCall: shell('a', 'ls') } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', kind: 'execute', rawInput: { command: 'curl evil' } } },
      done('a'),
    ], { allow: () => true })
    await r.client.open()
    await expect(r.client.prompt('go')).rejects.toThrow('the agent ran a call other than the one the door said yes to')
  })

  it('[U:acp-breach] a call said yes to and then reported running outside the scratch folder is a breach', async () => {
    const r = start([
      { ask: { toolCall: shell('a', 'ls') } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls', cwd: '/' } } },
      done('a'),
    ], { allow: () => true })
    await r.client.open()
    await expect(r.client.prompt('go')).rejects.toThrow('the agent ran a call other than the one the door said yes to')
  })

  it('[U:acp-breach] a call reported finished after the turn is over, never said yes to, stops the process', async () => {
    const r = start([{ say: 'done' }, { late: { sessionUpdate: 'tool_call_update', toolCallId: 'sneak', status: 'completed' } }])
    await r.client.open()
    expect((await r.client.prompt('go')).text).toBe('done')
    for (let i = 0; i < 100 && r.breaches.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(r.breaches).toEqual(['the agent ran a call after its turn was over'])
    await expect(r.client.prompt('again')).rejects.toThrow('the agent process ended')
  })

  it('[U:acp-breach] positive control: a late report of a call that was said yes to is not a breach', async () => {
    const r = start([{ ask: { toolCall: shell('a', 'ls') } }, { say: 'ok' }, { late: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' } }], { allow: () => true })
    await r.client.open()
    await r.client.prompt('go')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(r.breaches).toEqual([])
  })

  it('[U:acp-breach] positive control: a call said yes to, reported with the same command and finished, is not a breach', async () => {
    const r = start([
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls', cwd: '.' } } },
      { ask: { toolCall: shell('a', 'ls') } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls', description: 'list' } } },
      done('a'), { say: 'listed' },
    ], { allow: () => true })
    await r.client.open()
    expect(await r.client.prompt('go')).toEqual({ text: 'listed', stopReason: 'end_turn' })
    expect(r.breaches).toEqual([])
  })
})
