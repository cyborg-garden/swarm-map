import { NextResponse } from 'next/server'
import { storedHarnessRows } from './agent-home'
import { findUnmanagedRow, unmanagedRowNote } from './runtime-adapter'

/**
 * The first line of every per-agent route, reads and writes alike.
 *
 * A stored row with a retired or unknown runtime is not a Hermes agent, but
 * its id still maps to a Hermes path: `h_foo` becomes `~/.hermes-foo` and
 * `hermes-foo`. Many routes derive that path from the URL without ever
 * looking the agent up, so HarnessService hiding the row does not stop them.
 * This does: it answers 409 before the route reads its body.
 *
 * It reads harnesses.json and nothing else (no Docker call), so it is cheap
 * enough for the routes agents call. Two kinds of route do not call it:
 * DELETE /api/harnesses/:id, which forgets the row, and the four GETs a
 * running agent makes about itself (see agentHomeForSelfRead).
 *
 * This is the route-level half. The other half is agentHome() in
 * ./agent-home, which the code below the routes uses to turn an id into a
 * directory and which throws for the same rows.
 *
 * Returns the response to send, or null when the id is fine to act on.
 * app/api/harnesses/__tests__/retired-row-routes.test.ts calls every
 * per-agent route and fails if one of them skips this.
 */
export function refuseUnmanagedRow(idOrSlug: string): NextResponse | null {
  const found = storedUnmanagedRow(idOrSlug)
  if (!found) return null
  return NextResponse.json(
    {
      error: `${unmanagedRowNote(found)} Nothing can be changed through it. Forget the row to free the name.`,
      reason: found.reason,
      runtime: found.runtime,
    },
    { status: 409 },
  )
}

/** The row harnesses.json holds for this id or agent name, if Swarm Map does not manage it. */
export function storedUnmanagedRow(idOrSlug: string) {
  return findUnmanagedRow(storedHarnessRows(), idOrSlug)
}
