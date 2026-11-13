import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isValidHarnessId } from '@/lib/services/surface-admins'
import type { Harness } from '@/lib/types'

/**
 * The one step every API route that takes an agent id goes through.
 *
 * An id arrives from a URL segment or a request body. Before a route does
 * anything with it, the id is checked for shape (isValidHarnessId: letters,
 * digits, '_' and '-') and, on any route that changes something, resolved to
 * the one agent the app lists under exactly that id (HarnessService.get).
 * A malformed id is a 400; an id that names no agent is a 404. Routes then
 * work from the resolved harness, not from the raw string.
 *
 * app/api/harness-id-sweep.test.ts walks every route file and fails if one
 * that takes an agent id skips this.
 */

/** 400 response when `id` is not a well-formed harness id, else undefined. */
export function invalidHarnessId(id: unknown): NextResponse | undefined {
  if (isValidHarnessId(id)) return undefined
  return NextResponse.json({ error: 'Invalid harness id' }, { status: 400 })
}

type Resolved =
  | { harness: Harness; refusal?: undefined }
  | { harness?: undefined; refusal: NextResponse }

/**
 * The same step for a list of agent ids from a request body (a key's
 * `assignedTo`). Every entry must be well-formed (400) and name a listed
 * agent (404). `known` are ids already stored on the record being edited:
 * they are kept as they are, so an edit that leaves an old assignment in
 * place is not refused for it. Returns the refusal, or undefined when the
 * whole list is fine.
 */
export function refuseUnknownHarnesses(ids: unknown, known: readonly string[] = []): NextResponse | undefined {
  if (ids === undefined || ids === null) return undefined
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: 'assignedTo must be an array of harness ids' }, { status: 400 })
  }
  for (const id of ids) {
    const invalid = invalidHarnessId(id)
    if (invalid) return invalid
  }
  for (const id of ids as string[]) {
    if (known.includes(id)) continue
    if (!services.harness.get(id)) {
      return NextResponse.json({ error: `Harness not found: ${id}` }, { status: 404 })
    }
  }
  return undefined
}

/** Resolve `id` to the one listed agent, or to the response that refuses it. */
export function requireHarness(id: unknown): Resolved {
  const invalid = invalidHarnessId(id)
  if (invalid) return { refusal: invalid }
  const harness = services.harness.get(id as string)
  if (!harness) return { refusal: NextResponse.json({ error: 'Harness not found' }, { status: 404 }) }
  return { harness }
}
