import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// GET /api/settings/model-auto-update — the policy with defaults filled in.
export async function GET() {
  return NextResponse.json(services.config.getModelAutoUpdate())
}

// PUT /api/settings/model-auto-update — partial patch, merged over the
// current policy, validated (validateModelAutoUpdate), persisted, audited.
export async function PUT(request: Request) {
  const body = await request.json().catch(() => null)
  try {
    const updated = services.config.updateModelAutoUpdate(body)
    services.audit.append({ who: 'api', what: 'settings:model-auto-update', target: 'settings', meta: { ...updated } })
    return NextResponse.json(updated)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid modelAutoUpdate' },
      { status: 400 },
    )
  }
}
