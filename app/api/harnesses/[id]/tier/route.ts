import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import type { HabitatTier } from '@/lib/types'

const VALID_TIERS: HabitatTier[] = ['individual', 'team', 'org', 'orgpublic', 'public']

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let body: { tier?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.tier || !VALID_TIERS.includes(body.tier as HabitatTier)) {
    return NextResponse.json(
      { error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }

  const updated = services.harness.updateConfig(id, { tier: body.tier as HabitatTier })
  if (!updated) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json(updated)
}
