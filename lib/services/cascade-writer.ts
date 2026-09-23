import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { validateCascadeEntries, yamlPlainScalarError, type CascadeEntry } from '@/lib/model-catalog'
import {
  readFallbackProviders,
  readCascade,
  cascadeChain,
  sameCascadeRow,
  guessDataDir,
  readAgentEnvVarNames,
  FALLBACK_PROVIDERS_HEADER,
  MODEL_HEADER,
  ROOT_MODEL_SIBLING,
  FLOW_MAP,
  FLOW_SEQ,
  isTopLevelLine,
  yamlScalar,
  parseFlowPairs,
  parseFlowMaps,
} from '@/lib/services/harness'
import type { FallbackProvider, CascadePrimary } from '@/lib/services/harness'

/**
 * applyCascadeToHarness — the ONE guarded path that writes a model cascade
 * into an agent's config.yaml.
 *
 * Every write to the model: / fallback_providers: sections goes through here:
 * PUT /api/harnesses/:id/models (every body shape), the cascade library's
 * apply route, and the model-update scheduler (automatic and one-click).
 *
 * The input is a CHAIN, modelled the way hermes-agent consumes it (verified
 * against the runtime, 2026-09-23): chain[0] is the PRIMARY and is written to
 * model.provider / model.default (/ model.base_url); chain[1..] are the
 * FALLBACKS and are written as the fallback_providers rows, in order. The
 * runtime tries the primary, then walks fallback_providers row by row,
 * skipping any row equal to the current (provider, model) — so whether a
 * file repeats its primary as row 0 is a per-file CONVENTION, not a drift.
 * The writer PRESERVES it: when the file on disk had model.default repeated
 * as fallback_providers[0] (the shape the HSM editor used to write), the new
 * primary is written as row 0 again, kept in sync with model.default; when
 * it did not (hand-edited / `hermes fallback`), no duplicate is invented. A
 * no-op save over either shape is byte-identical. model.fallback is never
 * read by the runtime, so it is rewritten only when the file already has the
 * key, and never added. Both sections are spliced by LINE, never via a YAML
 * library.
 *
 * Round-trip contract (audit 2026-09): the writer only OWNS
 * model.provider / model.default / model.fallback / model.base_url and each
 * row's provider / model / base_url. Everything else it finds inside those two
 * sections passes through verbatim — model.api_mode, a row's inline api_key or
 * key_env — as long as the row (provider, model) survives the write, OR the
 * entry names the row it replaces via `carryFrom` (a rotation changes the
 * model by construction; without carryFrom every scheduler rotation dropped
 * the row's key_env / api_mode and the agent came back authenticating with
 * the provider's default var). Dropping them silently re-routed a local
 * primary to OpenRouter and killed a proxy credential without a trace in the
 * audit log.
 *
 * Guard: every entry is validated with validateCascadeEntries against the
 * env-var NAMES present in the agent's .env BEFORE anything is written. A
 * provider with no credential → { ok:false, status:400 } and config.yaml is
 * untouched. A bad write crash-loops a live agent, so this is the property
 * every caller relies on.
 *
 * File integrity (r3): a section spans from its header to the last indented
 * (or column-0 list-item) line before the next top-level key. Blank lines and
 * column-0 comments that trail it — the template's "# --- Context compression"
 * banner — belong to the file and are re-emitted verbatim, so a no-op write
 * over generateDefaultConfig() is byte-identical. Line endings follow the
 * file's first line ending (CRLF stays CRLF), the output always ends in
 * exactly one newline, and an appended block is separated by one blank line.
 * Flow-form headers (`fallback_providers: []`, `model: {…}`) are sections too
 * and are replaced in place. A section ends where the readers say it ends
 * (isTopLevelLine, shared with harness.ts): any column-0 line that is not
 * blank, a comment or a list item — not only a `word:` key (r4). A file with more than one top-level model: or
 * fallback_providers: header is refused with 409 `duplicate-sections`: the
 * readers see only the first, so nobody can say what the write would mean.
 *
 * Caller-supplied api_key is never written, whatever the caller passes.
 */

export type CascadeWriteInput = {
  provider: string
  model: string
  base_url?: string
  /**
   * The row on disk whose unmanaged keys (key_env, api_mode, an inline
   * api_key…) this entry inherits when its own (provider, model) is not on
   * disk — set by the scheduler when it rotates a row to its successor.
   * Lookup only; never written; ignored unless its provider is this entry's.
   * Never accepted from an API body — see PUT /api/harnesses/:id/models.
   */
  carryFrom?: { provider: string; model: string }
}

export type CascadeWriteResult =
  | {
      ok: true
      written: {
        provider: string
        primary: string
        /** Model ids of the chain, primary first. */
        models: string[]
        /** The chain read back from disk: primary, then the fallbacks (duplicate row 0 folded away). */
        chain: CascadePrimary[]
        /** The raw fallback_providers rows read back from disk (a duplicate row 0 included). */
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
   * Optimistic precondition: the CHAIN the caller last READ (primary first,
   * as readCascade/cascadeChain report it). When the chain on disk differs
   * (another writer — the scheduler, another tab — got there first) the
   * write is refused with 409 and nothing is touched. Without it a stale
   * editor save silently reverted an applied update and orphaned its
   * tracking key.
   */
  expected?: CascadeWriteInput[]
  /**
   * 'write' (default): fallback_providers is rewritten from chain[1..].
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

const COL0_COMMENT = /^#/
const isBlank = (line: string): boolean => line.trim() === ''
const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * Where a top-level section's BODY ends: one past the last indented or
 * column-0 list-item line before the next top-level line (or EOF). The blank
 * lines and column-0 comments that trail the body belong to the file, not to
 * the section — the writer re-emits them and the parsers never see them. A
 * blank or column-0 comment FOLLOWED by more body is inside the section.
 * "Next top-level line" is the readers' isTopLevelLine, so a line the
 * readers treat as the end of the section can never be swallowed into the
 * body here and deleted on write (r4: `2fa: true`, `foo.bar: 1`, `...`).
 */
function sectionBodyEnd(lines: string[], header: number): number {
  let end = header + 1
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i]
    if (isTopLevelLine(line)) break
    if (isBlank(line) || COL0_COMMENT.test(line)) continue
    end = i + 1
  }
  return end
}

type ExistingModelBlock = {
  /** Indent of the block's keys ('  ' unless the file says otherwise). */
  indent: string
  provider: string
  /** The primary as written (model.default, else model.model, else the scalar `model: <id>`), when present with a value. */
  default?: string
  /**
   * The key the primary is written under. `default` unless the block has a
   * `model:` key and NO `default:` — hermes promotes model.model to
   * model.default at load, so that key IS the primary and is rewritten in
   * place; adding a `default:` beside it would shadow the operator's key.
   */
  primaryKey: 'default' | 'model'
  /** The verbatim header when it was the scalar form (`model: <id>`) — re-emitted as such while nothing else needs the block form. */
  scalarLine?: string
  /** The verbatim `base_url:` line, if any. */
  baseUrlLine?: string
  /** The block had a `fallback:` key. The runtime never reads it; the writer rewrites it only when it was there. */
  hasFallbackKey: boolean
  /** Comment / blank lines between the header and the first key, verbatim. */
  leading: string[]
  /**
   * Comment / blank lines that followed a managed key, by key. They are
   * re-emitted under that key when it is written again (the template's
   * `# fallback: <model>  # uncomment…` hint sits under `default:`), and go
   * with the key when the key goes.
   */
  managedTrail: Record<string, string[]>
  /**
   * Every key of the block in file order. A key the writer does not manage
   * carries its lines verbatim (nested lines and trailing comments
   * included); a managed key carries null and is rewritten in place, so a
   * file with both model.model and model.default round-trips in its own
   * order.
   */
  keys: Array<{ key: string; lines: string[] | null }>
}

/**
 * Read the model: block at lines[start] (body up to `end`); keys the writer
 * does not own are kept verbatim. A flow-form header (`model: {…}`) is
 * expanded to block form so its keys are handled the same way.
 */
function parseExistingModelBlock(lines: string[], start: number, end: number): ExistingModelBlock {
  const flow = lines[start].match(FLOW_MAP)
  const body = flow ? parseFlowPairs(flow[1]).map(([k, v]) => `  ${k}: ${v}`) : lines.slice(start + 1, end)
  const firstKey = body.find((l) => l.trim() && !l.trim().startsWith('#') && indentOf(l) > 0)
  const keyIndent = firstKey ? indentOf(firstKey) : 2
  const out: ExistingModelBlock = { indent: ' '.repeat(keyIndent), provider: '', primaryKey: 'default', hasFallbackKey: false, leading: [], managedTrail: {}, keys: [] }
  // The scalar form: `model: <id>` — the whole section is the header line.
  const scalar = flow ? '' : yamlScalar(lines[start].slice('model:'.length))
  if (scalar) {
    out.scalarLine = lines[start]
    out.default = scalar
  }
  const keyOf = (line: string): string | null => {
    const trimmed = line.trim()
    const isKey = trimmed && !trimmed.startsWith('#') && indentOf(line) === keyIndent && /^[\w-]+:/.test(trimmed)
    return isKey ? trimmed.slice(0, trimmed.indexOf(':')) : null
  }
  // model.model is the primary's key only when there is no model.default
  // WITH A VALUE (as hermes resolves it — an empty `default:` is absent to
  // the reader too, so the writer must not take it for the primary's key).
  const valueOf = (line: string, key: string): string => yamlScalar(line.trim().slice(key.length + 1))
  const keys = body.map(keyOf)
  const hasDefault = body.some((l) => keyOf(l) === 'default' && valueOf(l, 'default') !== '')
  if (!hasDefault && keys.includes('model')) out.primaryKey = 'model'
  let managed: boolean | null = null // null = before the first key
  let managedKey = ''
  for (const line of body) {
    const trimmed = line.trim()
    const key = keyOf(line)
    if (key !== null) {
      managed = MANAGED_MODEL_KEYS.has(key) || key === out.primaryKey
      managedKey = managed ? key : ''
      if (key === 'provider') out.provider = valueOf(line, key)
      if (key === out.primaryKey) {
        const v = valueOf(line, key)
        if (v) out.default = v
      }
      if (key === 'base_url') out.baseUrlLine = line
      if (key === 'fallback') out.hasFallbackKey = true
      out.keys.push({ key, lines: managed ? null : [line] })
      continue
    }
    if (managed === null) out.leading.push(line)
    else if (managed === false) out.keys[out.keys.length - 1].lines!.push(line)
    else if (!trimmed || trimmed.startsWith('#')) (out.managedTrail[managedKey] ??= []).push(line)
  }
  return out
}

type ExistingRow = { provider: string; model: string; hasBaseUrl: boolean; extra: string[]; used: boolean }

/**
 * Read the rows of the fallback_providers: block at lines[start] (body up to
 * `end`) with every line the reader does not model (api_key, key_env,
 * api_mode, nested maps…) kept verbatim and re-indented to the shape this
 * writer emits (4-space fields). A flow-form header carries its rows inline.
 */
function parseExistingRows(lines: string[], start: number, end: number): ExistingRow[] {
  const rows: ExistingRow[] = []
  const flow = lines[start].match(FLOW_SEQ)
  if (flow) {
    for (const pairs of parseFlowMaps(flow[1])) {
      const get = (k: string) => pairs.find(([key]) => key === k)
      const prov = get('provider')
      const model = get('model')
      if (!prov || !model) continue
      const extra = pairs.filter(([key]) => !MANAGED_ROW_KEYS.has(key)).map(([key, raw]) => `    ${key}: ${raw}`)
      rows.push({ provider: yamlScalar(prov[1]), model: yamlScalar(model[1]), hasBaseUrl: !!get('base_url'), extra, used: false })
    }
    return rows
  }
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
      rows.push({ provider: yamlScalar(prov.lines[0].trim().slice('provider:'.length)), model: yamlScalar(model.lines[0].trim().slice('model:'.length)), hasBaseUrl: !!get('base_url'), extra, used: false })
    }
    cur = null
  }
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      flush()
      const dash = line.indexOf('-')
      const rest = line.slice(dash + 1)
      const fieldIndent = dash + 1 + (rest.length - rest.trimStart().length)
      cur = { fields: [], fieldIndent }
      const item = rest.trim()
      const flowItem = item.match(/^\{(.*)\}$/)
      if (flowItem) {
        for (const [key, raw] of parseFlowPairs(flowItem[1])) {
          cur.fields.push({ key, lines: [' '.repeat(fieldIndent) + `${key}: ${raw}`] })
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
  chain: CascadeWriteInput[],
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
  const chainToWrite: CascadeWriteInput[] = (chain ?? []).map((fp) => {
    const e: CascadeWriteInput = { provider: (fp.provider ?? '').trim(), model: (fp.model ?? '').trim() }
    if (fp.base_url && fp.base_url.trim()) e.base_url = fp.base_url.trim()
    if (fp.carryFrom?.provider && fp.carryFrom?.model) {
      e.carryFrom = { provider: fp.carryFrom.provider.trim(), model: fp.carryFrom.model.trim() }
    }
    return e
  })

  // chain[0] is the primary: model.provider / model.default come from it.
  const primaryEntry = chainToWrite[0]
  const entryProvider = primaryEntry?.provider || ''
  const cascade = chainToWrite.map((fp) => fp.model)
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
  let content: string | null
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    content = null
  }
  // Line endings follow the file's first line ending; a CRLF file stays CRLF
  // on every line the writer emits, and the readers (which split on '\n' and
  // trim) never see the difference.
  const firstNl = content?.indexOf('\n') ?? -1
  const eol = firstNl > 0 && content![firstNl - 1] === '\r' ? '\r\n' : '\n'
  const lines = content === null ? [] : content.split('\n').map((l) => (eol === '\r\n' && l.endsWith('\r') ? l.slice(0, -1) : l))

  // Exactly one section of each kind, or none. The readers only ever see the
  // first; silently picking one would rewrite a file whose effective cascade
  // nobody can name.
  const modelHeaders = lines.flatMap((l, i) => (MODEL_HEADER.test(l) ? [i] : []))
  const fpHeaders = lines.flatMap((l, i) => (FALLBACK_PROVIDERS_HEADER.test(l) ? [i] : []))
  if (modelHeaders.length > 1 || fpHeaders.length > 1) {
    const dupes = [
      ...(modelHeaders.length > 1 ? [`${modelHeaders.length}× top-level model: (lines ${modelHeaders.map((i) => i + 1).join(', ')})`] : []),
      ...(fpHeaders.length > 1 ? [`${fpHeaders.length}× top-level fallback_providers: (lines ${fpHeaders.map((i) => i + 1).join(', ')})`] : []),
    ]
    return {
      ok: false,
      status: 409,
      error: `duplicate-sections: config.yaml has ${dupes.join(' and ')}; remove the duplicate by hand before saving`,
    }
  }
  const modelStart = modelHeaders[0] ?? -1
  const fpStart = fpHeaders[0] ?? -1
  const modelEnd = modelStart >= 0 ? sectionBodyEnd(lines, modelStart) : -1
  const fpEnd = fpStart >= 0 ? sectionBodyEnd(lines, fpStart) : -1
  const existingModel = modelStart >= 0 ? parseExistingModelBlock(lines, modelStart, modelEnd) : null
  const existingRows = writeRows && fpStart >= 0 ? parseExistingRows(lines, fpStart, fpEnd) : []

  // Root-level `provider:` / `base_url:` / `api_base:` lines beside model:
  // (the hermes "new format" scalar `model: <id>` is usually written this
  // way). The runtime merges each onto the primary when the block lacks the
  // key — so the primary ON DISK is what the readers report, root included.
  // The lines stay where they are while the primary's provider and base_url
  // do not change (a no-op save is byte-identical); the moment chain[0]
  // changes either, they move into the model: block and the root lines go —
  // a root base_url that belonged to the old (local) provider must never be
  // merged onto the cloud primary that replaced it.
  const rootSiblings = lines.flatMap((l, i) => {
    const m = l.match(ROOT_MODEL_SIBLING)
    return m ? [{ index: i, key: m[1], value: yamlScalar(m[2]) }] : []
  })
  const rootValue = (key: string): string => rootSiblings.find((r) => r.key === key)?.value ?? ''
  const rootProvider = existingModel?.provider ? '' : rootValue('provider')
  const rootBaseUrl = existingModel?.baseUrlLine ? '' : rootValue('base_url') || rootValue('api_base')
  const diskProvider = existingModel?.provider || rootProvider
  const diskBaseUrl = existingModel?.baseUrlLine ? yamlScalar(existingModel.baseUrlLine.trim().slice('base_url:'.length)) : rootBaseUrl

  // The file's convention: did it repeat model.default as fallback_providers[0]?
  // (Compared comment-stripped, provider case-insensitive.) Preserved on
  // write, never invented, never removed.
  const primaryOnDisk = existingModel?.default ? { provider: diskProvider, model: existingModel.default } : null
  const duplicateOnDisk = !!primaryOnDisk && existingRows.length > 0 && sameCascadeRow(existingRows[0], primaryOnDisk)

  // The row on disk each entry inherits its unmanaged keys from: the row
  // `carryFrom` names when the entry has one (a rotation — looked up FIRST,
  // else a rotation onto a model that is already a row stole that row's
  // credential and dropped its own), else its own (provider, model). First
  // come, first served — a row is carried at most once. carryFrom is honoured
  // only within the entry's own provider: a row's key_env / api_mode never
  // move onto another provider's row, whoever asks. Under the duplicate
  // convention the primary's row is fallback_providers[0], so its extras
  // follow the primary the same way.
  const sameKey = (r: ExistingRow, provider: string, model: string): boolean =>
    !r.used && r.provider.toLowerCase() === provider.toLowerCase() && r.model === model
  const carriedRows: Array<ExistingRow | undefined> = chainToWrite.map((fp) => {
    const carry = fp.carryFrom && fp.carryFrom.provider.toLowerCase() === fp.provider.toLowerCase() ? fp.carryFrom : undefined
    const row =
      (carry ? existingRows.find((r) => sameKey(r, carry.provider, carry.model)) : undefined) ??
      existingRows.find((r) => sameKey(r, fp.provider, fp.model))
    if (row) row.used = true
    return row
  })

  const presentEnvVars = readAgentEnvVarNames(dataDir)
  // A row that carries its own credential (inline api_key, or a key_env whose
  // var IS present) does not authenticate with the provider's default var —
  // checking that var refused a perfectly serviceable rotation.
  const hasOwnCredential = (row: ExistingRow | undefined): boolean =>
    !!row &&
    row.extra.some((l) => {
      const m = l.match(/^\s*(api_key|key_env):\s*(\S.*)$/)
      if (!m) return false
      if (m[1] === 'api_key') return true
      return presentEnvVars.has(yamlScalar(m[2]))
    })
  const entriesToValidate: CascadeEntry[] = chainToWrite.map((fp, i) => ({
    provider: fp.provider,
    model: fp.model,
    ...(hasOwnCredential(carriedRows[i]) ? { ownCredential: true } : {}),
  }))

  const modelErrors = validateCascadeEntries(entriesToValidate, presentEnvVars)
  // validateCascadeEntries covers provider/model; base_url is spliced unquoted
  // too, so it gets the same plain-scalar check here.
  for (const fp of chainToWrite) {
    if (fp.base_url) {
      const err = yamlPlainScalarError(fp.base_url, `base_url for "${fp.model}"`)
      if (err) modelErrors.push(err)
    }
  }
  if (modelErrors.length > 0) {
    return { ok: false, status: 400, error: `Invalid model cascade: ${modelErrors.join('; ')}` }
  }

  // Optimistic precondition against the chain the caller last read.
  if (opts.expected) {
    const current = cascadeChain(readCascade(dataDir))
    if (!sameRows(current, opts.expected)) {
      return { ok: false, status: 409, error: 'The model cascade changed since it was read; reload and try again' }
    }
  }

  // Effective model.provider: the primary's, else whatever the file says
  // (a legacy body with no provider must not delete the line).
  const provider = entryProvider || diskProvider || ''
  const ind = existingModel?.indent ?? '  '
  const primaryBaseUrl = primaryEntry?.base_url
  // Do the root siblings move into the block on this write? Only when the
  // primary's provider or base_url changes; a rotation of the model id alone
  // leaves the file's shape alone.
  const providerChanged = !!entryProvider && entryProvider.toLowerCase() !== diskProvider.toLowerCase()
  const baseUrlChanged = primaryBaseUrl !== undefined && primaryBaseUrl !== diskBaseUrl
  const migrateRoot = rootSiblings.length > 0 && (providerChanged || baseUrlChanged)
  // A key the root supplies and this write leaves there is not repeated in the block.
  const providerStaysAtRoot = !!rootProvider && !migrateRoot
  const baseUrlStaysAtRoot = !!rootBaseUrl && !migrateRoot

  // Build the model section of config.yaml. Managed keys come from the
  // chain; every other key of the existing block passes through verbatim,
  // in its own place among them. Comment / blank lines the file had under a
  // managed key ride with it.
  const trail = (key: string): string[] => existingModel?.managedTrail[key] ?? []
  const managedOut: Record<string, string[]> = {}
  if (provider && !providerStaysAtRoot) managedOut.provider = [`${ind}provider: ${provider}`, ...trail('provider')]
  // The primary goes under the key the file already uses for it (model.model
  // when the block has that and no default — see ExistingModelBlock.primaryKey).
  const primaryKey = existingModel?.primaryKey ?? 'default'
  managedOut[primaryKey] = [`${ind}${primaryKey}: ${primary}`, ...trail(primaryKey)]
  // model.base_url follows the primary. With no base_url on it, the existing
  // value stays only while it can still be meant for this primary: the
  // provider is unchanged / unspecified, or is one that is addressed by URL.
  // A local ollama URL must not leak onto a cloud primary that replaced it.
  if (primaryBaseUrl) {
    if (!baseUrlStaysAtRoot) managedOut.base_url = [`${ind}base_url: ${primaryBaseUrl}`, ...trail('base_url')]
  } else if (existingModel?.baseUrlLine || (rootBaseUrl && migrateRoot)) {
    const p = provider.toLowerCase()
    const keep = !entryProvider || p === diskProvider.toLowerCase() || BASE_URL_PROVIDERS.has(p)
    if (keep) managedOut.base_url = [existingModel?.baseUrlLine ?? `${ind}base_url: ${rootBaseUrl}`, ...trail('base_url')]
  }
  // model.fallback: the runtime never reads it. A file that has the key gets
  // it rewritten from the fallbacks (dropped when there are none); a file
  // without it does not gain one.
  if (existingModel?.hasFallbackKey && cascade.length > 1) {
    managedOut.fallback = [`${ind}fallback:`, ...cascade.slice(1).map((m) => `${ind}${ind}- ${m}`), ...trail('fallback')]
  }
  const modelLines = ['model:', ...(existingModel?.leading ?? [])]
  // Managed keys keep the position they had on disk; one the file did not
  // have goes in front of the first on-disk managed key that follows it in
  // the canonical order (provider, primary, base_url, fallback), else last.
  const CANONICAL = ['provider', primaryKey, 'base_url', 'fallback']
  const emitted = new Set<string>()
  const emit = (key: string) => {
    if (emitted.has(key)) return
    emitted.add(key)
    modelLines.push(...(managedOut[key] ?? []))
  }
  const managedOnDisk = new Set((existingModel?.keys ?? []).filter((k) => k.lines === null).map((k) => k.key))
  for (const k of existingModel?.keys ?? []) {
    if (k.lines !== null) {
      modelLines.push(...k.lines)
      continue
    }
    for (const c of CANONICAL) {
      if (c === k.key) break
      if (!managedOnDisk.has(c)) emit(c)
    }
    emit(k.key)
  }
  for (const c of CANONICAL) emit(c)
  // The scalar form (`model: <id>`) stays scalar while the block would hold
  // nothing but the primary: an unchanged primary re-emits the header
  // verbatim, a rotated one keeps the shape. A provider or base_url on the
  // primary needs the block form, so the section upgrades to it.
  if (existingModel?.scalarLine !== undefined && modelLines.length === 2 && modelLines[1] === `${ind}default: ${primary}`) {
    modelLines.splice(0, 2, primary === existingModel.default ? existingModel.scalarLine : `model: ${primary}`)
  }

  // Build the fallback_providers YAML section (root level): chain[1..], with
  // the primary repeated as row 0 only when the file already did that. A row
  // that survives the write (same provider + model), or that an entry names
  // via carryFrom, carries its unmanaged keys along. An UNCHANGED primary's
  // duplicate row keeps whether it carried a base_url (a no-op save must not
  // add one); a new primary's duplicate row takes the primary's base_url.
  const fpLines: string[] = []
  if (writeRows) {
    type RowToWrite = { row: CascadeWriteInput; carried: ExistingRow | undefined; base_url?: string }
    const rowsToWrite: RowToWrite[] = chainToWrite.slice(1).map((row, i) => ({ row, carried: carriedRows[i + 1], base_url: row.base_url }))
    if (duplicateOnDisk && primaryEntry) {
      const primaryUnchanged = !!primaryOnDisk && sameCascadeRow(primaryEntry, primaryOnDisk)
      rowsToWrite.unshift({
        row: primaryEntry,
        carried: carriedRows[0],
        base_url: primaryUnchanged && !existingRows[0].hasBaseUrl ? undefined : primaryEntry.base_url,
      })
    }
    if (rowsToWrite.length > 0) {
      fpLines.push('fallback_providers:')
      for (const { row, carried, base_url } of rowsToWrite) {
        fpLines.push(`  - provider: ${row.provider}`)
        fpLines.push(`    model: ${row.model}`)
        if (base_url) {
          fpLines.push(`    base_url: ${base_url}`)
        }
        // Do NOT write api_key from the caller (security). An api_key already in
        // the file for THIS row is the operator's and rides along below.
        if (carried) fpLines.push(...carried.extra)
      }
    } else if (fpStart >= 0) {
      // No fallbacks: the section stays (empty) rather than vanishing —
      // deleting a top-level key the operator wrote is not this writer's call.
      fpLines.push('fallback_providers: []')
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
    const respChain = cascadeChain(readCascade(dataDir))
    return { ok: true, written: { provider, primary, models: cascade, chain: respChain, fallbackProviders: respFp } }
  }

  // Replace each section in place: header through the end of its body. What
  // trails the body (blank lines, column-0 comments) and everything outside
  // the two sections is copied through verbatim. In 'keep' mode the
  // fallback_providers block on disk is one of those verbatim runs.
  const splices = [
    ...(modelStart >= 0 ? [{ start: modelStart, end: modelEnd, lines: modelLines }] : []),
    ...(fpStart >= 0 && fpLines.length > 0 ? [{ start: fpStart, end: fpEnd, lines: fpLines }] : []),
    // The root siblings, once moved into the block, are deleted line by line.
    ...(migrateRoot ? rootSiblings.map((r) => ({ start: r.index, end: r.index + 1, lines: [] as string[] })) : []),
  ].sort((a, b) => a.start - b.start)
  const updated: string[] = []
  let cursor = 0
  for (const sp of splices) {
    updated.push(...lines.slice(cursor, sp.start), ...sp.lines)
    cursor = sp.end
  }
  updated.push(...lines.slice(cursor))

  // A section the file did not have is appended after ONE blank line; the
  // file always ends in exactly one newline (an appended block after a file
  // that already ended in a blank line used to land two blank lines deep).
  // A fallback_providers block with nothing in it is not appended.
  const trimTrailingBlanks = () => {
    while (updated.length && isBlank(updated[updated.length - 1])) updated.pop()
  }
  const append = (block: string[]) => {
    trimTrailingBlanks()
    if (updated.length) updated.push('')
    updated.push(...block)
  }
  if (modelStart < 0) append(modelLines)
  if (fpStart < 0 && fpLines.length > 0) append(fpLines)
  trimTrailingBlanks()

  fs.writeFileSync(configPath, updated.join(eol) + eol, 'utf-8')
  return finish()
}
