import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// GET  /api/harnesses/:id/image  → version status (current / pinned / latest / updateAvailable)
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return NextResponse.json(await services.harness.imageStatus(id))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'image status failed'
    return NextResponse.json({ error: msg }, { status: /not found/i.test(msg) ? 404 : 500 })
  }
}

// PUT /api/harnesses/:id/image  { imageRef }  → pin + recreate
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const ref = typeof body?.imageRef === 'string' ? body.imageRef.trim() : ''
  if (!ref) return NextResponse.json({ error: 'imageRef is required' }, { status: 400 })
  try {
    return NextResponse.json(await services.harness.setAgentImage(id, ref))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'image update failed'
    return NextResponse.json({ error: msg }, { status: /not found/i.test(msg) ? 404 : 500 })
  }
}
