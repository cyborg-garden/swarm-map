import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { readModelConfig, readModelProvider, readFallbackProviders, readCascade, cascadeChain, guessDataDir } from '@/lib/services/harness'
// The ONE guarded writer for model: / fallback_providers: (also used by the
// cascade library and the model-update scheduler). Every body shape goes
// through it — validate → render → splice → write → overlay.
import { applyCascadeToHarness, type CascadeWriteInput } from '@/lib/services/cascade-writer'

function dataDirFor(harness: { name: string; serviceName?: string }): string {
  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  return guessDataDir(harness.serviceName ?? harness.name, containerName)
}

/**
 * GET /api/harnesses/:id/models
 *
 * The cascade the way the runtime consumes it (see readCascade):
 *  - `chain`: what the editor shows — the primary (model.provider /
 *    model.default) first, then every fallback_providers row in order, with
 *    a row 0 that merely repeats the primary folded away.
 *  - `primaryEntry`: the primary as a row, or null when model.default is absent.
 *  - `primaryDuplicatedAsRow0`: the file repeats its primary as row 0 (a
 *    per-file convention the writer preserves; nothing to fix).
 *  - `fallbackProviders`: the raw rows, duplicate included.
 *  - `provider`, `primary`, `models`: the pre-chain fields, kept for callers.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  const dataDir = dataDirFor(harness)
  const models = readModelConfig(dataDir)
  const provider = readModelProvider(dataDir)
  const fallbackProviders = readFallbackProviders(dataDir)
  const cascade = readCascade(dataDir)

  return NextResponse.json({
    provider,
    primary: cascade.primary?.model ?? models[0] ?? '',
    models,
    fallbackProviders,
    chain: cascadeChain(cascade),
    primaryEntry: cascade.primary,
    primaryDuplicatedAsRow0: cascade.primaryDuplicatedAsRow0,
    dataDir,
  })
}

type RowInput = { provider: string; model: string; base_url?: string }

const sameRow = (a: RowInput, b: RowInput): boolean =>
  (a?.provider ?? '').trim().toLowerCase() === (b?.provider ?? '').trim().toLowerCase() &&
  (a?.model ?? '').trim() === (b?.model ?? '').trim() &&
  ((a?.base_url ?? '').trim() || undefined) === ((b?.base_url ?? '').trim() || undefined)

// Whitelist-copy each row. `carryFrom` is the scheduler's lookup key for
// moving a row's key_env / api_mode onto its successor; from an API body it
// would move a credential onto any row the caller names and skip the
// credential check for that row. It never enters from here.
const whitelist = (rows: RowInput[]): CascadeWriteInput[] =>
  rows.map((r) => ({
    provider: r?.provider ?? '',
    model: r?.model ?? '',
    ...(r?.base_url ? { base_url: r.base_url } : {}),
  }))

/**
 * PUT /api/harnesses/:id/models
 *
 * Three body shapes, one writer:
 *  - `{ chain: Row[], expected_chain?: Row[] }` — the cascade editor.
 *    chain[0] is the primary (written to model:), the rest are the
 *    fallback_providers rows; the file's own convention about repeating the
 *    primary as row 0 is preserved by the writer. `expected_chain` is what
 *    the editor last read; when the chain on disk differs (the scheduler
 *    rotated an entry, or another tab saved) the write is refused with 409
 *    and nothing changes.
 *  - `{ fallback_providers: Row[], expected_fallback_providers?: Row[] }` —
 *    the pre-chain editor / API shape. The rows are taken as a chain (row 0
 *    = primary, as that shape always meant) and `expected_fallback_providers`
 *    is compared against the raw rows on disk.
 *  - `{ provider?, model? | cascade?: string[] }` — the legacy string shape
 *    (README, API callers). Each id is mapped onto its existing chain entry
 *    so provider + base_url survive a reorder; an id with no entry takes
 *    body.provider, else the agent's model.provider. When the agent has no
 *    cascade at all only the model: section is rewritten (the writer keeps
 *    model.provider / model.base_url / any other key it does not own, and
 *    never invents or deletes a fallback_providers block).
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  let body: {
    provider?: string
    model?: string
    cascade?: string[]
    chain?: RowInput[]
    expected_chain?: RowInput[]
    fallback_providers?: RowInput[]
    expected_fallback_providers?: RowInput[]
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const dataDir = dataDirFor(harness)

  if (Array.isArray(body.chain) && body.chain.length > 0) {
    const expected = Array.isArray(body.expected_chain) ? whitelist(body.expected_chain) : undefined
    const result = applyCascadeToHarness(id, whitelist(body.chain), { who: 'api', expected })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.written)
  }

  if (body.fallback_providers && body.fallback_providers.length > 0) {
    if (Array.isArray(body.expected_fallback_providers)) {
      const current = readFallbackProviders(dataDir)
      const expected = body.expected_fallback_providers
      const same = current.length === expected.length && current.every((r, i) => sameRow(r, expected[i]))
      if (!same) {
        return NextResponse.json({ error: 'The model cascade changed since it was read; reload and try again' }, { status: 409 })
      }
    }
    const result = applyCascadeToHarness(id, whitelist(body.fallback_providers), { who: 'api' })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.written)
  }

  // Legacy path: string-based cascade. Dedupe — `{cascade:['a','a']}` wrote
  // two identical rows and listed the primary under its own fallback:.
  const cascade = Array.from(new Set((body.cascade ?? (body.model ? [body.model] : [])).map((m) => (m ?? '').trim())))
  const provider = (body.provider ?? '').trim()
  if (cascade.length === 0) {
    return NextResponse.json({ error: 'At least one model is required' }, { status: 400 })
  }

  const existing = cascadeChain(readCascade(dataDir))

  let entries: CascadeWriteInput[]
  let mode: 'write' | 'keep'
  if (existing.length > 0) {
    // A model with no existing entry needs SOME provider. The documented
    // `{ cascade: [...] }` shape carries none, so fall back to the agent's
    // current model.provider. With neither we must not write `- provider: `
    // (YAML null): Hermes drops that row silently and our reader cannot parse
    // it back, so the editor and the file diverge with no error.
    const defaultProvider = provider || readModelProvider(dataDir)
    const unknown = cascade.filter((model) => !existing.some((fp) => fp.model === model))
    if (!defaultProvider && unknown.length > 0) {
      return NextResponse.json(
        { error: `provider required for model "${unknown[0]}": it is not in the cascade and the body carries no provider` },
        { status: 400 }
      )
    }
    entries = cascade.map((model) => {
      const row = existing.find((fp) => fp.model === model)
      if (!row) return { provider: defaultProvider, model }
      return { provider: row.provider, model: row.model, ...(row.base_url ? { base_url: row.base_url } : {}) }
    })
    mode = 'write'
  } else {
    // No cascade to map onto: rewrite the model: section only. The block on
    // disk (if the reader could not parse it) passes through untouched.
    entries = cascade.map((model) => ({ provider, model }))
    mode = 'keep'
  }

  const result = applyCascadeToHarness(id, entries, { who: 'api', fallbackProviders: mode })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.written)
}
