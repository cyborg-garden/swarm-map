import { NextResponse } from 'next/server'
import { applyModelUpdate } from '@/lib/services/model-update-scheduler'

// POST /api/fleet/model-updates/apply { harnessId, from, to, provider? }
//
// Manual one-click apply of a reported successor (what the UI calls in
// notify mode). Same guards as the scheduler's apply path — provider
// allowlist, price ceiling, verified-live successor, restart lock, and the
// validated cascade write — minus the two that encode "did a human decide":
// the entry need not be tracked and a snapshot bump is allowed.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  const harnessId = typeof body?.harnessId === 'string' ? body.harnessId.trim() : ''
  const from = typeof body?.from === 'string' ? body.from.trim() : ''
  const to = typeof body?.to === 'string' ? body.to.trim() : ''
  const provider = typeof body?.provider === 'string' ? body.provider.trim() : undefined
  if (!harnessId || !from || !to) {
    return NextResponse.json({ error: 'harnessId, from and to are required' }, { status: 400 })
  }
  if (/[\r\n]/.test(from + to + (provider ?? ''))) {
    return NextResponse.json({ error: 'model ids must not contain newlines' }, { status: 400 })
  }
  try {
    const result = await applyModelUpdate({ harnessId, from, to, provider })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'apply failed' },
      { status: 500 },
    )
  }
}
