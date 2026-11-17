// @vitest-environment node
//
// The in-cell tool gate, run directly. The fake Pi and the real Pi both load
// this same file, but only a direct test can reach every way it must say no:
// a timeout, a cancel, a thrown error, a missing channel, a near-miss answer,
// a yes meant for another call, a path that leaves the scratch folder.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callHash } from '../../../core/tools/call.ts'
import swarmGate, { createGate } from '../cell/gate.ts'
import { GATE_PREFIX, GATE_READY } from '../rpc.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

/** Loads a gate the way Pi does and hands back what it registered. */
function load(gate: (pi: never) => void = swarmGate as never) {
  const handlers: Record<string, Handler> = {}
  gate({ on: (name: string, handler: Handler) => { handlers[name] = handler }, registerTool: () => {} } as never)
  return handlers
}

const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarmlab-gate-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const work = path.join(base, 'work')
mkdirSync(work)
writeFileSync(path.join(base, 'outside.txt'), 'out')
symlinkSync(path.join(base, 'outside.txt'), path.join(work, 'link'))

const ENV = ['SWARM_GATE_TIMEOUT_MS', 'SWARM_WORKSPACE', 'SWARM_TOOL_SECONDS', 'SWARM_TOOL_OUTPUT_BYTES']
beforeEach(() => { process.env.SWARM_WORKSPACE = work })
afterEach(() => { for (const name of ENV) delete process.env[name] })

const bash = (input: Record<string, unknown> = { command: 'rm -rf /' }) => ({ toolName: 'bash', toolCallId: 'call-1', input })
/** A channel that answers every question with `answer(options)`, and records what was asked. */
function ui(answer: (options: string[]) => Promise<string | undefined> | string | undefined) {
  const asked: { title: string; options: string[]; opts?: { timeout?: number } }[] = []
  const notices: string[] = []
  return {
    asked, notices,
    ctx: {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[], opts?: { timeout?: number }) => { asked.push({ title, options, opts }); return answer(options) },
        notify: (message: string) => { notices.push(message) },
      },
    },
  }
}
const yes = (options: string[]): string => options[0]
const blocked = (why?: string) => ({ block: true, reason: why === undefined ? expect.stringContaining('swarm gate') : `swarm gate: ${why}` })

describe('the Pi tool gate', () => {
  it('[U:pi-gate] says it is loaded as soon as the session starts', async () => {
    const u = ui(yes)
    await load().session_start({ reason: 'startup' }, u.ctx)
    expect(u.notices).toEqual([GATE_READY])
  })

  it('[U:pi-gate] asks the sidecar about the exact call, and the only answer it offers as a yes names that call\'s hash', async () => {
    const u = ui(yes)
    const call = bash()
    expect(await load().tool_call(call, u.ctx)).toBeUndefined()
    const input = { command: 'rm -rf /', timeout: 60 }
    expect(u.asked).toEqual([{
      title: GATE_PREFIX + JSON.stringify({ tool: 'bash', input, callId: 'call-1' }),
      options: [`allow:${callHash('bash', input)}`, 'deny'], opts: { timeout: 30_000 },
    }])
  })

  it.each([
    ['deny', 'deny'],
    ['nothing: a timeout or a cancel', undefined],
    ['a bare allow, with no call named', 'allow'],
    ['a yes to another call', `allow:${callHash('bash', { command: 'ls', timeout: 60 })}`],
    ['a yes to the same input under another tool', `allow:${callHash('read', { command: 'rm -rf /', timeout: 60 })}`],
    ['a yes to the call as it was before the time limit was put on it', `allow:${callHash('bash', { command: 'rm -rf /' })}`],
    ['a near miss', `Allow:${callHash('bash', { command: 'rm -rf /', timeout: 60 })}`],
    ['a near miss', `allow:${callHash('bash', { command: 'rm -rf /', timeout: 60 })} `],
    ['a near miss', `allow:${callHash('bash', { command: 'rm -rf /', timeout: 60 }).slice(0, 63)}`],
    ['a near miss', 'yes'],
    ['an empty answer', ''],
    ['something that is not text', true as never],
  ])('[U:pi-gate] blocks on %s', async (_what, answer) => {
    expect(await load().tool_call(bash(), ui(() => answer).ctx)).toEqual(blocked('not allowed'))
  })

  it('[U:pi-gate] positive control: the yes that names this call lets it run', async () => {
    const right = `allow:${callHash('bash', { command: 'rm -rf /', timeout: 60 })}`
    expect(await load().tool_call(bash(), ui(() => right).ctx)).toBeUndefined()
  })

  it('[U:pi-gate] blocks a call that changed while it waited for its answer', async () => {
    const call = bash({ command: 'ls' })
    const swap = ui((options) => { call.input.command = 'rm -rf /'; return options[0] })
    expect(await load().tool_call(call, swap.ctx)).toEqual(blocked('the call changed while it waited'))
  })

  it('[U:pi-gate] blocks when asking throws, and when there is no channel to ask on', async () => {
    expect(await load().tool_call(bash(), ui(async () => { throw new Error('ui gone') }).ctx)).toEqual(blocked('could not get a verdict'))
    const noUi = ui(yes)
    expect(await load().tool_call(bash(), { ...noUi.ctx, hasUI: false })).toEqual(blocked('no channel to the sidecar'))
    expect(noUi.asked).toEqual([])
    expect(await load().tool_call(bash(), undefined)).toEqual(blocked())
    // An input that cannot be written down as JSON cannot be asked about.
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(await load().tool_call(bash(loop), ui(yes).ctx)).toEqual(blocked())
    for (const input of [undefined, null, 'ls', ['ls']]) expect(await load().tool_call({ toolName: 'bash', toolCallId: 'c', input }, ui(yes).ctx)).toEqual(blocked('not a call it can read'))
  })

  it('[U:pi-gate] takes its timeout from the environment, and falls back to 30 seconds on nonsense', async () => {
    for (const [value, want] of [['250', 250], ['0', 30_000], ['-5', 30_000], ['soon', 30_000], ['1.5', 30_000]] as const) {
      process.env.SWARM_GATE_TIMEOUT_MS = value
      const u = ui(() => 'deny')
      await load().tool_call(bash(), u.ctx)
      expect(u.asked[0].opts).toEqual({ timeout: want })
    }
  })
})

describe('the gate keeps file tools in the scratch folder', () => {
  const file = (toolName: string, input: Record<string, unknown>) => ({ toolName, toolCallId: 'c', input })

  it.each(['read', 'write', 'edit', 'ls', 'grep', 'find'])('[U:pi-gate-path] %s is refused a path that leaves, before anyone is asked', async (tool) => {
    for (const p of ['../outside.txt', path.join(base, 'outside.txt'), 'link', '/etc/passwd', '..']) {
      const u = ui(yes)
      expect(await load().tool_call(file(tool, { path: p }), u.ctx), p).toEqual(blocked(p === 'link' || p.includes('outside') || p === '..' || p === '/etc/passwd' ? 'the path is outside the scratch folder' : undefined))
      expect(u.asked).toEqual([])
    }
  })

  it('[U:pi-gate-path] a path that stays is handed to the tool, and to the sidecar, as the full plain path that was checked', async () => {
    const u = ui(yes)
    const call = file('write', { path: 'notes/../a.txt', content: 'hi' })
    expect(await load().tool_call(call, u.ctx)).toBeUndefined()
    const input = { path: path.join(work, 'a.txt'), content: 'hi' }
    expect(call.input).toEqual(input)
    expect(u.asked[0].title).toBe(GATE_PREFIX + JSON.stringify({ tool: 'write', input, callId: 'c' }))
    expect(u.asked[0].options[0]).toBe(`allow:${callHash('write', input)}`)
  })

  it('[U:pi-gate-path] a tool given no path is given the scratch folder itself', async () => {
    const call = file('ls', {})
    expect(await load().tool_call(call, ui(yes).ctx)).toBeUndefined()
    expect(call.input).toEqual({ path: work })
  })

  it('[U:pi-gate-path] with no scratch folder named, no file tool runs at all', async () => {
    for (const value of [undefined, '', 'relative', path.join(base, 'gone')]) {
      if (value === undefined) delete process.env.SWARM_WORKSPACE
      else process.env.SWARM_WORKSPACE = value
      expect(await load().tool_call(file('read', { path: 'a.txt' }), ui(yes).ctx)).toEqual(blocked('there is no scratch folder'))
    }
  })

  it('[U:pi-gate-path] a path that is not text is refused', async () => {
    for (const p of [7, null, ['a'], { a: 1 }]) expect(await load().tool_call(file('read', { path: p }), ui(yes).ctx)).toEqual(blocked('that is not a path'))
  })

  it('[U:pi-gate-path] a shell is not held to the scratch folder: the cell is what holds it', async () => {
    expect(await load().tool_call(bash({ command: 'cat /etc/passwd' }), ui(yes).ctx)).toBeUndefined()
  })
})

describe('the gate applies the limits', () => {
  it('[U:pi-gate-limits] a shell call is given the time limit, and keeps a shorter one of its own', async () => {
    process.env.SWARM_TOOL_SECONDS = '7'
    for (const [own, want] of [[undefined, 7], [3, 3], [7, 7], [8, 7], [600, 7], [0, 7], [-1, 7], ['2', 7], [Number.NaN, 7], [0.5, 0.5]] as const) {
      const call = bash({ command: 'sleep 100', ...(own === undefined ? {} : { timeout: own }) })
      await load().tool_call(call, ui(yes).ctx)
      expect(call.input.timeout, String(own)).toBe(want)
    }
    delete process.env.SWARM_TOOL_SECONDS
    const call = bash({ command: 'sleep 100' })
    await load().tool_call(call, ui(yes).ctx)
    expect(call.input.timeout).toBe(60)
  })

  it('[U:pi-gate-limits] output over the cap is cut before the model sees it: a shell keeps the end, a file tool the start', async () => {
    process.env.SWARM_TOOL_OUTPUT_BYTES = '10'
    const result = (toolName: string, text: string) => load().tool_result({ toolName, content: [{ type: 'text', text }] }, undefined)
    expect(await result('bash', 'HEAD-0123456789-TAIL')).toEqual({ content: [{ type: 'text', text: '[cut: the first 10 bytes of output were left out]\n56789-TAIL' }] })
    expect(await result('read', 'HEAD-0123456789-TAIL')).toEqual({ content: [{ type: 'text', text: 'HEAD-01234\n[cut: 10 more bytes of output were left out]' }] })
    expect(await result('bash', '0123456789')).toBeUndefined()
    // Bytes, not characters, and a part that is not text does not get through by not being text.
    expect(await result('read', 'ééééééé')).toMatchObject({ content: [{ text: expect.stringContaining('[cut: 4 more bytes') }] })
    const image = await load().tool_result({ toolName: 'read', content: [{ type: 'image', data: 'x'.repeat(500) }] }, undefined) as { content: { text: string }[] }
    expect(image.content[0].text).not.toContain('xxxx')
    expect(await load().tool_result({ toolName: 'read' }, undefined)).toBeUndefined()
  })
})

describe('a gate with a part switched off in its source', () => {
  it('[U:pi-gate] is what the broken shims are made of, and is not what Pi is given: the gate file\'s own export has every part', async () => {
    const lax = load(createGate({ confine: false, limits: false }) as never)
    const call = { toolName: 'read', toolCallId: 'c', input: { path: '/etc/passwd' } }
    expect(await lax.tool_call(call, ui(yes).ctx)).toBeUndefined()
    const sh = bash({ command: 'sleep 100' })
    await lax.tool_call(sh, ui(yes).ctx)
    expect(sh.input).toEqual({ command: 'sleep 100' })
    process.env.SWARM_TOOL_OUTPUT_BYTES = '10'
    expect(await lax.tool_result({ toolName: 'bash', content: [{ type: 'text', text: 'x'.repeat(50) }] }, undefined)).toBeUndefined()
    // Nothing in the environment switches a part off.
    process.env.SWARM_GATE_CONFINE = '0'
    process.env.SWARM_GATE_LIMITS = 'false'
    try {
      expect(await load().tool_call({ toolName: 'read', toolCallId: 'c', input: { path: '/etc/passwd' } }, ui(yes).ctx)).toEqual(blocked('the path is outside the scratch folder'))
    } finally { delete process.env.SWARM_GATE_CONFINE; delete process.env.SWARM_GATE_LIMITS }
  })
})

describe('a shell Pi was told to change behind the gate\'s back', () => {
  // Pi reads `shellCommandPrefix` and `shellPath` from its settings, in its own folder and in the
  // scratch folder (`.pi/settings.json`), when it starts. A prefix runs before every command, out of
  // sight of the door, which only ever read the command. One earlier yes that writes such a file
  // would turn every later `ls` the command policy lets through without a yes into anything at all.
  const agent = path.join(base, 'agent')
  const project = path.join(work, '.pi')
  beforeEach(() => { mkdirSync(agent, { recursive: true }); process.env.PI_CODING_AGENT_DIR = agent })
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR
    rmSync(path.join(agent, 'settings.json'), { force: true })
    rmSync(project, { recursive: true, force: true })
  })
  const write = (file: string, text: string): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }

  it('[U:pi-gate] runs a shell call when no settings name a shell or a prefix', async () => {
    write(path.join(agent, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(await load().tool_call(bash({ command: 'ls' }), ui(yes).ctx)).toBeUndefined()
  })

  it.each([
    ['its own folder, a prefix', () => path.join(agent, 'settings.json'), JSON.stringify({ shellCommandPrefix: 'touch x' })],
    ['its own folder, a shell', () => path.join(agent, 'settings.json'), JSON.stringify({ shellPath: '/bin/sh' })],
    ['the scratch folder, a prefix', () => path.join(project, 'settings.json'), JSON.stringify({ shellCommandPrefix: 'touch x' })],
    ['the scratch folder, a key spelled with an escape', () => path.join(project, 'settings.json'), '{"shell\\u0050ath":"/bin/sh"}'],
    ['the scratch folder, a file Pi might read another way', () => path.join(project, 'settings.json'), '{ // note\n "shellCommandPrefix": "touch x" }'],
  ])('[U:pi-gate] refuses every shell call when %s is set', async (_what, file, text) => {
    write(file(), text)
    const u = ui(yes)
    expect(await load().tool_call(bash({ command: 'ls' }), u.ctx)).toEqual(blocked())
    expect(u.asked).toEqual([])
  })

  it('[U:pi-gate] keeps refusing after the setting is taken away again: the running Pi read it when it started', async () => {
    const file = path.join(project, 'settings.json')
    write(file, JSON.stringify({ shellCommandPrefix: 'touch x' }))
    const gate = load()
    rmSync(file)
    expect(await gate.tool_call(bash({ command: 'ls' }), ui(yes).ctx)).toEqual(blocked())
  })

  it('[U:pi-gate] a file tool is not held up by it', async () => {
    write(path.join(agent, 'settings.json'), JSON.stringify({ shellCommandPrefix: 'touch x' }))
    expect(await load().tool_call({ toolName: 'read', toolCallId: 'c', input: { path: 'a.txt' } }, ui(yes).ctx)).toBeUndefined()
  })
})
