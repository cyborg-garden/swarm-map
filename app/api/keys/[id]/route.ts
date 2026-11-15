import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { refuseUnknownHarnesses } from '@/lib/harness-ref'
import { restartEach, type RestartOutcome } from '@/lib/restart-outcome'

// The save is done by the time a restart runs; `restarts` in each response says
// whether the restart that applies it started.
const recreate = (harnessIds: Iterable<string>): RestartOutcome[] =>
  restartEach(harnessIds, 'recreate', (h, mode) => services.harness.restart(h, mode))

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()

  const currentKeys = services.keys.list()
  const currentKey = currentKeys.find((k) => k.id === id)

  // Agents newly named in assignedTo are resolved before anything changes.
  // Ones the key already holds are kept as stored.
  const refusal = refuseUnknownHarnesses(body.assignedTo, currentKey?.assignedTo ?? [])
  if (refusal) return refusal

  // If a new value is provided, rotate + update metadata in one operation
  if (body.value) {
    const { value, ...metadata } = body
    const rotated = services.keys.rotateValue(id, value, metadata)
    if (!rotated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // Recreate all affected harnesses so the rotated value loads
    // (env_file is read at container creation, not on a plain restart).
    const allAffected = new Set([
      ...(rotated.assignedTo ?? []),
      ...(currentKey?.assignedTo ?? []),
    ])
    return NextResponse.json({ ...rotated, restarts: recreate(allAffected) })
  }

  if (!currentKey) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Assignment change: setAssignment keeps keys.json and every affected agent's
  // .env in lockstep (write to newly-assigned, strip from dropped), then recreate
  // only the containers whose .env actually changed (env_file is read at creation).
  let restarts: RestartOutcome[] = []
  if (body.assignedTo) {
    restarts = recreate(services.keys.setAssignment(id, body.assignedTo))
  }

  // Any remaining metadata (budget/health/name).
  const { assignedTo: _assignedTo, value: _value, ...metadata } = body
  if (Object.keys(metadata).length) services.keys.update(id, metadata)

  return NextResponse.json({ ...services.keys.list().find((k) => k.id === id), restarts })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // Capture the assignments before removal so we can recreate those agents once
  // the credential has been stripped from their .env (remove() does the strip).
  const key = services.keys.list().find((k) => k.id === id)
  const affected = key?.assignedTo ?? []
  const removed = services.keys.remove(id)
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true, restarts: recreate(affected) })
}
