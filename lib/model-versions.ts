// lib/model-versions.ts
//
// Pure model-id algebra: parse a provider model id into (vendor, family,
// version, tags, routing, snapshot) and find "the newest version of this
// model" in a live provider list.
//
// Ported from the verified prototype (run against the live OpenRouter list,
// 10 worked + 5 adversarial cases). The rules that matter, in order of how
// often they bite:
//
//  * STRICT variant-tag equality. `kimi-k2.7-code` must NOT become `kimi-k3`
//    (tag set {code} ≠ {}); `glm-5.2:free` must NOT become paid `glm-5.3`
//    (routing {free} ≠ {}). A model that differs in tags is a near miss, never
//    a successor.
//  * Unstable rows (-exp/-preview/-thinking/-latest/-beta…) and `~…-latest`
//    alias rows are never successors. Retired rows (expiration_date in the
//    past) are never successors.
//  * Snapshot ordering comes from the canonical slug's YYYYMMDD, never from
//    the absence of a date token: bare `deepseek/deepseek-v4-flash` resolves
//    to the OLDER 0423 preview while `-0731` is newer.
//  * Anthropic encodes the version with dashes on the direct API
//    (`claude-sonnet-4-6`) and with a dot on OpenRouter
//    (`anthropic/claude-sonnet-4.6`). Both parse to version [4, 6].

const SIZE = /^(\d+(\.\d+)?[bt]|a\d+(\.\d+)?b|\d+k|\d+x\d+b)$/
const VER = /^([a-z])?(\d+(\.\d+)*)$/ // 5.3, v4, k2.7, r1, m2.7
const VERTAG = /^(\d+(\.\d+)*)([a-z]+)$/ // 4o, 4.5v
const GLUED = /^([a-z]+)(\d+(\.\d+)*)$/ // qwen3.5, llama3.1, glm4, o3
const DATE8 = /^(20\d{2})(\d{2})(\d{2})$/
const DATE4 = /^\d{4}$/ // MMDD (deepseek) or YYMM (qwen) — ambiguous, keep raw

export const UNSTABLE_TAGS = new Set(['preview', 'exp', 'beta', 'alpha', 'nightly', 'latest', 'experimental'])

// Providers whose ids carry no vendor prefix — the provider IS the vendor.
const VENDOR_IS_PROVIDER = new Set(['openai', 'anthropic', 'google', 'zai', 'moonshot', 'deepseek', 'ollama'])

export type NormalizedModelId = {
  provider: string
  raw: string
  vendor: string
  family: string[]
  version: number[] | null
  tags: Set<string>
  routing: Set<string>
  snapshot: string | null
  alias: boolean
  unstable: boolean
  /** provider|vendor|family — the bucket a successor must share. */
  familyKey: string
  /** sorted tag list — must match exactly for a successor. */
  tagKey: string
}

export function normalizeModelId(provider: string, rawId: string): NormalizedModelId {
  let id = rawId.trim().toLowerCase()
  const out: NormalizedModelId = {
    provider,
    raw: rawId,
    alias: false,
    vendor: '',
    family: [],
    version: null,
    tags: new Set(),
    routing: new Set(),
    snapshot: null,
    unstable: false,
    familyKey: '',
    tagKey: '',
  }
  if (id.startsWith('~')) {
    out.alias = true
    id = id.slice(1)
  }
  // ':' — OpenRouter routing variant, Ollama tag (size/quant), Bedrock ':0' revision
  const colon = id.indexOf(':')
  if (colon >= 0) {
    const suffix = id.slice(colon + 1)
    id = id.slice(0, colon)
    if (provider === 'ollama') {
      for (const t of suffix.split('-')) {
        if (t !== 'latest') out.tags.add(t)
      }
    } else if (provider === 'bedrock') {
      /* ':0' revision — not a variant */
    } else {
      out.routing.add(suffix)
    }
  }
  if (provider === 'bedrock') {
    id = id
      .replace(/^(us|eu|apac|global)\./, '')
      .replace(/^anthropic\./, 'claude/')
      .replace(/-v1$/, '')
    if (!id.startsWith('claude/')) id = 'anthropic/' + id
    else id = 'anthropic/' + id.slice(7)
  }
  if (VENDOR_IS_PROVIDER.has(provider)) {
    out.vendor = provider
  } else {
    const slash = id.indexOf('/')
    if (slash >= 0) {
      out.vendor = id.slice(0, slash)
      id = id.slice(slash + 1)
    } else {
      out.vendor = provider
    }
  }
  const toks = id.split('-').filter(Boolean)
  let seenVersion = false
  const anthropicStyle = provider === 'anthropic' || provider === 'bedrock' || out.vendor === 'anthropic'
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const last = i === toks.length - 1
    let m: RegExpExecArray | null
    if ((m = DATE8.exec(t))) {
      out.snapshot = `${m[1]}-${m[2]}-${m[3]}`
      continue
    }
    // gpt-5-2025-08-07
    if (/^20\d{2}$/.test(t) && /^\d{2}$/.test(toks[i + 1] ?? '') && /^\d{2}$/.test(toks[i + 2] ?? '')) {
      out.snapshot = `${t}-${toks[i + 1]}-${toks[i + 2]}`
      i += 2
      continue
    }
    // gemini-...-preview-12-2025
    if (/^\d{2}$/.test(t) && /^20\d{2}$/.test(toks[i + 1] ?? '') && i === toks.length - 2) {
      out.snapshot = `${toks[i + 1]}-${t}`
      i += 1
      continue
    }
    // 0731 / 2507
    if (last && DATE4.test(t) && seenVersion) {
      out.snapshot = t
      continue
    }
    // 05-20
    if (last && /^\d{2}$/.test(t) && i > 0 && /^\d{2}$/.test(toks[i - 1]) && seenVersion) {
      out.snapshot = toks[i - 1] + '-' + t
      out.tags.delete(toks[i - 1])
      continue
    }
    if (SIZE.test(t)) {
      out.tags.add(t)
      continue
    }
    if (!seenVersion && (m = VER.exec(t))) {
      if (m[1] && m[1] !== 'v') out.family.push(m[1]) // k2.7 → family "kimi k"
      out.version = m[2].split('.').map(Number)
      seenVersion = true
      continue
    }
    // claude-sonnet-4-6 — Anthropic joins version segments with '-'
    if (seenVersion && /^\d{1,2}$/.test(t) && anthropicStyle) {
      out.version!.push(Number(t))
      continue
    }
    if (!seenVersion && (m = VERTAG.exec(t))) {
      out.version = m[1].split('.').map(Number)
      out.tags.add(m[3])
      seenVersion = true
      continue
    }
    if (!seenVersion && (m = GLUED.exec(t))) {
      out.family.push(m[1])
      out.version = m[2].split('.').map(Number)
      seenVersion = true
      continue
    }
    if (seenVersion) {
      out.tags.add(t)
      if (UNSTABLE_TAGS.has(t)) out.unstable = true
    } else {
      out.family.push(t)
    }
  }
  out.familyKey = `${out.provider}|${out.vendor}|${out.family.join(' ')}`
  out.tagKey = [...out.tags].sort().join(',')
  return out
}

/** Provider-independent identity: vendor|family|version|tags|routing. Lets an
 *  OpenRouter id and a direct-API id for the same model compare equal. */
export function modelIdentityKey(n: NormalizedModelId): string {
  return [
    n.vendor,
    n.family.join(' '),
    (n.version ?? []).join('.'),
    n.tagKey,
    [...n.routing].sort().join(','),
  ].join('|')
}

export function compareVersions(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export type LiveModelPricing = { prompt: number; completion: number }

/** One row of a provider's live model list, in provider-neutral shape. */
export type LiveModel = {
  id: string
  /** OpenRouter canonical_slug — embeds the YYYYMMDD release date. */
  canonical?: string
  /** Unix seconds. */
  created?: number
  /** ISO date (YYYY-MM-DD) after which the row is retired, or null. */
  expiration?: string | null
  /** USD per token, or null when the provider does not publish pricing. */
  pricing?: LiveModelPricing | null
}

export type SuccessorKind = 'version' | 'snapshot'

export type SuccessorResult = {
  current: { provider: string; model: string }
  parsed: NormalizedModelId
  successor?: { model: string; canonical?: string; created?: number; pricing?: LiveModelPricing | null }
  kind: SuccessorKind | null
  /** Same family, higher version, but a different tag set — shown, never applied. */
  nearMisses: string[]
}

function sameRouting(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}

/**
 * Find the newest version of `current` in `live`. A version bump (kind
 * 'version') wins over a newer snapshot of the same version (kind 'snapshot');
 * no match → kind null.
 */
export function findSuccessor(
  current: { provider: string; model: string },
  live: LiveModel[],
  today: string = new Date().toISOString().slice(0, 10),
): SuccessorResult {
  const cur = normalizeModelId(current.provider, current.model)
  const rows = live.map((r) => ({ r, n: normalizeModelId(current.provider, r.id) }))
  const same = rows.filter(
    ({ r, n }) =>
      !n.alias &&
      n.familyKey === cur.familyKey &&
      n.tagKey === cur.tagKey &&
      sameRouting(cur.routing, n.routing) &&
      !n.unstable &&
      !(r.expiration && r.expiration < today),
  )
  // OpenRouter: canonical_slug carries the full YYYYMMDD for BOTH bare and
  // dated ids (deepseek-v4-flash → ...-20260423, deepseek-v4-flash-0731 →
  // ...-20260731). Prefer it; fall back to the id's own token, then created.
  const snapOf = ({ r, n }: { r: LiveModel; n: NormalizedModelId }): string =>
    r.canonical?.match(/(20\d{6})$/)?.[1] ?? (n.snapshot ? n.snapshot.replace(/-/g, '') : String(r.created ?? 0))
  const versionBumps = same
    .filter((x) => compareVersions(x.n.version ?? [], cur.version ?? []) > 0)
    .sort(
      (a, b) =>
        compareVersions(b.n.version ?? [], a.n.version ?? []) ||
        (snapOf(b) > snapOf(a) ? 1 : snapOf(b) < snapOf(a) ? -1 : 0) ||
        (b.r.created ?? 0) - (a.r.created ?? 0),
    )
  const curRow = rows.find((x) => x.r.id === current.model)
  const snapBumps = same
    .filter((x) => compareVersions(x.n.version ?? [], cur.version ?? []) === 0 && curRow && snapOf(x) > snapOf(curRow))
    .sort((a, b) => (snapOf(b) > snapOf(a) ? 1 : snapOf(b) < snapOf(a) ? -1 : 0))
  const nearMisses = rows
    .filter(
      ({ n }) =>
        !n.alias &&
        n.familyKey === cur.familyKey &&
        n.tagKey !== cur.tagKey &&
        compareVersions(n.version ?? [], cur.version ?? []) > 0 &&
        !n.unstable,
    )
    .map((x) => x.r.id)
    .slice(0, 6)

  const pick = versionBumps[0] ?? snapBumps[0]
  const kind: SuccessorKind | null = versionBumps[0] ? 'version' : snapBumps[0] ? 'snapshot' : null
  const result: SuccessorResult = { current, parsed: cur, kind, nearMisses }
  if (pick) {
    result.successor = {
      model: pick.r.id,
      canonical: pick.r.canonical,
      created: pick.r.created,
      pricing: pick.r.pricing ?? null,
    }
  }
  return result
}

/**
 * Price ratio of successor over current (the larger of prompt/completion).
 * Undefined when either side has no published pricing. A free current (0)
 * against a paid successor is Infinity — blocked by any finite ceiling.
 */
export function priceRatio(cur: LiveModelPricing | null | undefined, next: LiveModelPricing | null | undefined): number | undefined {
  if (!cur || !next) return undefined
  const ratio = (a: number, b: number): number => (a === 0 ? (b === 0 ? 1 : Infinity) : b / a)
  return Math.max(ratio(cur.prompt, next.prompt), ratio(cur.completion, next.completion))
}
