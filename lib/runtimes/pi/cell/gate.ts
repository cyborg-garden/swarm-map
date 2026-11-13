// The in-cell tool gate: a Pi extension. Before any tool runs it asks the
// sidecar, through Pi's extension UI channel, and blocks unless the answer is
// exactly `allow`. A timeout, a cancel, a missing channel or any error blocks.
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
  ui: { select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> }
}
interface PiBlock { block: true; reason: string }
interface PiApi {
  on(event: 'tool_call', handler: (event: PiToolCallEvent, ctx: PiContext) => Promise<PiBlock | undefined>): void
}

const GATE_PREFIX = 'swarm-gate:v1:'

export default function swarmGate(pi: PiApi): void {
  const timeout = Number(process.env.SWARM_GATE_TIMEOUT_MS) > 0 ? Number(process.env.SWARM_GATE_TIMEOUT_MS) : 30_000
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (!ctx.hasUI) return { block: true, reason: 'swarm gate: no channel to the sidecar' }
      const ask = GATE_PREFIX + JSON.stringify({ tool: event.toolName, input: event.input, callId: event.toolCallId })
      const answer = await ctx.ui.select(ask, ['allow', 'deny'], { timeout })
      if (answer === 'allow') return undefined
      return { block: true, reason: 'swarm gate: not allowed' }
    } catch {
      return { block: true, reason: 'swarm gate: could not get a verdict' }
    }
  })
}
