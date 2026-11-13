// The Pi shim: the only Pi-specific code that runs. It dials the sidecar,
// and for each session keeps one `pi --mode rpc` process. It translates
// turns into prompts and Pi's events back into `reply` and `settled`. It
// decides nothing, holds no chat token, and gives Pi no real key.
//
// Two things Pi cannot do, and what the shim does about each:
// - Pi's tools are fixed by `--tools` when its process starts. The sidecar
//   sends a tool list with every turn, and it can change. When it does, the
//   shim stops that session's Pi and starts it again with the new list, and
//   `--continue` so the conversation carries on. (`toolChange: 'restart'`.)
// - Pi must never run without the gate. There is no switch to start it
//   without one, and no turn is sent until the gate has announced itself.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Envelope } from '../../door/protocol.ts'
import { connectShim, type ShimClient } from '../../door/shim-client.ts'
import { PI_CAPS } from './caps.ts'
import { renderPrompt } from './preamble.ts'
import { createPiRpc, type PiProcess, type PiRpc } from './rpc.ts'

export interface PiShimOptions {
  host: string
  port: number
  /** Per-cell token for the sidecar. Never passed on to Pi. */
  token: string
  /** How to start Pi, e.g. ['/usr/local/bin/pi']. Flags are appended. */
  piCommand: string[]
  /** Pi's config dir. Holds models.json, which points at the sidecar with a placeholder key. */
  agentDir: string
  sessionsDir: string
  workDir: string
  homeDir: string
  /** The gate extension Pi loads. Always required: Pi is never started without one. */
  gate: { path: string }
  model?: string
  verdictTimeoutMs?: number
  gateTimeoutMs?: number
  /** How long a fresh Pi has for its gate to announce itself before its turn is refused. */
  gateReadyMs?: number
  /** Test-only: extra env for Pi. The broken-shim suite uses it to plant a leak. */
  unsafeExtraEnv?: Record<string, string>
}

export interface PiShim { close(): void }

export function piArgs(o: { sessionDir: string; tools: string[]; gate: { path: string }; model: string; resume?: boolean }): string[] {
  return [
    '--mode', 'rpc',
    '--session-dir', o.sessionDir,
    ...(o.resume ? ['--continue'] : []),
    '--provider', 'swarm', '--model', o.model,
    ...(o.tools.length > 0 ? ['--tools', o.tools.join(',')] : ['--no-builtin-tools']),
    '--no-context-files', '--no-skills', '--no-mcp', '--no-extensions', '--no-prompt-templates',
    '-e', o.gate.path,
  ]
}

/** Pi's whole environment, listed by hand. Nothing is inherited from the shim's own env. */
export function piEnv(o: Pick<PiShimOptions, 'agentDir' | 'homeDir' | 'gateTimeoutMs' | 'unsafeExtraEnv'>): Record<string, string> {
  return {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: o.homeDir,
    PI_CODING_AGENT_DIR: o.agentDir,
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    SWARM_GATE_TIMEOUT_MS: String(o.gateTimeoutMs ?? 30_000),
    ...o.unsafeExtraEnv,
  }
}

/** One running Pi, and the tool list it was started with. */
interface Live { rpc: PiRpc; tools: string; turnId?: string }
/** One session: its turns run one at a time, on whichever Pi is live for it. */
interface Slot { queue: Promise<void>; live?: Live }

const toolsKey = (tools: string[]): string => [...new Set(tools)].sort().join(',')

export async function startPiShim(opts: PiShimOptions): Promise<PiShim> {
  const client: ShimClient = await connectShim({
    host: opts.host, port: opts.port, token: opts.token, caps: PI_CAPS, verdictTimeoutMs: opts.verdictTimeoutMs,
  })
  const slots = new Map<string, Slot>()

  const open = (slot: Slot, env: Envelope, resume: boolean): Live => {
    const sessionDir = path.join(opts.sessionsDir, createHash('sha256').update(env.sessionKey).digest('hex').slice(0, 16))
    mkdirSync(sessionDir, { recursive: true })
    const tools = toolsKey(env.tools)
    const args = piArgs({ sessionDir, tools: tools === '' ? [] : tools.split(','), gate: opts.gate, model: opts.model ?? 'scripted', resume })
    const child = spawn(opts.piCommand[0], [...opts.piCommand.slice(1), ...args], {
      cwd: opts.workDir, env: piEnv(opts) as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.stdin.on('error', () => {})
    const proc: PiProcess = {
      stdin: child.stdin, stdout: child.stdout,
      onExit: (cb) => { child.on('exit', cb); child.on('error', () => cb(null)) },
      kill: () => { child.kill() },
    }
    const live: Live = {
      tools,
      rpc: createPiRpc(proc, {
        gateReadyMs: opts.gateReadyMs,
        // Pi asks through the gate; the sidecar answers. No live turn means no.
        onGate: async (call) => {
          if (!live.turnId) return false
          return (await client.requestTool(live.turnId, call.tool, call.input)).allow
        },
      }),
    }
    child.on('exit', () => { if (slot.live === live) slot.live = undefined })
    return live
  }

  const runTurn = async (slot: Slot, env: Envelope): Promise<void> => {
    // The tool list is per turn. Pi's is per process, so a changed list means a new process.
    let resume = false
    if (slot.live && slot.live.tools !== toolsKey(env.tools)) {
      slot.live.rpc.close()
      slot.live = undefined
      resume = true
    }
    const live = slot.live ?? (slot.live = open(slot, env, resume))
    live.turnId = env.turnId
    try {
      const result = await live.rpc.prompt(renderPrompt(env))
      if (!result.aborted && result.text !== '') {
        client.send({ t: 'reply', turnId: env.turnId, text: result.text, attachments: [] })
      }
      client.send({ t: 'settled', turnId: env.turnId })
    } catch (err) {
      client.send({ t: 'error', turnId: env.turnId, message: (err as Error).message })
      live.rpc.close()
      if (slot.live === live) slot.live = undefined
    } finally {
      live.turnId = undefined
    }
  }

  const closeAll = (): void => {
    for (const slot of slots.values()) slot.live?.rpc.close()
    slots.clear()
  }

  client.onMessage((msg) => {
    if (msg.t === 'turn') {
      let slot = slots.get(msg.env.sessionKey)
      if (!slot) slots.set(msg.env.sessionKey, slot = { queue: Promise.resolve() })
      const s = slot
      s.queue = s.queue.then(() => runTurn(s, msg.env))
    } else if (msg.t === 'reset') {
      slots.get(msg.sessionKey)?.live?.rpc.close()
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
