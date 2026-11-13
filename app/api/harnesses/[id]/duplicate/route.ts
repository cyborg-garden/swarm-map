import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { toHarnessSlug } from '@/lib/services/harness'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const newName = body.name

  if (!newName || typeof newName !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  // The service creates the duplicate under the SLUGGED name (toHarnessSlug),
  // so the pre-existence check must use the slug too — checking the raw name
  // would miss e.g. "Mare" colliding with existing "mare", and the collision
  // would then surface as a misleading 404 from the service instead of a 409.
  const slug = toHarnessSlug(newName)
  if (!slug) {
    return NextResponse.json(
      { error: 'name must contain at least one letter or digit' },
      { status: 400 }
    )
  }

  // Check if name already exists before attempting duplicate
  const existing = services.harness.get(
    'h_' + slug.replace(/-/g, '_').replace(/\s+/g, '_')
  )
  if (existing) {
    return NextResponse.json(
      { error: `Harness "${slug}" already exists` },
      { status: 409 }
    )
  }

  const result = await services.harness.duplicateOverlay(id, newName.trim())
  if (!result) {
    return NextResponse.json({ error: 'Source harness not found' }, { status: 404 })
  }

  return NextResponse.json(result, { status: 201 })
}
