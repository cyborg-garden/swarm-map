// A shim for any agent that speaks the Agent Client Protocol over stdio. It
// dials the sidecar, and for each session keeps one agent process, which it
// drives as the ACP client (client.ts). It decides nothing: every permission
// request goes to the door as a `tool_request`, and the door's answer is
// passed back as a once-option.
//
// - The door's yes carries the hash of the call it decided on. The shim works
//   out the hash of the call it asked about and lets it run only if the two
//   are the same. A yes for anything else is a no.
// - A call the turn was never offered is refused here, without asking.
// - An agent that ran something it was not given a yes for (client.ts) has
//   its turn reported to the door as an error, and its process is stopped.
//   The next turn starts a new session.
// - An agent fixes its tools when its process starts (the adapter writes them
//   into its config), so a changed tool list restarts that session's process
//   and opens the same session again (`session/load`).
//
// The adapter for one agent says how to start it for a tool list, which ACP
// tool kinds it maps to which of its tool names, and which name and version it
// must report.
import { spawn } from 'node:child_process'
import { callHash } from '../../core/tools/call.ts'
import type { Capabilities, Envelope } from '../../door/protocol.ts'
import { connectShim, type ShimClient } from '../../door/shim-client.ts'
import { renderPrompt } from '../pi/preamble.ts'
import { createAcpClient, type AcpClient } from './client.ts'
import type { AcpToolKind } from './permission.ts'

export interface AcpLaunch { command: string[]; env: Record<string, string> }

export interface AcpShimOptions {
  host: string
  port: number
  /** Per-cell token for the sidecar. Never passed on to the agent. */
  token: string
  caps: Capabilities
  workDir: string
  /** How to start the agent for this tool list: its command and its whole environment. */
  launch: (tools: string[]) => AcpLaunch
  kinds: Partial<Record<AcpToolKind, string>>
  expect: { name: string; version: string }
  verdictTimeoutMs?: number
  /** How long a permission request waits in the cell for its answer before the answer is no. */
  vetoTimeoutMs?: number
  /** How long a fresh agent has to start and open its session. */
  startMs?: number
  /** Told of each breach, for tests and the cell's log. */
  onBreach?: (why: string) => void
}

export interface AcpShim { close(): void }

interface Live { client: AcpClient; tools: string; offered: Set<string>; turnId?: string; breach?: string }
interface Slot { queue: Promise<void>; live?: Live; sessionId?: string }

const toolsKey = (tools: string[]): string => [...new Set(tools)].sort().join(',')

export async function startAcpShim(opts: AcpShimOptions): Promise<AcpShim> {
  const link: ShimClient = await connectShim({
    host: opts.host, port: opts.port, token: opts.token, caps: opts.caps, verdictTimeoutMs: opts.verdictTimeoutMs,
  })
  const slots = new Map<string, Slot>()

  const open = async (slot: Slot, turn: Envelope): Promise<Live> => {
    const tools = toolsKey(turn.tools)
    const offered = new Set(tools === '' ? [] : tools.split(','))
    const { command, env } = opts.launch([...offered])
    const [bin, ...args] = command
    const child = spawn(bin, args, { cwd: opts.workDir, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] })
    const live: Live = { tools, offered } as Live
    live.client = createAcpClient({
      stdin: child.stdin, stdout: child.stdout,
      onExit: (cb) => { child.on('exit', cb); child.on('error', () => cb(null)) },
      kill: () => { child.kill() },
    }, {
      workDir: opts.workDir, kinds: opts.kinds, expect: opts.expect, vetoTimeoutMs: opts.vetoTimeoutMs, startMs: opts.startMs,
      // The agent asks; the door answers. No live turn is a no, and so is a tool this turn was never offered.
      gate: async (call) => {
        const turnId = live.turnId
        if (!turnId || !live.offered.has(call.tool)) return false
        const answer = await link.requestTool(turnId, call.tool, call.input)
        // The yes must be for this call: the one the door was shown, by its hash.
        return answer.allow && answer.hash === callHash(call.tool, call.input)
      },
      onBreach: (why) => {
        live.breach = why
        opts.onBreach?.(why)
        // Caught between turns: there is no turn to fail, so the process and its session are dropped here.
        if (!live.turnId) {
          live.client.close()
          if (slot.live === live) slot.live = undefined
          slot.sessionId = undefined
        }
      },
    })
    child.on('exit', () => { if (slot.live === live) slot.live = undefined })
    try {
      slot.sessionId = await live.client.open(slot.sessionId)
    } catch (err) {
      live.client.close()
      throw err
    }
    return live
  }

  const runTurn = async (slot: Slot, turn: Envelope): Promise<void> => {
    let live: Live | undefined
    try {
      // The tool list is per turn. The agent's is per process, so a changed list means a new process on the same session.
      if (slot.live && slot.live.tools !== toolsKey(turn.tools)) {
        slot.live.client.close()
        slot.live = undefined
      }
      live = slot.live ?? (slot.live = await open(slot, turn))
      live.turnId = turn.turnId
      const result = await live.client.prompt(renderPrompt(turn))
      if (result.stopReason !== 'cancelled' && result.text !== '') {
        link.send({ t: 'reply', turnId: turn.turnId, text: result.text, attachments: [] })
      }
      link.send({ t: 'settled', turnId: turn.turnId })
    } catch (err) {
      link.send({ t: 'error', turnId: turn.turnId, message: (err as Error).message })
      live?.client.close()
      if (slot.live === live) slot.live = undefined
      // An agent that acted on a no is not picked back up: what it did is in that session.
      if (live?.breach) slot.sessionId = undefined
    } finally {
      if (live) live.turnId = undefined
    }
  }

  const closeAll = (): void => {
    for (const slot of slots.values()) slot.live?.client.close()
    slots.clear()
  }

  link.onMessage((msg) => {
    if (msg.t === 'turn') {
      let slot = slots.get(msg.env.sessionKey)
      if (!slot) slots.set(msg.env.sessionKey, slot = { queue: Promise.resolve() })
      const s = slot
      s.queue = s.queue.then(() => runTurn(s, msg.env))
    } else if (msg.t === 'cancel') {
      for (const slot of slots.values()) if (slot.live?.turnId === msg.turnId) slot.live.client.cancel()
    } else if (msg.t === 'reset') {
      slots.get(msg.sessionKey)?.live?.client.close()
      slots.delete(msg.sessionKey)
    } else if (msg.t === 'shutdown') {
      closeAll()
    }
  })

  return {
    close() {
      closeAll()
      link.close()
    },
  }
}
