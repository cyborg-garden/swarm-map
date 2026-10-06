import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import {
  loadBasePackage,
  validateSelection,
  assignBasePackageKeys,
  isSurface,
  DEFAULT_SURFACE,
  type Selection,
} from '@/lib/services/base-package'

// POST /api/harnesses/import
// Body: { dataDir, name, surface?: 'private'|'team'|'public', packs?: string[] }
// Connects an existing Hermes data dir. The base package is applied add-only:
// the agent keeps its own plugins, skills, persona and memory.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const { dataDir, name } = body

  if (!dataDir || !name) {
    return NextResponse.json({ error: 'dataDir and name are required' }, { status: 400 })
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

  try {
    const result = await services.harness.importFromDir(dataDir, name.trim(), selection)
    let keys: { provider: string; keyId?: string; action: string }[] = []
    try {
      if (result.id) keys = assignBasePackageKeys(services.keys, result.id, pkg).map(({ provider, keyId, action }) => ({ provider, keyId, action }))
    } catch (e) {
      console.error('[import] base-package key assignment failed:', e)
    }
    return NextResponse.json({
      id: result.id,
      name: result.name,
      sourceDir: result.sourceDir,
      destDir: result.destDir,
      changes: result.changes,
      basePackage: { version: pkg.version, ...selection, keys },
    }, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Import failed' },
      { status: 500 }
    )
  }
}
