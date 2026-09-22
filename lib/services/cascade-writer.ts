import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { validateCascadeEntries, yamlPlainScalarError, type CascadeEntry } from '@/lib/model-catalog'
import { readFallbackProviders, guessDataDir, readAgentEnvVarNames, FALLBACK_PROVIDERS_HEADER } from '@/lib/services/harness'
import type { FallbackProvider } from '@/lib/services/harness'

/**
 * applyCascadeToHarness — the ONE guarded path that writes a fallback_providers
 * cascade into an agent's config.yaml.
 *
 * Extracted from the fallback_providers branch of PUT /api/harnesses/:id/models
 * so that route and the cascade library's apply route share it. Behaviour is
 * intentionally identical to the inline route code it replaced: the model:
 * section is derived from the entries (provider + default from entry 0,
 * fallback from the rest), fallback_providers: is written at root level, and
 * both sections are spliced by LINE, never via a YAML library.
 *
 * Guard: every entry is validated with validateCascadeEntries against the
 * env-var NAMES present in the agent's .env BEFORE anything is written. A
 * provider with no credential → { ok:false, status:400 } and config.yaml is
 * untouched. A bad write crash-loops a live agent, so this is the property
 * every caller relies on.
 *
 * api_key is never written, whatever the caller passes.
 */

export type CascadeWriteInput = { provider: string; model: string; base_url?: string }

export type CascadeWriteResult =
  | {
      ok: true
      written: {
        provider: string
        primary: string
        models: string[]
        fallbackProviders: FallbackProvider[]
      }
    }
  | { ok: false; status: 400 | 404; error: string }

export type ApplyCascadeOptions = {
  /** Actor for the audit trail ('api' | 'scheduler' | ...). */
  who: string
  /** When set, a successful write appends this audit entry (target = harness id). */
  audit?: { what: string; meta?: Record<string, unknown> }
}

export function applyCascadeToHarness(
  harnessId: string,
  entries: CascadeWriteInput[],
  opts: ApplyCascadeOptions
): CascadeWriteResult {
  const harness = services.harness.get(harnessId)
  if (!harness) {
    return { ok: false, status: 404, error: 'Harness not found' }
  }

  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(harness.serviceName ?? harness.name, containerName)
  const configPath = path.join(dataDir, 'config.yaml')

  // Whitelist-copy: provider/model/base_url only, trimmed. api_key never gets
  // through. Trimming here keeps what is WRITTEN identical to what the
  // validator CHECKS (it trims too) — a trailing "\r" must not slip past it.
  const fallbackProvidersToWrite: CascadeWriteInput[] = (entries ?? []).map((fp) => {
    const e: CascadeWriteInput = { provider: (fp.provider ?? '').trim(), model: (fp.model ?? '').trim() }
    if (fp.base_url && fp.base_url.trim()) e.base_url = fp.base_url.trim()
    return e
  })

  // Primary model = first entry, provider from first entry
  const provider = fallbackProvidersToWrite[0]?.provider || ''
  const cascade = fallbackProvidersToWrite.map((fp) => fp.model)
  const primary = cascade[0] || ''

  if (cascade.length === 0) {
    return { ok: false, status: 400, error: 'At least one model is required' }
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
  const entriesToValidate: CascadeEntry[] = fallbackProvidersToWrite.map((fp) => ({
    provider: fp.provider,
    model: fp.model,
  }))

  const modelErrors = validateCascadeEntries(entriesToValidate, presentEnvVars)
  // validateCascadeEntries covers provider/model; base_url is spliced unquoted
  // too, so it gets the same plain-scalar check here.
  for (const fp of fallbackProvidersToWrite) {
    if (fp.base_url) {
      const err = yamlPlainScalarError(fp.base_url, `base_url for "${fp.model}"`)
      if (err) modelErrors.push(err)
    }
  }
  if (modelErrors.length > 0) {
    return { ok: false, status: 400, error: `Invalid model cascade: ${modelErrors.join('; ')}` }
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

  const finish = (): CascadeWriteResult => {
    services.harness.updateConfig(harnessId, { models: cascade })
    if (opts.audit) {
      services.audit.append({
        who: opts.who,
        what: opts.audit.what,
        target: harnessId,
        meta: opts.audit.meta,
      })
    }
    const respFp = readFallbackProviders(dataDir)
    return { ok: true, written: { provider, primary, models: cascade, fallbackProviders: respFp } }
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
    return finish()
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
    // this writer never deletes fallback_providers. (Unreachable today — an
    // empty cascade is rejected above — but kept identical to the models PUT
    // route's splice so the two can never drift.)
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
  return finish()
}
