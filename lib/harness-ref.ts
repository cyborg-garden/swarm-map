import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isValidHarnessId } from '@/lib/services/surface-admins'
import { Storage } from '@/lib/services/storage'
import { DATA_DIR } from '@/lib/services/data-dir'
import { unmanagedRowNote, unsupportedRowReason } from '@/lib/services/runtime-adapter'
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
 * A stored row whose `runtime` tag Swarm Map does not know is read-only. The
 * resolving step answers 409 for the id of such a row (matched exactly, as
 * stored), before the agent lookup, for ids from a URL and from a body alike.
 * Only the tag decides: a row with no tag is Hermes. The one request let
 * through is the one that forgets the row (requireHarnessToRemove). The
 * lookup reads harnesses.json and nothing else.
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
    const unmanaged = unmanagedRow(id)
    if (unmanaged) return unmanagedRowRefusal(unmanaged)
    if (!services.harness.get(id)) {
      return NextResponse.json({ error: `Harness not found: ${id}` }, { status: 404 })
    }
  }
  return undefined
}

type Unmanaged = { reason: 'retired' | 'unknown'; runtime: string }

/** The stored row with exactly this id, if its runtime tag has no adapter. */
function unmanagedRow(id: string): Unmanaged | undefined {
  const rows = new Storage(DATA_DIR).read<Array<{ id?: string; runtime?: string | null }>>('harnesses.json', [])
  if (!Array.isArray(rows)) return undefined
  return unsupportedRowReason(rows.find((r) => r?.id === id)) ?? undefined
}

/** 409 for the id of a stored row whose runtime tag Swarm Map does not know. */
function unmanagedRowRefusal(row: Unmanaged): NextResponse {
  return NextResponse.json(
    {
      error: `${unmanagedRowNote(row)} Nothing can be changed through it. Forget the row to free the name.`,
      reason: row.reason,
      runtime: row.runtime,
    },
    { status: 409 },
  )
}

function listedHarness(id: string): Resolved {
  const harness = services.harness.get(id)
  if (!harness) return { refusal: NextResponse.json({ error: 'Harness not found' }, { status: 404 }) }
  return { harness }
}

/** Resolve `id` to the one listed agent, or to the response that refuses it. */
export function requireHarness(id: unknown): Resolved {
  const invalid = invalidHarnessId(id)
  if (invalid) return { refusal: invalid }
  const unmanaged = unmanagedRow(id as string)
  if (unmanaged) return { refusal: unmanagedRowRefusal(unmanaged) }
  return listedHarness(id as string)
}

/**
 * The same step for the one request that may act on an unmanaged row: removing
 * the agent, which for such a row only forgets it (HarnessService.remove).
 * Returns the refusal, or undefined when the removal may go ahead.
 */
export function requireHarnessToRemove(id: unknown): NextResponse | undefined {
  const invalid = invalidHarnessId(id)
  if (invalid) return invalid
  if (unmanagedRow(id as string)) return undefined
  return listedHarness(id as string).refusal
}
