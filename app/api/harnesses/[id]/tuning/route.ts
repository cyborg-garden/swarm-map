import { NextResponse } from 'next/server'
import { applyTuningToHarness, readHarnessTuning, TUNING_SPEC, type TuningEdits, type TuningValues } from '@/lib/services/tuning-writer'

/**
 * GET /api/harnesses/:id/tuning
 *
 * The numeric runtime knobs as they are in config.yaml right now
 * (`values`, null = key absent so the runtime default applies) plus the
 * spec the editor renders: section/key, range, and the runtime default.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const r = readHarnessTuning(id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ values: r.values, spec: TUNING_SPEC })
}

/**
 * PUT /api/harnesses/:id/tuning
 *
 * Body: `{ values: { memoryCharLimit?: number, … }, expected?: { … } }`.
 * `expected` is what the editor last read; when config.yaml differs the write
 * is refused with 409 and nothing changes. Goes through the one guarded
 * writer (applyTuningToHarness). Does not restart the agent — hermes reads
 * these at start, so the caller restarts to apply.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: { values?: TuningEdits; expected?: Partial<TuningValues> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body.values !== 'object' || body.values === null) {
    return NextResponse.json({ error: 'Body must include values' }, { status: 400 })
  }
  const r = applyTuningToHarness(id, body.values, { who: 'api', expected: body.expected })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, unchanged: r.unchanged, values: r.values })
}
