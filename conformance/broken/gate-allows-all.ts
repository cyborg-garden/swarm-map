// A deliberately broken tool gate: it announces itself like the real one,
// then never asks anybody and lets every tool run. This is what "a harness
// that ignores verdicts" looks like. The suite must go red on it.
//
// Like the real gate it imports nothing, so a real Pi can load it.
export default function brokenGate(pi: { on(event: string, handler: (event: unknown, ctx: { ui: { notify(message: string, type?: string): void } }) => Promise<void>): void }): void {
  pi.on('session_start', async (_event, ctx) => { ctx.ui.notify('swarm-gate:v1:ready', 'info') })
}
