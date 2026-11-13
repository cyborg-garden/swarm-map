// The in-cell tool gate: a Pi extension. Before any tool runs it asks the
// sidecar, through Pi's extension UI channel, and blocks unless the answer is
// exactly `allow`. A timeout, a cancel, a missing channel or any error blocks.
//
// When the session starts it says so on the same channel (GATE_READY). The
// shim sends Pi no turn until it has seen that, so a Pi that came up without
// this file loaded never gets a prompt, and so never calls a tool ungated.
//
// This is a guardrail, not a wall. It runs inside the cell, where the model
// has a shell. It stops mistakes; the cell's network and the absence of real
// keys are what stop an attack. Keep it mounted read-only.
//
// It imports nothing, so it loads in a cell that has only Pi installed. The
// few Pi types it needs are declared here by hand, from Pi 1.5.2.

interface PiToolCallEvent { toolName: string; toolCallId: string; input: unknown }
interface PiContext {
  hasUI: boolean
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
}
interface PiBlock { block: true; reason: string }
interface PiApi {
  on(event: 'session_start', handler: (event: unknown, ctx: PiContext) => Promise<void>): void
  on(event: 'tool_call', handler: (event: PiToolCallEvent, ctx: PiContext) => Promise<PiBlock | undefined>): void
}

// The same two strings as in ../rpc.ts. They are repeated because this file may import nothing.
const GATE_PREFIX = 'swarm-gate:v1:'
const GATE_READY = 'swarm-gate:v1:ready'

export default function swarmGate(pi: PiApi): void {
  pi.on('session_start', async (_event, ctx) => {
    // If this cannot be said, the shim never sends a turn. That is the safe side.
    ctx.ui.notify(GATE_READY, 'info')
  })
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (!ctx.hasUI) return { block: true, reason: 'swarm gate: no channel to the sidecar' }
      const timeout = Number(process.env.SWARM_GATE_TIMEOUT_MS) > 0 ? Number(process.env.SWARM_GATE_TIMEOUT_MS) : 30_000
      const ask = GATE_PREFIX + JSON.stringify({ tool: event.toolName, input: event.input, callId: event.toolCallId })
      const answer = await ctx.ui.select(ask, ['allow', 'deny'], { timeout })
      if (answer === 'allow') return undefined
      return { block: true, reason: 'swarm gate: not allowed' }
    } catch {
      return { block: true, reason: 'swarm gate: could not get a verdict' }
    }
  })
}
