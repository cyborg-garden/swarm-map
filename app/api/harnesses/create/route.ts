import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { getDefaultToolsForTier } from '@/lib/services/tools'
import {
  loadBasePackage,
  validateSelection,
  assignBasePackageKeys,
  searchBackendFor,
  storeHasProvider,
  isSurface,
  DEFAULT_SURFACE,
  type Selection,
} from '@/lib/services/base-package'
import type { HabitatTier } from '@/lib/types'

// POST /api/harnesses/create
// Body: { name, tier?, platform?, channel?, models?, surface?: 'private'|'team'|'public', packs?: string[] }
// The base package (core + chosen packs + surface profile) is injected at
// scaffold time; required research keys are then assigned from the key store.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const { name, tier, platform, channel, models } = body

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const pkg = loadBasePackage()
  if (body.surface !== undefined && !isSurface(body.surface)) {
    return NextResponse.json({ error: `Invalid surface "${body.surface}" (private | team | public)` }, { status: 400 })
  }
  const selection: Selection = {
    surface: isSurface(body.surface) ? body.surface : DEFAULT_SURFACE,
    packs: Array.isArray(body.packs) ? body.packs.filter((p: unknown): p is string => typeof p === 'string') : [],
  }
  try {
    validateSelection(pkg, selection)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  // Compute default tools for the chosen tier
  const effectiveTier: HabitatTier = tier ?? 'individual'
  const allTools = services.tools.list()
  const defaultTools = getDefaultToolsForTier(effectiveTier, allTools)

  try {
    const result = await services.harness.createOverlay({
      name: name.trim(),
      tier,
      platform,
      channel,
      models,
      tools: defaultTools,
      selection,
      searchBackend: searchBackendFor(pkg, storeHasProvider(services.keys, 'brave')),
    })
    // Key bookkeeping is best-effort: the agent exists either way, and the
    // drift endpoint reports a missing research key.
    let keys: { provider: string; keyId?: string; action: string }[] = []
    try {
      if (result.id) keys = assignBasePackageKeys(services.keys, result.id, pkg).map(({ provider, keyId, action }) => ({ provider, keyId, action }))
    } catch (e) {
      console.error('[create] base-package key assignment failed:', e)
    }
    return NextResponse.json({ ...result, basePackage: { version: pkg.version, ...selection, keys } }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Create failed' },
      { status: 409 }
    )
  }
}
