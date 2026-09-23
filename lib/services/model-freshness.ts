/**
 * Live provider model lists, cached on disk, fail-soft.
 *
 * fetchLiveModels(provider) returns the provider's current model list in the
 * provider-neutral LiveModel shape (lib/model-versions.ts), cached at
 * DATA_DIR/model-lists/<provider>.json for MODEL_LIST_TTL_MS (default 1h).
 *
 * Fail-soft is the contract: no key, network error, non-200, or an unparseable
 * body all return null. Callers treat null as "no live information" and leave
 * entries unflagged — a provider outage must never make the fleet look retired.
 *
 * Keys come from KeysService (first key for the provider, decrypted in memory,
 * used for one request header). The value is never logged or persisted here.
 *
 * Verified provider facts (2026-09-22):
 *  - OpenRouter GET /api/v1/models is public. Rows carry id, canonical_slug
 *    (embeds YYYYMMDD), created, expiration_date, pricing{prompt,completion}
 *    as USD/token strings. `~vendor/family-latest` alias rows are kept (the
 *    normaliser marks them alias and never picks them).
 *  - Anthropic GET /v1/models needs x-api-key + anthropic-version, paginated
 *    (has_more / last_id → after_id). Rows: id, created_at, display_name.
 *  - Z.ai GET /api/paas/v4/models (Bearer GLM key) — response shape unverified,
 *    so the parser accepts the two plausible shapes and returns null otherwise.
 */
import type { Key } from '@/lib/types'
import type { Storage } from './storage'
import { anthropicEnvVarForValue } from './keys'
import type { LiveModel } from '@/lib/model-versions'

export const LIVE_PROVIDERS = ['openrouter', 'anthropic', 'zai'] as const
export type LiveProvider = (typeof LIVE_PROVIDERS)[number]

export function isLiveProvider(p: string): p is LiveProvider {
  return (LIVE_PROVIDERS as readonly string[]).includes(p)
}

export type LiveModelList = {
  provider: LiveProvider
  /** Unix ms when the list was fetched from the provider. */
  fetchedAt: number
  models: LiveModel[]
}

export type FreshnessKeyLookup = {
  list(): Key[]
  getDecryptedValue(id: string): string | undefined
}

export type FreshnessOptions = {
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1h
const ANTHROPIC_MAX_PAGES = 10

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
export const ZAI_MODELS_URL = 'https://api.z.ai/api/paas/v4/models'

export function cacheFileFor(provider: LiveProvider): string {
  return `model-lists/${provider}.json`
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function asRows(json: unknown): Record<string, unknown>[] | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(json) ? json : null
  if (!arr) return null
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).id === 'string')
}

export function parseOpenRouterModels(json: unknown): LiveModel[] | null {
  const rows = asRows(json)
  if (!rows) return null
  return rows.map((r) => {
    const pricing = r.pricing as Record<string, unknown> | undefined
    const prompt = num(pricing?.prompt)
    const completion = num(pricing?.completion)
    const out: LiveModel = { id: r.id as string }
    if (typeof r.canonical_slug === 'string') out.canonical = r.canonical_slug
    const created = num(r.created)
    if (created !== undefined) out.created = created
    out.expiration = typeof r.expiration_date === 'string' ? r.expiration_date : null
    out.pricing = prompt !== undefined && completion !== undefined ? { prompt, completion } : null
    return out
  })
}

export function parseAnthropicModels(json: unknown): LiveModel[] | null {
  const rows = asRows(json)
  if (!rows) return null
  return rows.map((r) => {
    const out: LiveModel = { id: r.id as string, expiration: null, pricing: null }
    if (typeof r.created_at === 'string') {
      const ms = Date.parse(r.created_at)
      if (Number.isFinite(ms)) out.created = Math.floor(ms / 1000)
    }
    return out
  })
}

/** Z.ai — shape unverified; accept {data:[{id}]} or {models:[{id}]}, else null. */
export function parseZaiModels(json: unknown): LiveModel[] | null {
  const rows = asRows(json)
  if (!rows) return null
  return rows.map((r) => {
    const out: LiveModel = { id: r.id as string, expiration: null, pricing: null }
    const created = num(r.created)
    if (created !== undefined) out.created = created
    return out
  })
}

export class ModelFreshnessService {
  private fetchImpl: typeof fetch
  private now: () => number
  private ttlOverride?: number

  constructor(
    private storage: Storage,
    private keys: FreshnessKeyLookup,
    opts: FreshnessOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = opts.now ?? (() => Date.now())
    this.ttlOverride = opts.ttlMs
  }

  ttlMs(): number {
    if (this.ttlOverride !== undefined) return this.ttlOverride
    const env = parseInt(process.env.MODEL_LIST_TTL_MS ?? '', 10)
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_TTL_MS
  }

  /** Cached list if present and within TTL; otherwise null. */
  readCache(provider: LiveProvider): LiveModelList | null {
    const cached = this.storage.read<LiveModelList | null>(cacheFileFor(provider), null)
    if (!cached || !Array.isArray(cached.models) || typeof cached.fetchedAt !== 'number') return null
    if (this.now() - cached.fetchedAt > this.ttlMs()) return null
    return cached
  }

  /**
   * First usable key for the provider, decrypted. Never logged. An Anthropic
   * key row may hold an OAuth/Bearer token (→ ANTHROPIC_TOKEN); /v1/models
   * takes x-api-key only, so those are skipped and the first real API key
   * (→ ANTHROPIC_API_KEY) is used.
   */
  private keyFor(provider: LiveProvider): string | undefined {
    let keys: Key[]
    try {
      keys = this.keys.list()
    } catch {
      return undefined
    }
    for (const k of keys) {
      if (k.provider !== provider) continue
      let value: string | undefined
      try {
        value = this.keys.getDecryptedValue(k.id) || undefined
      } catch {
        continue
      }
      if (!value) continue
      if (provider === 'anthropic' && anthropicEnvVarForValue(value) !== 'ANTHROPIC_API_KEY') continue
      return value
    }
    return undefined
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
    try {
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json', ...headers } })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  private async fetchFromProvider(provider: LiveProvider): Promise<LiveModel[] | null> {
    switch (provider) {
      case 'openrouter': {
        // Public — no key required.
        return parseOpenRouterModels(await this.getJson(OPENROUTER_MODELS_URL, {}))
      }
      case 'anthropic': {
        const key = this.keyFor('anthropic')
        if (!key) return null
        const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        const all: LiveModel[] = []
        let after: string | undefined
        for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
          const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
          const json = await this.getJson(url, headers)
          const rows = parseAnthropicModels(json)
          if (!rows) return page === 0 ? null : all
          all.push(...rows)
          const j = json as { has_more?: boolean; last_id?: string }
          if (!j.has_more || !j.last_id) break
          after = j.last_id
        }
        return all
      }
      case 'zai': {
        const key = this.keyFor('zai')
        if (!key) return null
        return parseZaiModels(await this.getJson(ZAI_MODELS_URL, { authorization: `Bearer ${key}` }))
      }
    }
  }

  /**
   * The provider's live model list — from the disk cache when fresh, else
   * fetched and cached. null on any failure (no key / network / non-200 /
   * bad body); callers fall back unflagged.
   */
  async fetchLiveModels(provider: LiveProvider, opts: { force?: boolean } = {}): Promise<LiveModelList | null> {
    if (!opts.force) {
      const cached = this.readCache(provider)
      if (cached) return cached
    }
    const models = await this.fetchFromProvider(provider)
    if (!models) return null
    const list: LiveModelList = { provider, fetchedAt: this.now(), models }
    this.storage.write(cacheFileFor(provider), list)
    return list
  }

  /**
   * Retired = absent from the live list, or expiration date already passed.
   * With no live list (null) nothing is ever retired — fail-soft.
   */
  isRetired(id: string, live: LiveModelList | null, today: string = new Date().toISOString().slice(0, 10)): boolean {
    if (!live) return false
    const row = live.models.find((m) => m.id === id)
    if (!row) return true
    return !!row.expiration && row.expiration < today
  }
}
