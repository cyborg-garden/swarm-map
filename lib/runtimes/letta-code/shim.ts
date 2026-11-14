// The Letta Code shim: the only Letta Code-specific code that runs. It dials
// the sidecar, and for each session keeps one headless Letta Code process.
// It translates turns into messages and Letta Code's records back into
// `reply` and `settled`. It decides nothing, holds no chat token, and gives
// Letta Code no real key.
//
// How the pieces map:
// - One Letta Code agent for the whole shim, made by the first session that
//   starts. Each session is one conversation of that agent. The agent's
//   memory is one folder, read into every conversation, so the door gives
//   this harness one conversation (rule `mem.one-scope`).
// - Letta Code's tools are fixed by `--tools` when its process starts. The
//   sidecar sends a tool list with every turn. When it changes, the shim
//   stops that session's process and starts it again on the same
//   conversation. (`toolChange: 'restart'`.)
// - Letta Code is always started in strict permission mode, where it asks
//   before every tool. There is no option here to start it any other way.
//   A tool the turn was never offered is refused here, without asking.
// - It is sent no turn unless it is the pinned version: what "strict" means
//   is that version's behaviour, and nothing else was run.
// - Its chat channels belong to its server mode. This shim only ever starts
//   the headless mode, so they are never started.
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Capabilities, Envelope } from '../../door/protocol.ts'
import { connectShim, type ShimClient } from '../../door/shim-client.ts'
// Letta Code has no sender field either: who is speaking goes into the prompt, framed the same way.
import { renderPrompt } from '../pi/preamble.ts'
import { LETTA_CODE_CAPS, LETTA_CODE_VERSION_LINE } from './caps.ts'
import { createLettaCodeWire, type LettaCodeProcess, type LettaCodeWire } from './wire.ts'

export interface LettaCodeShimOptions {
  host: string
  port: number
  /** Per-cell token for the sidecar. Never passed on to Letta Code. */
  token: string
  /** How to start Letta Code, e.g. ['/usr/local/bin/letta']. Flags are appended. */
  command: string[]
  /** Letta Code's home. Its agent, its conversations, its memory and its provider file all live under it. */
  homeDir: string
  workDir: string
  model?: string
  verdictTimeoutMs?: number
  /** How long a tool call waits in the cell for its answer before the answer is no. */
  vetoTimeoutMs?: number
  /** How long a fresh Letta Code has to say it has started before its turn is refused. */
  startMs?: number
  /**
   * Rig-only: extra env for Letta Code. The lab uses it to arm a tripwire inside it, and
   * the broken-shim suite to plant a leak. It cannot change the offline flags below.
   */
  rigEnv?: Record<string, string>
  /** Rig-only: what a shim that is broken on purpose says about itself in its hello. */
  rigCaps?: Partial<Capabilities>
}

export interface LettaCodeShim { close(): void }

export function lettaCodeArgs(o: { tools: string[]; model: string; agentId?: string; conversationId?: string }): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--backend', 'local',
    // A conversation names its agent, and Letta Code refuses to be told both.
    ...(o.conversationId !== undefined ? ['--conversation', o.conversationId]
      : o.agentId !== undefined ? ['--agent', o.agentId, '--new'] : ['--new-agent']),
    '--model', `openai-compatible/${o.model}`,
    '--permission-mode', 'strict',
    '--toolset', 'default',
    '--tools', o.tools.join(','),
    '--reflection-trigger', 'off',
    '--no-system-info-reminder', '--no-skills', '--no-bundled-skills', '--no-mods',
  ]
}

/**
 * Letta Code's whole environment, listed by hand. Nothing is inherited from the shim's own
 * env. The last three lines are the only thing that keeps a real Letta Code from the network
 * at start-up (the update check and telemetry), so they come last and win.
 */
export function lettaCodeEnv(o: Pick<LettaCodeShimOptions, 'homeDir' | 'rigEnv'>): Record<string, string> {
  return {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: o.homeDir,
    ...o.rigEnv,
    DISABLE_AUTOUPDATER: '1',
    LETTA_CODE_TELEM: '0',
    DO_NOT_TRACK: '1',
  }
}

/** Where Letta Code's local backend looks for its model providers. */
export function lettaCodeProviderFile(homeDir: string): string {
  return path.join(homeDir, '.letta', 'lc-local-backend', 'providers', 'auth.json')
}

/**
 * Point Letta Code at the sidecar's model route. It gets the route's address and a
 * placeholder where a key would go, in the one file its local backend reads them from.
 * It asks that address which models exist before its first call, and the route answers.
 */
export function writeLettaCodeProvider(homeDir: string, o: { baseUrl: string; placeholder: string }): void {
  const file = lettaCodeProviderFile(homeDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const at = new Date(0).toISOString()
  writeFileSync(file, JSON.stringify({
    version: 1,
    providers: {
      'openai-compatible': {
        id: 'local-provider-openai-compatible', name: 'openai-compatible', provider_type: 'openai-compatible', provider_category: 'byok',
        auth: { type: 'api', key: o.placeholder }, base_url: o.baseUrl, created_at: at, updated_at: at,
      },
    },
  }))
}

/** One running Letta Code, and the tool list it was started with. */
interface Live { wire: LettaCodeWire; tools: string; offered: Set<string>; turnId?: string }
/** One session: its turns run one at a time, on whichever process is live for it. */
interface Slot { queue: Promise<void>; live?: Live; conversationId?: string }

const toolsKey = (tools: string[]): string => [...new Set(tools)].sort().join(',')

export async function startLettaCodeShim(opts: LettaCodeShimOptions): Promise<LettaCodeShim> {
  const client: ShimClient = await connectShim({
    host: opts.host, port: opts.port, token: opts.token, caps: { ...LETTA_CODE_CAPS, ...opts.rigCaps }, verdictTimeoutMs: opts.verdictTimeoutMs,
  })
  const slots = new Map<string, Slot>()
  const env = lettaCodeEnv(opts) as NodeJS.ProcessEnv
  const [bin, ...prefix] = opts.command

  // Asked once. Anything but the pinned version's own line, an error included, is a no.
  let pinned: Promise<boolean> | undefined
  const isPinned = (): Promise<boolean> => pinned ??= new Promise((resolve) => {
    execFile(bin, [...prefix, '--version'], { env, cwd: opts.workDir, timeout: opts.startMs ?? 30_000 },
      (err, stdout) => resolve(!err && stdout.trim() === LETTA_CODE_VERSION_LINE))
  })

  // The one agent, made by the first process that starts. Later ones wait for its id.
  let agent: Promise<string> | undefined

  const open = async (slot: Slot, turn: Envelope): Promise<Live> => {
    if (!(await isPinned())) throw new Error('this is not the pinned Letta Code version, so it is sent no turn')
    const agentId = agent ? await agent : undefined
    const tools = toolsKey(turn.tools)
    const offered = new Set(tools === '' ? [] : tools.split(','))
    const args = lettaCodeArgs({ tools: [...offered], model: opts.model ?? 'scripted', agentId, conversationId: slot.conversationId })
    const child = spawn(bin, [...prefix, ...args], { cwd: opts.workDir, env, stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdin.on('error', () => {})
    const proc: LettaCodeProcess = {
      stdin: child.stdin, stdout: child.stdout,
      onExit: (cb) => { child.on('exit', cb); child.on('error', () => cb(null)) },
      kill: () => { child.kill() },
    }
    const live: Live = {
      tools, offered,
      wire: createLettaCodeWire(proc, {
        vetoTimeoutMs: opts.vetoTimeoutMs, startMs: opts.startMs,
        // Letta Code asks; the sidecar answers. No live turn means no. So does a tool this
        // turn was never offered: Letta Code asks about those too, and nobody need be told.
        onGate: async (call) => {
          if (!live.turnId || !live.offered.has(call.tool)) return false
          return (await client.requestTool(live.turnId, call.tool, call.input)).allow
        },
      }),
    }
    child.on('exit', () => { if (slot.live === live) slot.live = undefined })
    const started = live.wire.started()
    if (!agent) {
      const made = started.then((s) => s.agentId)
      agent = made
      made.catch(() => { if (agent === made) agent = undefined }) // the next session tries again
    }
    try {
      slot.conversationId = (await started).conversationId
    } catch (err) {
      live.wire.close()
      throw err
    }
    return live
  }

  const runTurn = async (slot: Slot, turn: Envelope): Promise<void> => {
    let live: Live | undefined
    try {
      // The tool list is per turn. Letta Code's is per process, so a changed list means a new process.
      if (slot.live && slot.live.tools !== toolsKey(turn.tools)) {
        slot.live.wire.close()
        slot.live = undefined
      }
      live = slot.live ?? (slot.live = await open(slot, turn))
      live.turnId = turn.turnId
      const result = await live.wire.prompt(renderPrompt(turn))
      if (!result.aborted && result.text !== '') {
        client.send({ t: 'reply', turnId: turn.turnId, text: result.text, attachments: [] })
      }
      client.send({ t: 'settled', turnId: turn.turnId })
    } catch (err) {
      client.send({ t: 'error', turnId: turn.turnId, message: (err as Error).message })
      live?.wire.close()
      if (slot.live === live) slot.live = undefined
    } finally {
      if (live) live.turnId = undefined
    }
  }

  const closeAll = (): void => {
    for (const slot of slots.values()) slot.live?.wire.close()
    slots.clear()
  }

  client.onMessage((msg) => {
    if (msg.t === 'turn') {
      let slot = slots.get(msg.env.sessionKey)
      if (!slot) slots.set(msg.env.sessionKey, slot = { queue: Promise.resolve() })
      const s = slot
      s.queue = s.queue.then(() => runTurn(s, msg.env))
    } else if (msg.t === 'reset') {
      // A new conversation of the same agent. What the agent has in memory is not reset.
      slots.get(msg.sessionKey)?.live?.wire.close()
      slots.delete(msg.sessionKey)
    } else if (msg.t === 'shutdown') {
      closeAll()
    }
  })

  return {
    close() {
      closeAll()
      client.close()
    },
  }
}
