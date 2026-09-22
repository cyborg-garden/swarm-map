import type { CascadeLibraryEntry, CascadeRecord } from '@/lib/types'
import type { Storage } from './storage'
import type { AuditService } from './audit'
import { yamlPlainScalarError } from '@/lib/model-catalog'

/**
 * Named cascade library.
 *
 * A cascade is a saved, named `fallback_providers` list — an ordered set of
 * {provider, model, base_url?} entries — that can be applied (ported) to any
 * harness via `applyCascadeToHarness` (lib/services/cascade-writer.ts).
 *
 * Persisted at DATA_DIR/cascades.json as a flat array of CascadeRecord.
 *
 * Rules:
 *  - Names are trimmed, 1–64 chars, unique case-insensitively. Lookups
 *    (get/update/rename/remove) match case-insensitively.
 *  - save() with an existing name throws a 409 CascadeLibraryError UNLESS
 *    `overwrite: true`. Overwrite replaces entries + sourceHarness, adopts the
 *    new name's casing, and preserves the original createdAt.
 *  - Entries must be non-empty; each needs a non-empty provider AND model.
 *    Only provider/model/base_url are kept — api_key (or anything else) is
 *    stripped. A cascade is a routing shape, never a credential store.
 *  - Every kept value must be a safe one-line YAML plain scalar (see
 *    yamlPlainScalarError): apply splices them into config.yaml unquoted, so
 *    a newline or ": " in a stored value could rewrite a live agent's config.
 *  - edit(name, {name?, entries?}) is atomic: everything is validated (new
 *    name, clash, entries) before the single write + single audit row.
 */

const CASCADES_FILE = 'cascades.json'
const NAME_MAX = 64

export type CascadeLibraryErrorCode = 'invalid' | 'not_found' | 'conflict'

export class CascadeLibraryError extends Error {
  readonly code: CascadeLibraryErrorCode
  readonly status: 400 | 404 | 409

  constructor(code: CascadeLibraryErrorCode, message: string) {
    super(message)
    this.name = 'CascadeLibraryError'
    this.code = code
    this.status = code === 'invalid' ? 400 : code === 'not_found' ? 404 : 409
  }
}

export type CascadeSaveInput = {
  name: string
  entries: CascadeLibraryEntry[]
  sourceHarness?: string
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CascadeLibraryError('invalid', 'Cascade name is required')
  }
  const name = raw.trim()
  if (name.length === 0) {
    throw new CascadeLibraryError('invalid', 'Cascade name is required')
  }
  if (name.length > NAME_MAX) {
    throw new CascadeLibraryError('invalid', `Cascade name must be at most ${NAME_MAX} characters`)
  }
  return name
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Whitelist-copy entries: keep provider/model/base_url only. api_key must
 * never reach disk (and never be written to config.yaml on apply either).
 */
export function sanitizeCascadeEntries(raw: unknown): CascadeLibraryEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CascadeLibraryError('invalid', 'A cascade needs at least one entry')
  }
  return raw.map((e, i) => {
    const obj = (e ?? {}) as Record<string, unknown>
    const provider = typeof obj.provider === 'string' ? obj.provider.trim() : ''
    const model = typeof obj.model === 'string' ? obj.model.trim() : ''
    if (!provider) {
      throw new CascadeLibraryError('invalid', `Entry ${i + 1}: provider is required`)
    }
    if (!model) {
      throw new CascadeLibraryError('invalid', `Entry ${i + 1}: model is required`)
    }
    const entry: CascadeLibraryEntry = { provider, model }
    if (typeof obj.base_url === 'string' && obj.base_url.trim()) {
      entry.base_url = obj.base_url.trim()
    }
    // Values are written unquoted into config.yaml on apply — refuse anything
    // that is not a safe one-line plain scalar (newline, ": ", " #", …).
    const scalarError =
      yamlPlainScalarError(entry.provider, 'provider') ??
      yamlPlainScalarError(entry.model, 'model') ??
      (entry.base_url ? yamlPlainScalarError(entry.base_url, 'base_url') : null)
    if (scalarError) {
      throw new CascadeLibraryError('invalid', `Entry ${i + 1}: ${scalarError}`)
    }
    return entry
  })
}

export class CascadeLibraryService {
  constructor(
    private storage: Storage,
    private audit: AuditService
  ) {}

  private readAll(): CascadeRecord[] {
    const data = this.storage.read<CascadeRecord[]>(CASCADES_FILE, [])
    return Array.isArray(data) ? data : []
  }

  private writeAll(records: CascadeRecord[]): void {
    this.storage.write(CASCADES_FILE, records)
  }

  list(): CascadeRecord[] {
    return this.readAll().sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
  }

  get(name: string): CascadeRecord | undefined {
    return this.readAll().find((c) => sameName(c.name, name))
  }

  save(input: CascadeSaveInput, opts: { overwrite?: boolean } = {}): CascadeRecord {
    const name = normalizeName(input.name)
    const entries = sanitizeCascadeEntries(input.entries)
    const sourceHarness =
      typeof input.sourceHarness === 'string' && input.sourceHarness.trim()
        ? input.sourceHarness.trim()
        : undefined

    const records = this.readAll()
    const idx = records.findIndex((c) => sameName(c.name, name))
    const now = Date.now()

    let record: CascadeRecord
    if (idx === -1) {
      record = { name, entries, createdAt: now, updatedAt: now }
      if (sourceHarness) record.sourceHarness = sourceHarness
      records.push(record)
    } else if (opts.overwrite) {
      record = { name, entries, createdAt: records[idx].createdAt, updatedAt: now }
      if (sourceHarness) record.sourceHarness = sourceHarness
      records[idx] = record
    } else {
      throw new CascadeLibraryError(
        'conflict',
        `A cascade named "${records[idx].name}" already exists. Pass overwrite:true to replace it.`
      )
    }

    this.writeAll(records)
    this.audit.append({
      who: 'api',
      what: 'cascade:save',
      target: record.name,
      meta: { name: record.name, harness: record.sourceHarness, overwrite: idx !== -1 },
    })
    return record
  }

  update(name: string, entries: CascadeLibraryEntry[]): CascadeRecord {
    return this.edit(name, { entries })
  }

  rename(oldName: string, newName: string): CascadeRecord {
    return this.edit(oldName, { name: newName })
  }

  /**
   * Rename and/or replace entries in ONE validated write. Nothing is written
   * (and nothing audited) unless every part of the patch is valid: the new
   * name normalises, does not clash with another record, and the entries
   * sanitize. A 409 on the rename must never leave replaced entries behind.
   */
  edit(name: string, patch: { name?: string; entries?: CascadeLibraryEntry[] }): CascadeRecord {
    const wantsRename = patch.name !== undefined
    const wantsEntries = patch.entries !== undefined
    if (!wantsRename && !wantsEntries) {
      throw new CascadeLibraryError('invalid', 'Provide "name" (rename) and/or "entries" (replace entries)')
    }

    // Validate everything before touching the records.
    const next = wantsRename ? normalizeName(patch.name) : undefined
    const clean = wantsEntries ? sanitizeCascadeEntries(patch.entries) : undefined

    const records = this.readAll()
    const idx = records.findIndex((c) => sameName(c.name, name))
    if (idx === -1) {
      throw new CascadeLibraryError('not_found', `Cascade "${name}" not found`)
    }
    if (next !== undefined) {
      // Same record, different casing → allowed. Another record → conflict.
      const clash = records.findIndex((c, i) => i !== idx && sameName(c.name, next))
      if (clash !== -1) {
        throw new CascadeLibraryError(
          'conflict',
          `A cascade named "${records[clash].name}" already exists`
        )
      }
    }

    const previous = records[idx].name
    const record: CascadeRecord = { ...records[idx], updatedAt: Date.now() }
    if (next !== undefined) record.name = next
    if (clean !== undefined) record.entries = clean
    records[idx] = record
    this.writeAll(records)

    const meta: Record<string, unknown> = { name: record.name, harness: record.sourceHarness }
    if (next !== undefined) meta.renamedFrom = previous
    this.audit.append({ who: 'api', what: 'cascade:save', target: record.name, meta })
    return record
  }

  remove(name: string): boolean {
    const records = this.readAll()
    const idx = records.findIndex((c) => sameName(c.name, name))
    if (idx === -1) return false
    const [removed] = records.splice(idx, 1)
    this.writeAll(records)
    this.audit.append({
      who: 'api',
      what: 'cascade:delete',
      target: removed.name,
      meta: { name: removed.name, harness: removed.sourceHarness },
    })
    return true
  }
}
