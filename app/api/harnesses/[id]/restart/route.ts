import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isRestarting } from '@/lib/services/restart-tracker'
import type { RestartMode } from '@/lib/types'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const mode: RestartMode = body.mode || 'quick'

  if (isRestarting(id)) {
    return NextResponse.json(
      { error: 'Restart already in progress' },
      { status: 409 }
    )
  }

  try {
    services.harness.restart(id, mode)
    return NextResponse.json({ ok: true, mode })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Restart failed' },
      { status: 500 }
    )
  }
}
