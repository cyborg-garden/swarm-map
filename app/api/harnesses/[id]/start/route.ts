import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { refuseUnmanagedRow } from '@/lib/services/unmanaged-row-guard'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const unmanaged = refuseUnmanagedRow(id)
  if (unmanaged) return unmanaged
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
