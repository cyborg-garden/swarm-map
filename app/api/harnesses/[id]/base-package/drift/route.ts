import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// GET /api/harnesses/:id/base-package/drift — REPORT ONLY.
// Compares the agent's data dir against the base package (version, core
// plugins, plugins.enabled shape, research keys vs the key store, dead guard
// keys, fallback rows without credentials, surface-profile violations).
// Fixes nothing: adopt with POST /api/harnesses/:id/artifacts/sync.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    return NextResponse.json(services.harness.basePackageDrift(id, services.keys))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'drift check failed'
    return NextResponse.json({ error: msg }, { status: /not found/i.test(msg) ? 404 : 500 })
  }
}
