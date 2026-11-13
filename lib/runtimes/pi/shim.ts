// The Pi shim: the only Pi-specific code that runs. It dials the sidecar,
// and for each session keeps one `pi --mode rpc` process. It translates
// turns into prompts and Pi's events back into `reply` and `settled`. It
// decides nothing, holds no chat token, and gives Pi no real key.
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
  /** The gate extension. 'NONE-FOR-TESTS' starts Pi with no gate, to test the wall behind it. */
  gate: { path: string } | 'NONE-FOR-TESTS'
  model?: string
  verdictTimeoutMs?: number
  gateTimeoutMs?: number
  /** Test-only: extra env for Pi. The broken-shim suite uses it to plant a leak. */
  unsafeExtraEnv?: Record<string, string>
}

export interface PiShim { close(): void }

export function piArgs(o: { sessionDir: string; tools: string[]; gate: PiShimOptions['gate']; model: string }): string[] {
  return [
    '--mode', 'rpc',
    '--session-dir', o.sessionDir,
    '--provider', 'swarm', '--model', o.model,
    ...(o.tools.length > 0 ? ['--tools', o.tools.join(',')] : ['--no-builtin-tools']),
    '--no-context-files', '--no-skills', '--no-mcp', '--no-extensions', '--no-prompt-templates',
    ...(o.gate === 'NONE-FOR-TESTS' ? [] : ['-e', o.gate.path]),
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

interface Session { rpc: PiRpc; turnId?: string; queue: Promise<void> }

export async function startPiShim(opts: PiShimOptions): Promise<PiShim> {
  const client: ShimClient = await connectShim({
    host: opts.host, port: opts.port, token: opts.token, caps: PI_CAPS, verdictTimeoutMs: opts.verdictTimeoutMs,
  })
  const sessions = new Map<string, Session>()

  const open = (env: Envelope): Session => {
    const sessionDir = path.join(opts.sessionsDir, createHash('sha256').update(env.sessionKey).digest('hex').slice(0, 16))
    mkdirSync(sessionDir, { recursive: true })
    const args = piArgs({ sessionDir, tools: env.tools, gate: opts.gate, model: opts.model ?? 'scripted' })
    const child = spawn(opts.piCommand[0], [...opts.piCommand.slice(1), ...args], {
      cwd: opts.workDir, env: piEnv(opts) as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'],
    })
    child.stdin.on('error', () => {})
    const proc: PiProcess = {
      stdin: child.stdin, stdout: child.stdout,
      onExit: (cb) => { child.on('exit', cb); child.on('error', () => cb(null)) },
      kill: () => { child.kill() },
    }
    const session: Session = {
      queue: Promise.resolve(),
      rpc: createPiRpc(proc, {
        // Pi asks through the gate; the sidecar answers. No live turn means no.
        onGate: async (call) => {
          if (!session.turnId) return false
          return (await client.requestTool(session.turnId, call.tool, call.input)).allow
        },
      }),
    }
    child.on('exit', () => { if (sessions.get(env.sessionKey) === session) sessions.delete(env.sessionKey) })
    sessions.set(env.sessionKey, session)
    return session
  }

  const runTurn = async (session: Session, env: Envelope): Promise<void> => {
    session.turnId = env.turnId
    try {
      const result = await session.rpc.prompt(renderPrompt(env))
      if (!result.aborted && result.text !== '') {
        client.send({ t: 'reply', turnId: env.turnId, text: result.text, attachments: [] })
      }
      client.send({ t: 'settled', turnId: env.turnId })
    } catch (err) {
      client.send({ t: 'error', turnId: env.turnId, message: (err as Error).message })
      session.rpc.close()
      sessions.delete(env.sessionKey)
    } finally {
      session.turnId = undefined
    }
  }

  client.onMessage((msg) => {
    if (msg.t === 'turn') {
      const session = sessions.get(msg.env.sessionKey) ?? open(msg.env)
      session.queue = session.queue.then(() => runTurn(session, msg.env))
    } else if (msg.t === 'reset') {
      sessions.get(msg.sessionKey)?.rpc.close()
      sessions.delete(msg.sessionKey)
    } else if (msg.t === 'shutdown') {
      for (const s of sessions.values()) s.rpc.close()
      sessions.clear()
    }
  })

  return {
    close() {
      for (const s of sessions.values()) s.rpc.close()
      sessions.clear()
      client.close()
    },
  }
}
