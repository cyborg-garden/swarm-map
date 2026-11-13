import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { requireHarness } from '@/lib/harness-ref'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { harness, refusal } = requireHarness(id)
  if (refusal) return refusal
  return NextResponse.json(harness)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { refusal } = requireHarness(id)
  if (refusal) return refusal
  const url = new URL(request.url)
  const deleteFiles = url.searchParams.get('deleteFiles') === 'true'

  const result = services.harness.remove(id, deleteFiles)
  if (!result.removed) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json(result)
}
