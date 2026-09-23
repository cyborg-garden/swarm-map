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
 * Every write to the model: / fallback_providers: sections goes through here:
 * PUT /api/harnesses/:id/models (both body shapes), the cascade library's
 * apply route, and the model-update scheduler (automatic and one-click). The
 * model: section is derived from the entries (provider + default + base_url
 * from entry 0, fallback from the rest), fallback_providers: is written at
 * root level, and both sections are spliced by LINE, never via a YAML library.
 *
 * Round-trip contract (audit 2026-09): the writer only OWNS
 * model.provider / model.default / model.fallback / model.base_url and each
 * row's provider / model / base_url. Everything else it finds inside those two
 * sections passes through verbatim — model.api_mode, a row's inline api_key or
 * key_env — as long as the row (provider, model) survives the write. Dropping
 * them silently re-routed a local primary to OpenRouter and killed a proxy
 * credential without a trace in the audit log.
 *
 * Guard: every entry is validated with validateCascadeEntries against the
 * env-var NAMES present in the agent's .env BEFORE anything is written. A
 * provider with no credential → { ok:false, status:400 } and config.yaml is
 * untouched. A bad write crash-loops a live agent, so this is the property
 * every caller relies on.
 *
 * Caller-supplied api_key is never written, whatever the caller passes.
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
  | { ok: false; status: 400 | 404 | 409; error: string }

export type ApplyCascadeOptions = {
  /** Actor for the audit trail ('api' | 'scheduler' | ...). */
  who: string
  /** When set, a successful write appends this audit entry (target = harness id). */
  audit?: { what: string; meta?: Record<string, unknown> }
  /**
   * Optimistic precondition: the rows the caller last READ. When the rows on
   * disk differ (another writer — the scheduler, another tab — got there
   * first) the write is refused with 409 and nothing is touched. Without it a
   * stale editor save silently reverted an applied update and orphaned its
   * tracking key.
   */
  expected?: CascadeWriteInput[]
  /**
   * 'write' (default): fallback_providers is rewritten from `entries`.
   * 'keep': only the model: section is rewritten; whatever fallback_providers
   * block is on disk passes through untouched. For the legacy
   * `{ provider, model | cascade }` body when the agent has no rows the
   * cascade can be mapped onto — the writer must not invent a block.
   */
  fallbackProviders?: 'write' | 'keep'
}

/** Keys of the model: section the writer derives from the entries. */
const MANAGED_MODEL_KEYS = new Set(['provider', 'default', 'fallback', 'base_url'])
/** Keys of a fallback_providers row the writer derives from an entry. */
const MANAGED_ROW_KEYS = new Set(['provider', 'model', 'base_url'])
/** Providers whose primary is addressed by model.base_url (the HSM template writes it for these). */
const BASE_URL_PROVIDERS = new Set(['ollama', 'custom'])

const TOP_LEVEL_KEY = /^[A-Za-z_][\w-]*:/
const MODEL_HEADER = /^model:\s*(#.*)?$/

const unquote = (v: string): string => v.trim().replace(/^["']|["']$/g, '')
const indentOf = (line: string): number => line.length - line.trimStart().length

type ExistingModelBlock = {
  /** Indent of the block's keys ('  ' unless the file says otherwise). */
  indent: string
  provider: string
  /** The verbatim `base_url:` line, if any. */
  baseUrlLine?: string
  /** Every key the writer does not manage, verbatim, with its nested lines. */
  passthrough: string[]
}

/** Read the first top-level model: block; keys the writer does not own are kept verbatim. */
function parseExistingModelBlock(lines: string[]): ExistingModelBlock | null {
  const start = lines.findIndex((l) => MODEL_HEADER.test(l))
  if (start < 0) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_LEVEL_KEY.test(lines[i])) break
    body.push(lines[i])
  }
  const firstKey = body.find((l) => l.trim() && !l.trim().startsWith('#') && indentOf(l) > 0)
  const keyIndent = firstKey ? indentOf(firstKey) : 2
  const out: ExistingModelBlock = { indent: ' '.repeat(keyIndent), provider: '', passthrough: [] }
  let managed: boolean | null = null // null = before the first key
  for (const line of body) {
    const trimmed = line.trim()
    const isKey = trimmed && !trimmed.startsWith('#') && indentOf(line) === keyIndent && /^[\w-]+:/.test(trimmed)
    if (isKey) {
      const key = trimmed.slice(0, trimmed.indexOf(':'))
      managed = MANAGED_MODEL_KEYS.has(key)
      if (key === 'provider') out.provider = unquote(trimmed.slice('provider:'.length))
      if (key === 'base_url') out.baseUrlLine = line
      if (!managed) out.passthrough.push(line)
      continue
    }
    if (managed === false) out.passthrough.push(line)
  }
  // A trailing run of blank lines belongs to the file, not to the last key.
  while (out.passthrough.length && out.passthrough[out.passthrough.length - 1].trim() === '') out.passthrough.pop()
  return out
}

type ExistingRow = { provider: string; model: string; extra: string[]; used: boolean }

/**
 * Read the rows of the first fallback_providers: block with every line the
 * reader does not model (api_key, key_env, api_mode, nested maps…) kept
 * verbatim and re-indented to the shape this writer emits (4-space fields).
 */
function parseExistingRows(lines: string[]): ExistingRow[] {
  const start = lines.findIndex((l) => FALLBACK_PROVIDERS_HEADER.test(l))
  if (start < 0) return []
  const rows: ExistingRow[] = []
  let cur: { fields: Array<{ key: string; lines: string[] }>; fieldIndent: number } | null = null
  const flush = () => {
    if (!cur) return
    const get = (k: string) => cur!.fields.find((f) => f.key === k)
    const prov = get('provider')
    const model = get('model')
    if (prov && model) {
      const delta = 4 - cur.fieldIndent
      const reindent = (l: string): string => {
        if (!l.trim()) return l
        if (delta >= 0) return ' '.repeat(delta) + l
        return l.slice(Math.min(-delta, indentOf(l)))
      }
      const extra = cur.fields.filter((f) => !MANAGED_ROW_KEYS.has(f.key)).flatMap((f) => f.lines.map(reindent))
      rows.push({ provider: unquote(prov.lines[0].trim().slice('provider:'.length)), model: unquote(model.lines[0].trim().slice('model:'.length)), extra, used: false })
    }
    cur = null
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (TOP_LEVEL_KEY.test(line)) break
    if (trimmed.startsWith('- ')) {
      flush()
      const dash = line.indexOf('-')
      const rest = line.slice(dash + 1)
      const fieldIndent = dash + 1 + (rest.length - rest.trimStart().length)
      cur = { fields: [], fieldIndent }
      const item = rest.trim()
      const flow = item.match(/^\{(.*)\}$/)
      if (flow) {
        for (const pair of flow[1].matchAll(/(\w+):\s*("[^"]*"|'[^']*'|[^,}]+)/g)) {
          cur.fields.push({ key: pair[1], lines: [' '.repeat(fieldIndent) + `${pair[1]}: ${pair[2].trim()}`] })
        }
        continue
      }
      const kv = item.match(/^([\w-]+):/)
      if (kv) cur.fields.push({ key: kv[1], lines: [' '.repeat(fieldIndent) + item] })
      continue
    }
    if (!cur) continue
    if (!trimmed || trimmed.startsWith('#')) {
      // Blank/comment inside a row rides with the field above it.
      if (cur.fields.length) cur.fields[cur.fields.length - 1].lines.push(line)
      continue
    }
    const kv = indentOf(line) === cur.fieldIndent ? trimmed.match(/^([\w-]+):/) : null
    if (kv) cur.fields.push({ key: kv[1], lines: [line] })
    else if (cur.fields.length) cur.fields[cur.fields.length - 1].lines.push(line)
  }
  flush()
  return rows
}

const sameRows = (a: CascadeWriteInput[], b: CascadeWriteInput[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]
    return (
      (x.provider ?? '').trim().toLowerCase() === (y.provider ?? '').trim().toLowerCase() &&
      (x.model ?? '').trim() === (y.model ?? '').trim() &&
      ((x.base_url ?? '').trim() || undefined) === ((y.base_url ?? '').trim() || undefined)
    )
  })

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
  const writeRows = opts.fallbackProviders !== 'keep'

  // Whitelist-copy: provider/model/base_url only, trimmed. api_key never gets
  // through. Trimming here keeps what is WRITTEN identical to what the
  // validator CHECKS (it trims too) — a trailing "\r" must not slip past it.
  const fallbackProvidersToWrite: CascadeWriteInput[] = (entries ?? []).map((fp) => {
    const e: CascadeWriteInput = { provider: (fp.provider ?? '').trim(), model: (fp.model ?? '').trim() }
    if (fp.base_url && fp.base_url.trim()) e.base_url = fp.base_url.trim()
    return e
  })

  // Primary model = first entry, provider from first entry
  const entryProvider = fallbackProvidersToWrite[0]?.provider || ''
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

  // Optimistic precondition against what the caller last read.
  if (opts.expected) {
    const current = readFallbackProviders(dataDir)
    if (!sameRows(current, opts.expected)) {
      return { ok: false, status: 409, error: 'The model cascade changed since it was read; reload and try again' }
    }
  }

  let content: string | null
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    content = null
  }
  const lines = content === null ? [] : content.split('\n')
  const existingModel = parseExistingModelBlock(lines)
  const existingRows = writeRows ? parseExistingRows(lines) : []

  // Effective model.provider: the primary row's, else whatever the file says
  // (a legacy body with no provider must not delete the line).
  const provider = entryProvider || existingModel?.provider || ''
  const ind = existingModel?.indent ?? '  '

  // Build the model section of config.yaml. Managed keys come from the
  // entries; every other key of the existing block passes through verbatim.
  const modelLines = ['model:']
  if (provider) modelLines.push(`${ind}provider: ${provider}`)
  modelLines.push(`${ind}default: ${primary}`)
  // model.base_url follows the primary row. With no base_url on that row, the
  // existing line stays only while it can still be meant for this primary: the
  // provider is unchanged / unspecified, or is one that is addressed by URL.
  // A local ollama URL must not leak onto a cloud primary that replaced it.
  const primaryBaseUrl = fallbackProvidersToWrite[0]?.base_url
  if (primaryBaseUrl) {
    modelLines.push(`${ind}base_url: ${primaryBaseUrl}`)
  } else if (existingModel?.baseUrlLine) {
    const p = provider.toLowerCase()
    const keep = !entryProvider || p === existingModel.provider.toLowerCase() || BASE_URL_PROVIDERS.has(p)
    if (keep) modelLines.push(existingModel.baseUrlLine)
  }
  if (cascade.length > 1) {
    modelLines.push(`${ind}fallback:`)
    for (const m of cascade.slice(1)) {
      modelLines.push(`${ind}${ind}- ${m}`)
    }
  }
  if (existingModel) modelLines.push(...existingModel.passthrough)

  // Build fallback_providers YAML section (root level). A row that survives
  // the write (same provider + model) carries its unmanaged keys along.
  const fpLines: string[] = []
  if (writeRows) {
    fpLines.push('fallback_providers:')
    for (const fp of fallbackProvidersToWrite) {
      fpLines.push(`  - provider: ${fp.provider}`)
      fpLines.push(`    model: ${fp.model}`)
      if (fp.base_url) {
        fpLines.push(`    base_url: ${fp.base_url}`)
      }
      // Do NOT write api_key from the caller (security). An api_key already in
      // the file for THIS row is the operator's and rides along below.
      const row = existingRows.find((r) => !r.used && r.provider.toLowerCase() === fp.provider.toLowerCase() && r.model === fp.model)
      if (row) {
        row.used = true
        fpLines.push(...row.extra)
      }
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

  if (content === null) {
    // No config.yaml — create one
    const sections = [modelLines.join('\n')]
    if (fpLines.length > 0) sections.push('', fpLines.join('\n'))
    fs.writeFileSync(configPath, sections.join('\n') + '\n', 'utf-8')
    return finish()
  }

  // Replace sections in existing config.yaml
  const updated: string[] = []
  let inModelSection = false
  let modelSectionWritten = false
  let inFpSection = false
  let fpSectionWritten = false

  for (const line of lines) {
    // model: section
    if (MODEL_HEADER.test(line)) {
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
    // With nothing to write ('keep' mode), the existing block is passed
    // through untouched: this writer never deletes fallback_providers.
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
      if (!TOP_LEVEL_KEY.test(line)) continue
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
