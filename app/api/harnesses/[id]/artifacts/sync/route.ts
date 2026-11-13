import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// POST /api/harnesses/:id/artifacts/sync — adopt / update the base package.
// Body (optional):
//   dryRun        → return the plan without writing, assigning keys or restarting
//   force         → overwrite even user-modified artifacts (default never clobbers)
//   surface       → 'private' | 'team' | 'public' (default: the agent's stamp, else team)
//   packs         → extra opt-in packs (added to what the agent already has)
//   assignKeys    → assign required research keys from the key store (default true)
//   includeVision → also assign the vision (OpenRouter) key (default false)
// Add-only and idempotent: a second run reports nothing to do.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const dryRun = body?.dryRun === true
  const force = body?.force === true
  try {
    const result = services.harness.syncArtifacts(id, {
      dryRun,
      force,
      surface: body?.surface,
      packs: body?.packs,
      keys: body?.assignKeys === false ? undefined : services.keys,
      includeVision: body?.includeVision === true,
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'artifacts sync failed'
    const status = /not found/i.test(msg) ? 404 : /Unknown (pack|surface)|not allowed/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
