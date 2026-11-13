import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// POST /api/harnesses/:id/artifacts/pack — install one opt-in pack into an
// existing agent, git-sourced artifacts included (base-package sync copies only
// local sources). Body:
//   pack       → required, a pack name from infra/artifacts.json
//   overwrite  → replace artifacts already present with the pinned version
//   restart    → recreate the container afterwards (default true)
// Add-only. Git sources are fetched at their pinned tag and trust-gated first.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const pack = typeof body?.pack === 'string' ? body.pack : ''
  if (!pack) return NextResponse.json({ error: 'pack is required' }, { status: 400 })
  try {
    const result = await services.harness.installPack(id, pack, {
      overwrite: body?.overwrite === true,
      restart: body?.restart !== false,
    })
    return NextResponse.json(result, { status: result.installed ? 200 : 502 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'pack install failed'
    const status = /not found/i.test(msg) ? 404 : /Unknown (pack|surface)|not allowed/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
