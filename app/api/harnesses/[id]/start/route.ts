import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { requireHarness } from '@/lib/harness-ref'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { refusal } = requireHarness(id)
  if (refusal) return refusal
  try {
    services.harness.start(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Start failed' },
      { status: 500 }
    )
  }
}
