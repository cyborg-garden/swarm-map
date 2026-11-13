import { NextResponse } from 'next/server'
import type { Harness } from '@/lib/types'
import { Storage } from './storage'
import { DATA_DIR } from './data-dir'
import { findUnmanagedRow, unmanagedRowNote } from './runtime-adapter'

/**
 * The first line of every route that changes one agent.
 *
 * A stored row with a retired or unknown runtime is not a Hermes agent, but
 * its id still maps to a Hermes path: `h_foo` becomes `~/.hermes-foo` and
 * `hermes-foo`. Many routes derive that path from the URL without ever
 * looking the agent up, so HarnessService hiding the row does not stop them.
 * This does: it answers 409 before the route reads its body.
 *
 * It reads harnesses.json and nothing else (no Docker call), so it is cheap
 * enough for the routes agents call. The only write that works on such a row
 * is DELETE /api/harnesses/:id, which forgets it.
 *
 * Returns the response to send, or null when the id is fine to act on.
 * app/api/harnesses/__tests__/retired-row-routes.test.ts calls every mutating
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
  const rows = new Storage(DATA_DIR).read<Partial<Harness>[]>('harnesses.json', [])
  return findUnmanagedRow(Array.isArray(rows) ? rows : [], idOrSlug)
}
