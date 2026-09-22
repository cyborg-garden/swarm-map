/**
 * Model freshness + "track the newest version of this model".
 *
 * Same shape as db-snapshot-scheduler.ts: an unref'd timer registered from
 * instrumentation.ts, HMR-guarded on globalThis, MODEL_UPDATE_INTERVAL_MS
 * overrides the settings interval.
 *
 * checkModelUpdates() walks every non-Letta harness's fallback_providers,
 * fetches each provider's live list once (cached, fail-soft), and writes a
 * report to DATA_DIR/model-updates.json: per entry — tracked?, retired?,
 * successor + kind + priceRatio. That report is what the UI and the manual
 * apply route read.
 *
 * In 'apply' mode a tracked entry is rotated to its successor ONLY when every
 * guard passes (see evaluateApply) — and the rewrite goes through
 * applyCascadeToHarness, the ONE validated write path the cascade editor and
 * the cascade library use (validate → render → splice → write → overlay). A
 * refused write ({ ok: false }) means nothing was written and nothing is
 * restarted; the refusal is audited as a blocked event.
 *
 * Never applied: ollama (no upstream notion of "newer"), bedrock, custom;
 * snapshot-only bumps (notify only); unstable successors; anything over the
 * price ceiling, or with no pricing to check it against; a harness with a
 * restart already in flight; a config whose model.default is not
 * fallback_providers[0] (the writer refuses: the rewrite would switch the
 * primary).
 *
 * A row the provider has REMOVED (retired by absence — the case auto-update
 * exists for) has no live pricing to check the ceiling against. Its last
 * known pricing is taken from the previous persisted report instead; with
 * none on record the block reason is 'retired-current-no-pricing', distinct
 * from a pricing outage, so the UI can surface it as urgent.
 */
import type { Harness, ModelAutoUpdateSettings, RestartMode } from '@/lib/types'
import { findSuccessor, normalizeModelId, priceRatio, type SuccessorKind, type LiveModelPricing } from '@/lib/model-versions'
import { readFallbackProviders, guessDataDir, type FallbackProvider } from './harness'
import { applyCascadeToHarness, type CascadeWriteInput } from './cascade-writer'
import { isRestarting as trackerIsRestarting } from './restart-tracker'
import { isLiveProvider, type LiveModelList, type LiveProvider } from './model-freshness'

export const MODEL_UPDATES_FILE = 'model-updates.json'
export const NEVER_APPLY_PROVIDERS = new Set(['ollama', 'bedrock', 'custom'])

/** The agent data dir a harness's config.yaml lives in (same rule as the writer). */
export function harnessDataDir(harness: Pick<Harness, 'name' | 'serviceName'>): string {
  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  return guessDataDir(harness.serviceName ?? harness.name, containerName)
}

/** The modelTracking key for a cascade entry: "provider/model". */
export function trackingKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

export type ModelUpdateEntry = {
  provider: string
  model: string
  tracked: boolean
  retired: boolean
  successor?: string
  kind?: SuccessorKind
  priceRatio?: number
  /** The current row's pricing (live, or last known when the row is gone). */
  pricing?: LiveModelPricing
  nearMisses?: string[]
  /** Set in apply mode: the entry was rotated to `successor` this run. */
  applied?: boolean
  /** Set in apply mode when a successor exists but a guard declined it. */
  blocked?: string
}

export type ModelUpdateReport = {
  checkedAt: number
  enabled: boolean
  mode: ModelAutoUpdateSettings['mode']
  harnesses: Array<{
    id: string
    name: string
    entries: ModelUpdateEntry[]
    /** modelTracking keys that match no current fallback_providers row (a stale save wrote over a rotated entry). */
    orphanedTracking?: string[]
  }>
}

export type SchedulerDeps = {
  harness: {
    list(): Harness[]
    get(id: string): Harness | undefined
    updateConfig(id: string, partial: Partial<Harness>): unknown
    restart(id: string, mode: RestartMode): void
  }
  freshness: { fetchLiveModels(provider: LiveProvider): Promise<LiveModelList | null>; isRetired(id: string, live: LiveModelList | null, today?: string): boolean }
  config: { getModelAutoUpdate(): ModelAutoUpdateSettings }
  audit: { append(input: { who: string; what: string; target: string; meta?: Record<string, unknown> }): void }
  storage: { write<T>(file: string, data: T): void; read<T>(file: string, def: T): T }
  dataDirFor: (h: Harness) => string
  isRestarting: (id: string) => boolean
  today?: string
}

async function defaultDeps(): Promise<SchedulerDeps> {
  const { services } = await import('@/lib/services')
  return {
    harness: services.harness,
    freshness: services.modelFreshness,
    config: services.config,
    audit: services.audit,
    storage: services.storage,
    dataDirFor: harnessDataDir,
    isRestarting: trackerIsRestarting,
  }
}

function isTracked(h: Harness, provider: string, model: string): boolean {
  return h.modelTracking?.[trackingKey(provider, model)] === true
}

/** Fetch each live provider at most once per run; null stays null. */
function liveCache(deps: SchedulerDeps) {
  const cache = new Map<LiveProvider, Promise<LiveModelList | null>>()
  return (provider: string): Promise<LiveModelList | null> => {
    const p = provider.trim().toLowerCase()
    if (!isLiveProvider(p)) return Promise.resolve(null)
    let hit = cache.get(p)
    if (!hit) {
      hit = deps.freshness.fetchLiveModels(p).catch(() => null)
      cache.set(p, hit)
    }
    return hit
  }
}

type Candidate = {
  entry: ModelUpdateEntry
  successorPricing?: LiveModelPricing | null
  unstable: boolean
}

type PriorPricing = (harnessId: string, provider: string, model: string) => LiveModelPricing | undefined

const sameId = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Last known pricing per (harness, provider, model) from the previous persisted report. */
function priorPricingFrom(deps: SchedulerDeps): PriorPricing {
  const prev = readModelUpdateReport(deps.storage)
  return (harnessId, provider, model) =>
    prev?.harnesses
      .find((h) => h.id === harnessId)
      ?.entries.find((e) => sameId(e.provider, provider) && sameId(e.model, model))?.pricing
}

async function evaluateEntry(
  h: Harness,
  fp: FallbackProvider,
  getLive: (provider: string) => Promise<LiveModelList | null>,
  deps: SchedulerDeps,
  prior: PriorPricing,
): Promise<Candidate> {
  const provider = fp.provider.trim().toLowerCase()
  const entry: ModelUpdateEntry = {
    provider: fp.provider,
    model: fp.model,
    tracked: isTracked(h, fp.provider, fp.model),
    retired: false,
  }
  // Ollama has no upstream notion of "newer" — never flagged, never tracked.
  if (provider === 'ollama') return { entry, unstable: false }
  const live = await getLive(provider)
  if (!live) return { entry, unstable: false }
  entry.retired = deps.freshness.isRetired(fp.model, live, deps.today)
  // The current row's pricing: live when the provider still lists it (looked
  // up the way ids are normalized — trimmed, case-insensitive), else the last
  // report's. Recorded on every entry so a later run can still price a row
  // the provider has since removed.
  const curRow = live.models.find((m) => sameId(m.id, fp.model))
  const curPricing = curRow ? curRow.pricing ?? undefined : prior(h.id, fp.provider, fp.model)
  if (curPricing) entry.pricing = curPricing
  const found = findSuccessor({ provider, model: fp.model }, live.models, deps.today)
  if (found.nearMisses.length) entry.nearMisses = found.nearMisses
  if (!found.successor || !found.kind) return { entry, unstable: false }
  entry.successor = found.successor.model
  entry.kind = found.kind
  const ratio = priceRatio(curPricing, found.successor.pricing)
  if (ratio !== undefined) entry.priceRatio = ratio
  const unstable = normalizeModelId(provider, found.successor.model).unstable
  return { entry, successorPricing: found.successor.pricing, unstable }
}

export type ApplyGuardInput = {
  harness: Harness
  entry: ModelUpdateEntry
  unstable: boolean
  settings: ModelAutoUpdateSettings
  /** true for the scheduler (tracked + version-only); false for a human's one-click apply. */
  automatic: boolean
  isRestarting: (id: string) => boolean
}

/** The guard list. Returns the reason an apply is declined, or null when it may proceed. */
export function evaluateApply(input: ApplyGuardInput): string | null {
  const { harness, entry, unstable, settings, automatic } = input
  const provider = entry.provider.trim().toLowerCase()
  if (!entry.successor || !entry.kind) return 'no-successor'
  if (NEVER_APPLY_PROVIDERS.has(provider)) return `provider-not-auto-updatable:${provider}`
  if (automatic && !entry.tracked) return 'untracked'
  if (automatic && entry.kind !== 'version') return `notify-only:${entry.kind}`
  if (unstable) return 'unstable-successor'
  // No pricing (direct Anthropic / Z.ai publish none) → the ceiling cannot be
  // checked, so the scheduler never rotates unattended. A human's one-click
  // apply has seen the report and may proceed. A current row the provider
  // has removed, with no last-known pricing either, gets its own reason:
  // "your model is gone" is not a pricing outage.
  if (automatic && entry.priceRatio === undefined) return entry.retired && !entry.pricing ? 'retired-current-no-pricing' : 'price-unknown'
  if (entry.priceRatio !== undefined && entry.priceRatio > settings.maxPriceMultiplier) {
    return `price-ceiling:${entry.priceRatio.toFixed(2)}>${settings.maxPriceMultiplier}`
  }
  if (input.isRestarting(harness.id)) return 'restart-in-flight'
  return null
}

type Substitution = { from: string; to: string; provider: string; priceRatio?: number }

/**
 * The report's `blocked` reason for a writer refusal. A refusal that names
 * a file-shape problem the operator has to fix by hand (duplicate top-level
 * sections) is reported by its bare code, like the scheduler's own guards;
 * everything else is a validation message.
 */
const blockedReason = (error: string): string => (/^duplicate-sections\b/.test(error) ? 'duplicate-sections' : `validation:${error}`)

/**
 * Rewrite one harness's cascade with the substitutions applied, through
 * applyCascadeToHarness (the single validated write path); rotate the
 * tracking keys; quick-restart; audit each substitution. When the writer
 * refuses ({ ok: false } — a provider with no credential, an unsafe YAML
 * scalar, an unknown harness) nothing was written: no restart, no tracking
 * change, and a 'cascade:auto-update:blocked' audit row per substitution.
 */
function performSubstitutions(
  h: Harness,
  subs: Substitution[],
  who: 'api' | 'scheduler',
  deps: SchedulerDeps,
): { ok: true } | { ok: false; status: number; error: string } {
  const dataDir = deps.dataDirFor(h)
  const current = readFallbackProviders(dataDir)
  // A rotated row names the row it replaces (carryFrom) so its key_env /
  // api_mode / inline api_key ride along onto the successor — the writer
  // only matches extras by (provider, model) otherwise, and a rotation
  // changes the model by construction. The writer's primary-mismatch guard
  // (model.default ≠ fallback_providers[0]) refuses the whole write with
  // 409; that lands in the blocked-audit path below.
  const byFrom = new Map(subs.map((s) => [s.from, s]))
  const next: CascadeWriteInput[] = current.map((fp) => {
    const s = byFrom.get(fp.model)
    if (!s || fp.provider.trim().toLowerCase() !== s.provider.trim().toLowerCase()) return { provider: fp.provider, model: fp.model, base_url: fp.base_url }
    return { provider: fp.provider, model: s.to, base_url: fp.base_url, carryFrom: { provider: fp.provider, model: fp.model } }
  })
  if (next.every((fp, i) => fp.model === current[i]?.model)) {
    return { ok: false, status: 404, error: 'entry not present in fallback_providers' }
  }
  const result = applyCascadeToHarness(h.id, next, { who })
  if (!result.ok) {
    for (const s of subs) {
      deps.audit.append({
        who,
        what: 'cascade:auto-update:blocked',
        target: h.name,
        meta: { harness: h.id, from: s.from, to: s.to, provider: s.provider, reason: result.error },
      })
    }
    return { ok: false, status: result.status, error: result.error }
  }
  const cascade = result.written.models

  const tracking: Record<string, boolean> = { ...(h.modelTracking ?? {}) }
  for (const s of subs) {
    const oldKey = trackingKey(s.provider, s.from)
    const wasTracked = tracking[oldKey] === true
    delete tracking[oldKey]
    if (wasTracked) tracking[trackingKey(s.provider, s.to)] = true
  }
  deps.harness.updateConfig(h.id, { models: cascade, modelTracking: tracking })

  let restartError: string | undefined
  try {
    deps.harness.restart(h.id, 'quick')
  } catch (err) {
    restartError = err instanceof Error ? err.message : String(err)
  }
  for (const s of subs) {
    deps.audit.append({
      who,
      what: 'cascade:auto-update',
      target: h.name,
      meta: { harness: h.id, from: s.from, to: s.to, provider: s.provider, priceRatio: s.priceRatio, ...(restartError ? { restartError } : {}) },
    })
  }
  return { ok: true }
}

function eligibleHarnesses(deps: SchedulerDeps): Harness[] {
  return deps.harness.list().filter((h) => h.runtime !== 'letta' && h.runtime !== 'letta-server')
}

/**
 * Build the freshness report for the whole fleet; in apply mode also rotate
 * every tracked entry that passes the guards. Persists the report.
 */
export async function checkModelUpdates(
  depsIn?: SchedulerDeps,
  opts: { apply?: boolean } = {},
): Promise<ModelUpdateReport> {
  const deps = depsIn ?? (await defaultDeps())
  const settings = deps.config.getModelAutoUpdate()
  const applyMode = opts.apply ?? (settings.enabled && settings.mode === 'apply')
  const getLive = liveCache(deps)
  const prior = priorPricingFrom(deps)
  const report: ModelUpdateReport = { checkedAt: Date.now(), enabled: settings.enabled, mode: settings.mode, harnesses: [] }

  for (const h of eligibleHarnesses(deps)) {
    const fps = readFallbackProviders(deps.dataDirFor(h))
    if (fps.length === 0) continue
    const candidates: Candidate[] = []
    for (const fp of fps) candidates.push(await evaluateEntry(h, fp, getLive, deps, prior))

    if (applyMode) {
      const subs: Substitution[] = []
      const subCandidates: Candidate[] = []
      for (const c of candidates) {
        if (!c.entry.successor) continue
        const reason = evaluateApply({ harness: h, entry: c.entry, unstable: c.unstable, settings, automatic: true, isRestarting: deps.isRestarting })
        if (reason) {
          c.entry.blocked = reason
          continue
        }
        subs.push({ from: c.entry.model, to: c.entry.successor, provider: c.entry.provider, priceRatio: c.entry.priceRatio })
        subCandidates.push(c)
      }
      if (subs.length > 0) {
        const done = performSubstitutions(h, subs, 'scheduler', deps)
        for (const c of subCandidates) {
          if (done.ok) c.entry.applied = true
          else c.entry.blocked = blockedReason(done.error)
        }
      }
    }
    const orphanedTracking = Object.keys(h.modelTracking ?? {}).filter(
      (key) => h.modelTracking?.[key] === true && !fps.some((fp) => trackingKey(fp.provider, fp.model) === key),
    )
    report.harnesses.push({
      id: h.id,
      name: h.name,
      entries: candidates.map((c) => c.entry),
      ...(orphanedTracking.length ? { orphanedTracking } : {}),
    })
  }

  deps.storage.write(MODEL_UPDATES_FILE, report)
  return report
}

export function readModelUpdateReport(storage: SchedulerDeps['storage']): ModelUpdateReport | null {
  return storage.read<ModelUpdateReport | null>(MODEL_UPDATES_FILE, null)
}

/**
 * A manual apply rewrote config.yaml but nothing rewrites the persisted
 * report until the next check — so the fleet card re-listed the just-applied
 * row with a live Update button (second click → 404). Mark it applied.
 */
function markReportApplied(storage: SchedulerDeps['storage'], harnessId: string, provider: string, model: string): void {
  const report = readModelUpdateReport(storage)
  const h = report?.harnesses.find((x) => x.id === harnessId)
  if (!report || !h) return
  let changed = false
  for (const e of h.entries) {
    if (e.successor && sameId(e.provider, provider) && sameId(e.model, model) && !e.applied) {
      e.applied = true
      changed = true
    }
  }
  if (changed) storage.write(MODEL_UPDATES_FILE, report)
}

export type ApplyResult = { ok: true; harnessId: string; from: string; to: string; priceRatio?: number } | { ok: false; status: number; error: string }

/**
 * Manual one-click apply of a reported successor. Same guards as the
 * scheduler except the two that encode "did a human decide this": the entry
 * need not be tracked, and a snapshot bump may be applied. `to` must be the
 * successor the live list reports right now — a stale UI cannot push an id
 * the provider no longer serves.
 */
export async function applyModelUpdate(
  input: { harnessId: string; from: string; to: string; provider?: string },
  depsIn?: SchedulerDeps,
): Promise<ApplyResult> {
  const deps = depsIn ?? (await defaultDeps())
  const h = deps.harness.get(input.harnessId)
  if (!h) return { ok: false, status: 404, error: 'Harness not found' }
  if (h.runtime === 'letta' || h.runtime === 'letta-server') return { ok: false, status: 400, error: 'Not a container harness' }
  const fps = readFallbackProviders(deps.dataDirFor(h))
  const matches = fps.filter((fp) => fp.model === input.from && (!input.provider || fp.provider.trim().toLowerCase() === input.provider.trim().toLowerCase()))
  if (matches.length === 0) return { ok: false, status: 404, error: `"${input.from}" is not in this harness's fallback_providers` }
  if (matches.length > 1) return { ok: false, status: 400, error: `"${input.from}" appears under more than one provider; pass provider` }
  const fp = matches[0]
  const settings = deps.config.getModelAutoUpdate()
  const c = await evaluateEntry(h, fp, liveCache(deps), deps, priorPricingFrom(deps))
  if (!c.entry.successor) return { ok: false, status: 409, error: `No live successor for "${input.from}"` }
  if (c.entry.successor !== input.to) {
    return { ok: false, status: 409, error: `Live successor for "${input.from}" is "${c.entry.successor}", not "${input.to}"` }
  }
  const reason = evaluateApply({ harness: h, entry: c.entry, unstable: c.unstable, settings, automatic: false, isRestarting: deps.isRestarting })
  if (reason) return { ok: false, status: reason === 'restart-in-flight' ? 409 : 400, error: `Blocked: ${reason}` }
  const done = performSubstitutions(h, [{ from: fp.model, to: input.to, provider: fp.provider, priceRatio: c.entry.priceRatio }], 'api', deps)
  if (!done.ok) return { ok: false, status: done.status, error: done.status === 409 ? `Blocked: ${done.error}` : done.error }
  markReportApplied(deps.storage, h.id, fp.provider, fp.model)
  return { ok: true, harnessId: h.id, from: fp.model, to: input.to, priceRatio: c.entry.priceRatio }
}

// --- scheduler ---------------------------------------------------------------

const INITIAL_DELAY_MS = 60 * 1000

export async function runScheduledModelUpdateCheck(): Promise<void> {
  try {
    const deps = await defaultDeps()
    const settings = deps.config.getModelAutoUpdate()
    // Disabled = no background network at all. Manual POST .../check still works.
    if (!settings.enabled) return
    await checkModelUpdates(deps, { apply: settings.mode === 'apply' })
  } catch (err) {
    console.error('[model-updates] scheduled check failed:', err)
  }
}

declare global {
  var __hsmModelUpdateSchedulerStarted: boolean | undefined
}

/**
 * Largest delay Node's setInterval honours (2^31 - 1 ms ≈ 24.8 days). A
 * larger value overflows to 1ms — a monthly interval became a hot loop that
 * re-read every config.yaml and could restart harnesses continuously.
 */
export const MAX_INTERVAL_MS = 2 ** 31 - 1

export function resolveIntervalMs(settings: ModelAutoUpdateSettings, env: string | undefined = process.env.MODEL_UPDATE_INTERVAL_MS): number {
  const envInterval = parseInt(env ?? '', 10)
  if (Number.isFinite(envInterval) && envInterval > 0) return Math.min(envInterval, MAX_INTERVAL_MS)
  const hours = Number.isFinite(settings.intervalHours) && settings.intervalHours > 0 ? settings.intervalHours : 24
  return Math.min(Math.round(hours * 60 * 60 * 1000), MAX_INTERVAL_MS)
}

export async function startModelUpdateScheduler(): Promise<void> {
  if (globalThis.__hsmModelUpdateSchedulerStarted) return
  globalThis.__hsmModelUpdateSchedulerStarted = true

  let intervalMs = 24 * 60 * 60 * 1000
  try {
    const deps = await defaultDeps()
    intervalMs = resolveIntervalMs(deps.config.getModelAutoUpdate())
  } catch (err) {
    console.error('[model-updates] could not read settings; using 24h:', err)
  }

  const initial = setTimeout(() => void runScheduledModelUpdateCheck(), INITIAL_DELAY_MS)
  initial.unref?.()
  const recurring = setInterval(() => void runScheduledModelUpdateCheck(), intervalMs)
  recurring.unref?.()
}
