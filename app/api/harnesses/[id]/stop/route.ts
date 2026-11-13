import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    services.harness.stop(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Stop failed' },
      { status: 500 }
    )
  }
}
