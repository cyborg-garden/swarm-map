import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { applyCascadeToHarness } from '@/lib/services/cascade-writer'

// POST /api/cascades/:name/apply { harnessId, restart?: boolean (default true) }
//
// Ports a saved cascade (chain[0] = primary → model:, the rest →
// fallback_providers) onto a harness through the shared guarded writer,
// which keeps the TARGET file's convention about repeating the primary as
// row 0. A provider the target harness has no credential for → 400 with the
// validation message, config.yaml untouched, NO restart. On success the
// harness is quick-restarted (same as the UI after a manual cascade save)
// unless restart:false. Audited as cascade:apply { name, harness }.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params

  let body: { harnessId?: string; restart?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const harnessId = typeof body.harnessId === 'string' ? body.harnessId.trim() : ''
  if (!harnessId) {
    return NextResponse.json({ error: 'harnessId is required' }, { status: 400 })
  }

  const cascade = services.cascades.get(name)
  if (!cascade) {
    return NextResponse.json({ error: 'Cascade not found' }, { status: 404 })
  }

  const result = applyCascadeToHarness(harnessId, cascade.chain, {
    who: 'api',
    audit: { what: 'cascade:apply', meta: { name: cascade.name, harness: harnessId } },
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  let restarted = false
  let restartError: string | undefined
  if (body.restart !== false) {
    try {
      services.harness.restart(harnessId, 'quick')
      restarted = true
    } catch (err) {
      restartError = err instanceof Error ? err.message : 'Restart failed'
    }
  }

  return NextResponse.json({
    ok: true,
    name: cascade.name,
    harness: harnessId,
    applied: result.written,
    restarted,
    ...(restartError ? { restartError } : {}),
  })
}
