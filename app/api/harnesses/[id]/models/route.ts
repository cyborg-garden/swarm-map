import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { validateCascadeEntries, type CascadeEntry } from '@/lib/model-catalog'
import { applyCascadeToHarness } from '@/lib/services/cascade-writer'
import { readModelConfig, readModelProvider, readFallbackProviders, guessDataDir, readAgentEnvVarNames, FALLBACK_PROVIDERS_HEADER } from '@/lib/services/harness'
import type { FallbackProvider } from '@/lib/services/harness'
import fs from 'fs'
import path from 'path'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(harness.serviceName ?? harness.name, containerName)

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
    fallback_providers?: Array<{ provider: string; model: string; base_url?: string }>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(harness.serviceName ?? harness.name, containerName)
  const configPath = path.join(dataDir, 'config.yaml')

  // When fallback_providers is provided, derive cascade from it for backward compat
  let cascade: string[]
  let provider: string
  let fallbackProvidersToWrite: Array<{ provider: string; model: string; base_url?: string }> | undefined

  if (body.fallback_providers && body.fallback_providers.length > 0) {
    // fallback_providers shape: the shared, guarded writer (also used by the
    // cascade library's apply route). Validates credentials before writing.
    const result = applyCascadeToHarness(id, body.fallback_providers, { who: 'api' })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.written)
  } else {
    // Legacy path: string-based cascade
    cascade = body.cascade ?? (body.model ? [body.model] : [])
    provider = body.provider || ''

    // Map each model onto its existing fallback_providers row so a reorder
    // through this shape keeps each row's provider + base_url. Only a model
    // with no existing row is defaulted to body.provider. Without this the
    // whole block was dropped and a local model lost its ollama base_url (#149).
    const existing = readFallbackProviders(dataDir)
    if (existing.length > 0 && cascade.length > 0) {
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
      fallbackProvidersToWrite = cascade.map((model) => {
        const row = existing.find((fp) => fp.model === model)
        if (!row) return { provider: defaultProvider, model }
        return { provider: row.provider, model: row.model, ...(row.base_url ? { base_url: row.base_url } : {}) }
      })
      // model.provider must follow the new primary row, not the stale body value.
      provider = fallbackProvidersToWrite[0].provider || provider
    }
  }

  const primary = cascade[0] || ''

  if (cascade.length === 0) {
    return NextResponse.json({ error: 'At least one model is required' }, { status: 400 })
  }

  // Guard the write/restart path before touching config.yaml. Two checks:
  //  1. Empty model id → always rejected (the unambiguous crash case).
  //  2. Provider-credential presence → reject ONLY when a cascade entry's
  //     provider is DEFINITIVELY un-serviceable for THIS agent (it needs a key,
  //     we know which env var, and it's absent in the agent's .env). The
  //     motivating case: pushing an openrouter model onto an agent with no
  //     OPENROUTER_API_KEY → restart → crash-loop. All uncertainty fails open
  //     (a valid config must never be blocked). See validateCascadeEntries.
  const presentEnvVars = readAgentEnvVarNames(dataDir)
  const entriesToValidate: CascadeEntry[] =
    fallbackProvidersToWrite && fallbackProvidersToWrite.length > 0
      ? fallbackProvidersToWrite.map((fp) => ({ provider: fp.provider, model: fp.model }))
      : cascade.map((model) => ({ provider, model }))

  const modelErrors = validateCascadeEntries(entriesToValidate, presentEnvVars)
  if (modelErrors.length > 0) {
    return NextResponse.json(
      { error: `Invalid model cascade: ${modelErrors.join('; ')}` },
      { status: 400 }
    )
  }

  // Build the model section of config.yaml
  const modelLines = ['model:']
  if (provider) modelLines.push(`  provider: ${provider}`)
  modelLines.push(`  default: ${primary}`)
  if (cascade.length > 1) {
    modelLines.push(`  fallback:`)
    for (const m of cascade.slice(1)) {
      modelLines.push(`    - ${m}`)
    }
  }

  // Build fallback_providers YAML section (root level)
  const fpLines: string[] = []
  if (fallbackProvidersToWrite && fallbackProvidersToWrite.length > 0) {
    fpLines.push('fallback_providers:')
    for (const fp of fallbackProvidersToWrite) {
      fpLines.push(`  - provider: ${fp.provider}`)
      fpLines.push(`    model: ${fp.model}`)
      if (fp.base_url) {
        fpLines.push(`    base_url: ${fp.base_url}`)
      }
      // Do NOT write api_key from the UI (security)
    }
  }

  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    // No config.yaml — create one
    const sections = [modelLines.join('\n')]
    if (fpLines.length > 0) sections.push('', fpLines.join('\n'))
    content = sections.join('\n') + '\n'
    fs.writeFileSync(configPath, content, 'utf-8')
    services.harness.updateConfig(id, { models: cascade })
    const respFp = readFallbackProviders(dataDir)
    return NextResponse.json({ provider, primary, models: cascade, fallbackProviders: respFp })
  }

  // Replace sections in existing config.yaml
  const lines = content.split('\n')
  const updated: string[] = []
  let inModelSection = false
  let modelSectionWritten = false
  let inFpSection = false
  let fpSectionWritten = false

  for (const line of lines) {
    // model: section
    if (/^model:\s*$/.test(line) || /^model:$/.test(line.trim())) {
      inModelSection = true
      inFpSection = false
      if (!modelSectionWritten) {
        updated.push(...modelLines)
        modelSectionWritten = true
      }
      continue
    }
    // fallback_providers: section. Same header test as the reader (a trailing
    // comment is still a header) — a missed header appended a duplicate block.
    // With nothing to write, the existing block is passed through untouched:
    // this route never deletes fallback_providers.
    if (FALLBACK_PROVIDERS_HEADER.test(line)) {
      if (fpLines.length === 0) {
        inModelSection = false
        updated.push(line)
        continue
      }
      inFpSection = true
      inModelSection = false
      if (!fpSectionWritten) {
        updated.push(...fpLines)
        fpSectionWritten = true
      }
      continue
    }

    // A section (model / fallback_providers) spans everything up to the next
    // TOP-LEVEL mapping key. Skip all of the old body — indented continuation
    // lines, blank lines, AND column-0 block-sequence items (`- provider:`).
    // Only matching indented lines (the old rule) left col-0 list items behind
    // as orphans → a bare sequence item beside top-level keys → invalid YAML.
    if (inModelSection || inFpSection) {
      if (!/^[A-Za-z_][\w-]*:/.test(line)) continue
      inModelSection = false
      inFpSection = false
    }
    updated.push(line)
  }

  // If config had no model section at all, append it
  if (!modelSectionWritten) {
    updated.push('', ...modelLines)
  }

  // If config had no fallback_providers section, append it
  if (!fpSectionWritten && fpLines.length > 0) {
    updated.push('', ...fpLines)
  }

  fs.writeFileSync(configPath, updated.join('\n'), 'utf-8')
  services.harness.updateConfig(id, { models: cascade })

  const respFp = readFallbackProviders(dataDir)
  return NextResponse.json({ provider, primary, models: cascade, fallbackProviders: respFp })
}
