import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { refuseUnknownHarnesses } from '@/lib/harness-ref'

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
    for (const harnessId of allAffected) {
      try { services.harness.restart(harnessId, 'recreate') } catch {}
    }
    return NextResponse.json(rotated)
  }

  if (!currentKey) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Assignment change: setAssignment keeps keys.json and every affected agent's
  // .env in lockstep (write to newly-assigned, strip from dropped), then recreate
  // only the containers whose .env actually changed (env_file is read at creation).
  if (body.assignedTo) {
    const affected = services.keys.setAssignment(id, body.assignedTo)
    for (const h of affected) {
      try { services.harness.restart(h, 'recreate') } catch {}
    }
  }

  // Any remaining metadata (budget/health/name).
  const { assignedTo: _assignedTo, value: _value, ...metadata } = body
  if (Object.keys(metadata).length) services.keys.update(id, metadata)

  return NextResponse.json(services.keys.list().find((k) => k.id === id))
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
  for (const harnessId of affected) {
    try { services.harness.restart(harnessId, 'recreate') } catch {}
  }
  return NextResponse.json({ ok: true })
}
