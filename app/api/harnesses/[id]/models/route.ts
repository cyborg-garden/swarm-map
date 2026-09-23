import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { readModelConfig, readModelProvider, readFallbackProviders, guessDataDir } from '@/lib/services/harness'
// The ONE guarded writer for model: / fallback_providers: (also used by the
// cascade library and the model-update scheduler). Both body shapes go
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

  return NextResponse.json({
    provider,
    primary: models[0] ?? '',
    models,
    fallbackProviders,
    dataDir,
  })
}

type RowInput = { provider: string; model: string; base_url?: string }

/**
 * PUT /api/harnesses/:id/models
 *
 * Two body shapes, one writer:
 *  - `{ fallback_providers: Row[], expected_fallback_providers?: Row[] }` —
 *    the cascade editor. `expected_fallback_providers` is what the editor
 *    last read; when the rows on disk differ (the scheduler rotated one, or
 *    another tab saved) the write is refused with 409 and nothing changes.
 *    Also 409 when the file's model.default is not fallback_providers[0] and
 *    the new row 0 is not that primary either: the editor never showed the
 *    real primary, so it must not move it (primary-mismatch).
 *  - `{ provider?, model? | cascade?: string[] }` — the legacy string shape
 *    (README, API callers). Each id is mapped onto its existing
 *    fallback_providers row so provider + base_url survive a reorder; an id
 *    with no row takes body.provider, else the agent's model.provider. When
 *    the agent has no parseable rows only the model: section is rewritten
 *    (the writer keeps model.provider / model.base_url / any other key it
 *    does not own, and never invents or deletes a fallback_providers block).
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
    fallback_providers?: RowInput[]
    expected_fallback_providers?: RowInput[]
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.fallback_providers && body.fallback_providers.length > 0) {
    const expected = Array.isArray(body.expected_fallback_providers) ? body.expected_fallback_providers : undefined
    const result = applyCascadeToHarness(id, body.fallback_providers, { who: 'api', expected })
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

  const dataDir = dataDirFor(harness)
  const existing = readFallbackProviders(dataDir)

  let entries: CascadeWriteInput[]
  let mode: 'write' | 'keep'
  if (existing.length > 0) {
    // A model with no existing row needs SOME provider. The documented
    // `{ cascade: [...] }` shape carries none, so fall back to the agent's
    // current model.provider. With neither we must not write `- provider: `
    // (YAML null): Hermes drops that row silently and our reader cannot parse
    // it back, so the editor and model.fallback diverge with no error.
    const defaultProvider = provider || readModelProvider(dataDir)
    const unknown = cascade.filter((model) => !existing.some((fp) => fp.model === model))
    if (!defaultProvider && unknown.length > 0) {
      return NextResponse.json(
        { error: `provider required for model "${unknown[0]}": it has no fallback_providers row and the body carries no provider` },
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
    // No rows to map onto: rewrite the model: section only. The block on disk
    // (if the reader could not parse it) passes through untouched.
    entries = cascade.map((model) => ({ provider, model }))
    mode = 'keep'
  }

  // A `{ model }` / `{ cascade }` body names the primary outright, so moving
  // it is the request — the writer's primary-mismatch guard does not apply.
  const result = applyCascadeToHarness(id, entries, { who: 'api', fallbackProviders: mode, allowPrimaryChange: true })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.written)
}
