// @vitest-environment node
//
// The fake Claude Agent SDK, driven on its own. It stands in for the real one
// in CI, so it has to be wrong in the same ways: these pin the behaviours of
// the real SDK that the shim exists to cover, each recorded from the real
// thing. If the fake were more careful than the real one, the checks that
// run against it would prove nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanUseTool, SdkMessage, SdkOptions, SdkUserMessage } from '../../../lib/runtimes/claude-sdk/sdk.ts'
import { claudeSdkEnv, claudeSdkOptions } from '../../../lib/runtimes/claude-sdk/shim.ts'
import { armTripwire, tripwireAttempts } from '../../guards/tripwire.ts'
import { startWatchProxy, watchProxyEnv, type WatchProxy } from '../../guards/watch-proxy.ts'
import { fakeClaudeSdk } from '../fake-claude-sdk.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../scripted-model.ts'

armTripwire()

const NONCE = 'deadbeef'
let dir: string
let model: ScriptedModel
let watch: WatchProxy | undefined
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-fakesdk-'))
  for (const sub of ['home', 'work']) mkdirSync(path.join(dir, sub))
})
afterEach(async () => {
  await model?.close()
  watch?.close()
  watch = undefined
  rmSync(dir, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})

const work = (name: string): string => path.join(dir, 'work', name)
async function setup(script: ScriptEntry[], rigEnv: Record<string, string> = {}) {
  model = await startScriptedModel({ nonce: NONCE, script, shape: 'anthropic-messages' })
  // The fake is pointed straight at the scripted model here, so what it presents is that model's own key.
  const env = claudeSdkEnv({ homeDir: path.join(dir, 'home'), modelBaseUrl: model.baseUrl, placeholder: `UPSTREAM-${NONCE}`, rigEnv })
  return (tools: string[], patch: Partial<SdkOptions> = {}): SdkOptions =>
    ({ ...claudeSdkOptions({ tools, model: 'scripted', cwd: path.join(dir, 'work'), env }), ...patch })
}
/** Send the messages one after another and collect every record until the last turn's result. */
async function run(options: SdkOptions, messages: string[]): Promise<SdkMessage[]> {
  const records: SdkMessage[] = []
  let finished = 0
  let stopped = false
  async function* input(): AsyncGenerator<SdkUserMessage> {
    for (const [i, content] of messages.entries()) {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
      // The next message is sent once this one's turn has ended.
      while (finished <= i && !stopped) await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const query = fakeClaudeSdk().query({ prompt: input(), options })
  try {
    for await (const record of query) {
      records.push(record)
      if (record.type === 'result' && ++finished === messages.length) break
    }
  } finally {
    stopped = true
    query.close()
  }
  return records
}
const results = (records: SdkMessage[]) => records.filter((r) => r.type === 'result')
const allow: CanUseTool = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })
const deny: CanUseTool = async () => ({ behavior: 'deny', message: 'no' })

describe('the fake Claude Agent SDK', () => {
  it('[U:fake-claude-sdk] says what it is, and what it mimics is the pinned version', async () => {
    const options = await setup([])
    const records = await run(options([]), ['hello'])
    expect(records[0]).toEqual({ type: 'fake_claude_sdk' })
    expect(records.find((r) => r.subtype === 'init')).toMatchObject({ tools: [], claude_code_version: '2.1.325' })
    expect(await fakeClaudeSdk().version({})).toBe('0.3.325 (Claude Agent SDK), 2.1.325 (Claude Code)')
    expect(results(records)).toEqual([expect.objectContaining({ subtype: 'success', is_error: false, result: `ok FAKE-MODEL-${NONCE}` })])
  })

  it.each(['DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])('[U:fake-claude-sdk] refuses to start without %s, or outside its minimal mode', async (name) => {
    const options = await setup([])
    const env = { ...options([]).env }
    delete env[name]
    await expect(run({ ...options([]), env }, ['hello'])).rejects.toThrow(`refusing to start: ${name} is not 1`)
    await expect(run({ ...options([]), extraArgs: {} }, ['hello'])).rejects.toThrow('only its minimal mode exists here')
    expect(model.requests).toEqual([])
  })

  it('[U:fake-claude-sdk] like the real one, it runs a read in its work folder and a harmless shell command WITHOUT asking, unless told to ask about the tool by name', async () => {
    writeFileSync(work('notes.txt'), 'what the file holds')
    const options = await setup([
      { match: 'CANARY-read', tool: { name: 'Read', args: { file_path: work('notes.txt') } }, text: 'read' },
      { match: 'CANARY-cat', tool: { name: 'Bash', args: { command: `cat ${work('notes.txt')}` } }, text: 'catted' },
    ])
    const asked: string[] = []
    const refuse: CanUseTool = async (tool) => { asked.push(tool); return { behavior: 'deny', message: 'no' } }
    // Without the ask rules, nobody is asked and both run.
    const loose = options(['Bash', 'Read'], { canUseTool: refuse })
    delete loose.settings
    await run(loose, ['CANARY-read', 'CANARY-cat'])
    expect(asked).toEqual([])
    expect(model.requests.filter((r) => r.body.includes('what the file holds')).length).toBeGreaterThan(0)
    // With them, both are asked about, and a no stops them.
    const before = model.requests.length
    await run(options(['Bash', 'Read'], { canUseTool: refuse, cwd: path.join(dir, 'work') }), ['CANARY-read', 'CANARY-cat'])
    expect(asked).toEqual(['Read', 'Bash'])
    expect(model.requests.slice(before).some((r) => r.body.includes('what the file holds'))).toBe(false)
  })

  it('[U:fake-claude-sdk] it has exactly the tools it was started with: a call to another fails as no such tool, and nobody is asked', async () => {
    const options = await setup([{ match: 'CANARY-t', tool: { name: 'Bash', args: { command: `touch ${work('touched')}` } }, text: 'done' }])
    let asked = 0
    const records = await run(options([], { canUseTool: async (_t, input) => { asked++; return { behavior: 'allow', updatedInput: input } } }), ['CANARY-t'])
    expect(asked).toBe(0)
    expect(existsSync(work('touched'))).toBe(false)
    expect(model.requests.at(-1)!.body).toContain('No such tool available: Bash')
    expect(JSON.parse(model.requests[0].body).tools).toEqual([])
    expect(results(records)).toHaveLength(1)
  })

  it('[U:fake-claude-sdk] like the real one in its minimal mode, it has a shell, a read and an edit and no more: asked to start with a write tool, it starts without one', async () => {
    const options = await setup([{ match: 'CANARY-w', tool: { name: 'Write', args: { file_path: work('written'), content: 'x' } }, text: 'done' }])
    let asked = 0
    const records = await run(options(['Bash', 'Edit', 'Read', 'Write'], { canUseTool: async (_t, input) => { asked++; return { behavior: 'allow', updatedInput: input } } }), ['CANARY-w'])
    expect(records.find((r) => r.subtype === 'init')).toMatchObject({ tools: ['Bash', 'Edit', 'Read'] })
    expect(JSON.parse(model.requests[0].body).tools.map((t: { name: string }) => t.name)).toEqual(['Bash', 'Edit', 'Read'])
    expect(asked).toBe(0)
    expect(existsSync(work('written'))).toBe(false)
    expect(model.requests.at(-1)!.body).toContain('No such tool available: Write')
  })

  it('[U:fake-claude-sdk] a tool it has runs on a yes and not on a no, and with no one to ask it does not run', async () => {
    const script = [{ match: 'CANARY-t', tool: { name: 'Bash', args: { command: `touch ${work('touched')}` } }, text: 'done' }]
    const options = await setup(script)
    await run(options(['Bash'], { canUseTool: deny }), ['CANARY-t'])
    expect(existsSync(work('touched'))).toBe(false)
    await run(options(['Bash']), ['CANARY-t'])
    expect(existsSync(work('touched'))).toBe(false)
    await run(options(['Bash'], { canUseTool: allow }), ['CANARY-t'])
    expect(existsSync(work('touched'))).toBe(true)
  })

  it('[U:fake-claude-sdk] in the mode that asks nobody, it asks nobody', async () => {
    const options = await setup([{ match: 'CANARY-t', tool: { name: 'Bash', args: { command: `touch ${work('touched')}` } }, text: 'done' }])
    let asked = 0
    await run(options(['Bash'], { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, canUseTool: async () => { asked++; return { behavior: 'deny', message: 'no' } } }), ['CANARY-t'])
    expect(asked).toBe(0)
    expect(existsSync(work('touched'))).toBe(true)
  })

  it('[U:fake-claude-sdk] like the real one, a failed model call ends the turn as a result of subtype success, with the error as its text and is_error set', async () => {
    const options = await setup([{ match: 'CANARY-broke', text: '', status: 402 }])
    const records = await run(options([]), ['CANARY-broke'])
    expect(results(records)).toEqual([{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 402 scripted model: refused with 402', session_id: expect.any(String) }])
  })

  it('[U:fake-claude-sdk] a session keeps its thread, can be picked back up by its id, and a new one starts empty unless told to continue the last', async () => {
    const options = await setup([])
    const first = await run(options([]), ['remember CANARY-first', 'and CANARY-second'])
    const id = first.find((r) => r.subtype === 'init')!.session_id!
    expect(model.requests.at(-1)!.body).toContain('CANARY-first')
    await run(options([], { resume: id }), ['CANARY-third'])
    expect(model.requests.at(-1)!.body).toContain('CANARY-first')
    await run(options([]), ['CANARY-fresh'])
    expect(model.requests.at(-1)!.body).not.toContain('CANARY-first')
    await run(options([], { continue: true }), ['CANARY-continued'])
    expect(model.requests.at(-1)!.body).toContain('CANARY-fresh')
  })

  it('[U:fake-claude-sdk] like the real one, asked to pick up a session it has no transcript of, it ends the turn in an error without ever saying it started', async () => {
    const options = await setup([])
    const records = await run(options([], { resume: 'no-such-session' }), ['hello'])
    expect(records.filter((r) => r.type !== 'fake_claude_sdk')).toEqual([{ type: 'result', subtype: 'error_during_execution', is_error: true }])
    expect(model.requests).toEqual([])
  })

  it('[U:fake-claude-sdk] like the real one, it writes a message into the transcript when it takes it, so a session stopped in the middle of a model call can be picked back up', async () => {
    const entry: ScriptEntry = { match: 'CANARY-stuck', text: 'never', hang: true }
    const options = await setup([entry])
    const records: SdkMessage[] = []
    async function* once(): AsyncGenerator<SdkUserMessage> { yield { type: 'user', message: { role: 'user', content: 'CANARY-stuck' }, parent_tool_use_id: null }; await new Promise(() => {}) }
    const query = fakeClaudeSdk().query({ prompt: once(), options: options([]) })
    void (async () => { try { for await (const record of query) records.push(record) } catch { /* stopped */ } })()
    for (let i = 0; i < 200 && model.requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(model.requests).toHaveLength(1)
    query.close()
    const id = records.find((r) => r.subtype === 'init')!.session_id!
    entry.hang = false
    await run(options([], { resume: id }), ['and then'])
    expect(model.requests.at(-1)!.body).toContain('CANARY-stuck')
  })

  it('[U:fake-claude-sdk] its shell sees the environment it was given and nothing of this process, and it sends its model calls through the proxy that environment names', async () => {
    watch = await startWatchProxy()
    const options = await setup([{ match: 'CANARY-env', tool: { name: 'Bash', args: { command: `env > ${work('env.dump')}` } }, text: 'done' }], watchProxyEnv(watch.url))
    process.env.FAKE_SDK_HOST_CANARY = 'from-the-host'
    try {
      await run(options(['Bash'], { canUseTool: allow }), ['CANARY-env'])
    } finally {
      delete process.env.FAKE_SDK_HOST_CANARY
    }
    const dump = readFileSync(work('env.dump'), 'utf8')
    expect(dump).toContain(`ANTHROPIC_API_KEY=UPSTREAM-${NONCE}`)
    expect(dump).not.toContain('FAKE_SDK_HOST_CANARY')
    expect(watch.carried()).toBe(model.requests.length)
    expect(watch.carried()).toBeGreaterThan(0)
    expect(watch.attempts()).toEqual([])
  })
})
