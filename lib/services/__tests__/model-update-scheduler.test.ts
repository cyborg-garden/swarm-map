// @vitest-environment node
//
// checkModelUpdates / applyModelUpdate against a tmpdir fleet with mocked
// live lists. Every guard on the apply path has a test that shows it writes
// NOTHING and restarts NOTHING when it declines — a bad write crash-loops a
// live agent, so the negative cases are the important ones.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Storage } from '../storage'
import { readFallbackProviders, readCascade, cascadeChain } from '../harness'
import { CYBORG, CRYPTIDS, MATILDE } from './fleet-shapes'
import {
  checkModelUpdates,
  applyModelUpdate,
  evaluateApply,
  resolveIntervalMs,
  readModelUpdateReport,
  harnessDataDir,
  MODEL_UPDATES_FILE,
  trackingKey,
  type SchedulerDeps,
  type ModelUpdateEntry,
} from '../model-update-scheduler'
import type { LiveModelList, LiveProvider } from '../model-freshness'
import type { Harness, ModelAutoUpdateSettings } from '@/lib/types'

// The apply path goes through applyCascadeToHarness (lib/services/cascade-writer),
// which reaches the harness registry, the overlay and the audit log through the
// `services` singleton and locates config.yaml via guessDataDir. Route both at
// the same fakes the scheduler's injected deps use, so the REAL writer runs
// against the tmpdir fleet below — validate-before-write included.
vi.mock('@/lib/services', () => ({
  services: {
    harness: {
      get: (id: string) => deps.harness.get(id),
      updateConfig: (id: string, partial: Partial<Harness>) => deps.harness.updateConfig(id, partial),
    },
    audit: { append: (e: Parameters<SchedulerDeps['audit']['append']>[0]) => deps.audit.append(e) },
  },
}))
vi.mock('@/lib/services/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/harness')>()),
  guessDataDir: (serviceName: string) => path.join(root, serviceName.replace(/^hermes-/, '')),
}))

const TODAY = '2026-09-22'
const p = (prompt: number, completion: number) => ({ prompt, completion })

const OR_LIVE: LiveModelList = {
  provider: 'openrouter',
  fetchedAt: 1,
  models: [
    { id: 'z-ai/glm-5.3', canonical: 'z-ai/glm-5.3-20260816', created: 1787086655, expiration: null, pricing: p(0.00000091, 0.00000286) },
    { id: 'z-ai/glm-5.2', canonical: 'z-ai/glm-5.2-20260616', created: 1781631930, expiration: null, pricing: p(0.0000006496, 0.0000020416) },
    { id: 'moonshotai/kimi-k3', canonical: 'moonshotai/kimi-k3-20260715', created: 1784215858, expiration: null, pricing: p(0.000003, 0.000015) },
    { id: 'moonshotai/kimi-k2.7-code', canonical: 'moonshotai/kimi-k2.7-code-20260612', created: 1781266361, expiration: null, pricing: p(0.0000007062, 0.00000321) },
    { id: 'moonshotai/kimi-k2.7', canonical: 'moonshotai/kimi-k2.7-20260601', created: 1780400000, expiration: null, pricing: p(0.0000006, 0.000003) },
    { id: 'deepseek/deepseek-v4-flash-0731', canonical: 'deepseek/deepseek-v4-flash-20260731', created: 1785478908, expiration: null, pricing: p(0.00000004, 0.00000064) },
    { id: 'deepseek/deepseek-v4-flash', canonical: 'deepseek/deepseek-v4-flash-20260423', created: 1777000666, expiration: null, pricing: p(0.000000088606, 0.000000177212) },
    { id: 'deepseek/deepseek-v3.2', canonical: 'deepseek/deepseek-v3.2-20251201', created: 1764594642, expiration: '2026-09-28', pricing: p(0.000000269, 0.0000004) },
    { id: 'google/gemini-3-flash-preview', canonical: 'google/gemini-3-flash-preview-20251217', created: 1765900000, expiration: null, pricing: p(0.0000003, 0.0000025) },
    { id: 'google/gemini-2.5-flash', canonical: 'google/gemini-2.5-flash', created: 1750172488, expiration: '2026-10-20', pricing: p(0.0000003, 0.0000025) },
  ],
}

let root: string
let storage: Storage
let harnesses: Harness[]
let settings: ModelAutoUpdateSettings
let restarting: Set<string>
let deps: SchedulerDeps
let liveLists: Partial<Record<LiveProvider, LiveModelList | null>>

function makeHarness(name: string, opts: { config: string; env?: string; tracking?: Record<string, boolean>; runtime?: Harness['runtime'] }): Harness {
  const dataDir = path.join(root, name)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), opts.config)
  fs.writeFileSync(path.join(dataDir, '.env'), opts.env ?? 'OPENROUTER_API_KEY=sk-or-test\nANTHROPIC_API_KEY=sk-ant-test\n')
  const h: Harness = {
    id: `h_${name}`,
    name,
    runtime: opts.runtime ?? 'hermes',
    status: 'running',
    health: { errors: 0 },
    persona: '',
    tier: 'individual',
    platform: 'hermes',
    channel: '',
    lastSeen: 0,
    models: [],
    costToday: 0,
    invocations: 0,
    cpu: 0,
    mem: 0,
    tools: [],
    serviceName: `hermes-${name}`,
    ...(opts.tracking ? { modelTracking: opts.tracking } : {}),
  }
  harnesses.push(h)
  return h
}

// The HSM-editor convention: model.default repeated as fallback_providers[0].
// The chain the scheduler sees is [entries[0] (primary), ...entries[1..]].
const fpConfig = (entries: Array<[string, string]>) =>
  [
    'model:',
    `  provider: ${entries[0][0]}`,
    `  default: ${entries[0][1]}`,
    'fallback_providers:',
    ...entries.flatMap(([prov, model]) => [`  - provider: ${prov}`, `    model: ${model}`]),
    'platforms:',
    '  telegram:',
    '    enabled: true',
    '',
  ].join('\n')

const readConfig = (name: string) => fs.readFileSync(path.join(root, name, 'config.yaml'), 'utf-8')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-model-updates-'))
  storage = new Storage(root)
  harnesses = []
  restarting = new Set()
  settings = { enabled: true, mode: 'notify', intervalHours: 24, maxPriceMultiplier: 1.5 }
  liveLists = { openrouter: OR_LIVE, anthropic: null, zai: null }
  deps = {
    harness: {
      list: () => harnesses,
      get: (id) => harnesses.find((h) => h.id === id),
      updateConfig: vi.fn((id, partial) => {
        const h = harnesses.find((x) => x.id === id)
        if (h) Object.assign(h, partial)
        return h
      }),
      restart: vi.fn(),
    },
    freshness: {
      fetchLiveModels: vi.fn(async (provider: LiveProvider) => liveLists[provider] ?? null),
      isRetired: (id, live, today = TODAY) => {
        if (!live) return false
        const row = live.models.find((m) => m.id === id)
        if (!row) return true
        return !!row.expiration && row.expiration < today
      },
    },
    config: { getModelAutoUpdate: () => settings },
    audit: { append: vi.fn() },
    storage,
    dataDirFor: (h) => path.join(root, h.name),
    isRestarting: (id) => restarting.has(id),
    today: TODAY,
  }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const entryFor = (report: Awaited<ReturnType<typeof checkModelUpdates>>, hid: string, model: string): ModelUpdateEntry | undefined =>
  report.harnesses.find((h) => h.id === hid)?.entries.find((e) => e.model === model)

describe('checkModelUpdates — report', () => {
  it('flags successors, retired rows, tracked state, price ratio; persists model-updates.json', async () => {
    makeHarness('a', {
      config: fpConfig([
        ['openrouter', 'z-ai/glm-5.2'],
        ['openrouter', 'moonshotai/kimi-k2.7-code'],
        ['openrouter', 'deepseek/deepseek-v3.2'],
        ['openrouter', 'z-ai/glm-4.5-gone'],
      ]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    expect(report.enabled).toBe(true)
    expect(report.mode).toBe('notify')
    expect(report.harnesses).toHaveLength(1)

    const glm = entryFor(report, 'h_a', 'z-ai/glm-5.2')!
    expect(glm.tracked).toBe(true)
    expect(glm.retired).toBe(false)
    expect(glm.successor).toBe('z-ai/glm-5.3')
    expect(glm.kind).toBe('version')
    expect(glm.priceRatio).toBeCloseTo(1.4008, 3)
    expect(glm.applied).toBeUndefined()

    const kimi = entryFor(report, 'h_a', 'moonshotai/kimi-k2.7-code')!
    expect(kimi.tracked).toBe(false)
    expect(kimi.successor).toBeUndefined()
    expect(kimi.nearMisses).toEqual(['moonshotai/kimi-k3'])

    // present, expiration 2026-09-28 ≥ today → not yet retired
    expect(entryFor(report, 'h_a', 'deepseek/deepseek-v3.2')!.retired).toBe(false)
    // absent from the live list → retired
    expect(entryFor(report, 'h_a', 'z-ai/glm-4.5-gone')!.retired).toBe(true)

    expect(readModelUpdateReport(storage)).toEqual(report)
    expect(fs.existsSync(path.join(root, MODEL_UPDATES_FILE))).toBe(true)
    // notify mode: nothing written, nothing restarted
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(readConfig('a')).toContain('    model: z-ai/glm-5.2')
  })

  it('a provider with no live list leaves its entries unflagged; ollama is never checked', async () => {
    makeHarness('b', {
      config: fpConfig([
        ['anthropic', 'claude-sonnet-4-6'],
        ['ollama', 'qwen3:30b'],
      ]),
    })
    const report = await checkModelUpdates(deps)
    const claude = entryFor(report, 'h_b', 'claude-sonnet-4-6')!
    expect(claude.retired).toBe(false)
    expect(claude.successor).toBeUndefined()
    const local = entryFor(report, 'h_b', 'qwen3:30b')!
    expect(local.retired).toBe(false)
    expect(local.successor).toBeUndefined()
    expect(deps.freshness.fetchLiveModels).not.toHaveBeenCalledWith('ollama')
  })

  it('fetches each live provider once per run and skips Letta harnesses', async () => {
    makeHarness('c1', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]) })
    makeHarness('c2', { config: fpConfig([['openrouter', 'moonshotai/kimi-k2.7']]) })
    makeHarness('letta', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]), runtime: 'letta' })
    const report = await checkModelUpdates(deps)
    expect(report.harnesses.map((h) => h.id)).toEqual(['h_c1', 'h_c2'])
    expect(deps.freshness.fetchLiveModels).toHaveBeenCalledTimes(1)
  })
})

describe('checkModelUpdates — apply mode', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  it('happy path: rewrites the cascade, rotates the tracking key, quick-restarts, audits', async () => {
    const h = makeHarness('d', {
      config: fpConfig([
        ['openrouter', 'z-ai/glm-5.2'],
        ['openrouter', 'moonshotai/kimi-k2.7-code'],
      ]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_d', 'z-ai/glm-5.2')!
    expect(glm.applied).toBe(true)
    expect(glm.blocked).toBeUndefined()

    const cfg = readConfig('d')
    expect(cfg).toContain('  default: z-ai/glm-5.3')
    expect(cfg).toContain('  - provider: openrouter\n    model: z-ai/glm-5.3\n  - provider: openrouter\n    model: moonshotai/kimi-k2.7-code')
    expect(cfg).not.toContain('z-ai/glm-5.2')
    expect(cfg).toContain('platforms:\n  telegram:\n    enabled: true')

    expect(deps.harness.updateConfig).toHaveBeenCalledWith('h_d', {
      models: ['z-ai/glm-5.3', 'moonshotai/kimi-k2.7-code'],
      modelTracking: { [trackingKey('openrouter', 'z-ai/glm-5.3')]: true },
    })
    expect(h.modelTracking).toEqual({ 'openrouter/z-ai/glm-5.3': true })
    expect(deps.harness.restart).toHaveBeenCalledWith('h_d', 'quick')
    expect(deps.audit.append).toHaveBeenCalledWith({
      who: 'scheduler',
      what: 'cascade:auto-update',
      target: 'd',
      meta: expect.objectContaining({ harness: 'h_d', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', priceRatio: expect.any(Number) }),
    })
  })

  it('price unknown (Anthropic publishes no pricing): successor reported, apply blocked, nothing written', async () => {
    liveLists.anthropic = {
      provider: 'anthropic',
      fetchedAt: 1,
      models: [
        { id: 'claude-sonnet-4-6', created: 1771342990, expiration: null, pricing: null },
        { id: 'claude-sonnet-4-7', created: 1787000000, expiration: null, pricing: null },
      ],
    }
    makeHarness('pu', {
      config: fpConfig([['anthropic', 'claude-sonnet-4-6']]),
      tracking: { [trackingKey('anthropic', 'claude-sonnet-4-6')]: true },
    })
    const report = await checkModelUpdates(deps)
    const claude = entryFor(report, 'h_pu', 'claude-sonnet-4-6')!
    expect(claude.successor).toBe('claude-sonnet-4-7')
    expect(claude.kind).toBe('version')
    expect(claude.priceRatio).toBeUndefined()
    expect(claude.applied).toBeUndefined()
    expect(claude.blocked).toBe('price-unknown')
    expect(readConfig('pu')).toContain('    model: claude-sonnet-4-6')
    expect(readConfig('pu')).not.toContain('claude-sonnet-4-7')
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(deps.audit.append).not.toHaveBeenCalled()
  })

  it('untracked entry with a successor: reported, not applied', async () => {
    makeHarness('e', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]) })
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_e', 'z-ai/glm-5.2')!
    expect(glm.successor).toBe('z-ai/glm-5.3')
    expect(glm.applied).toBeUndefined()
    expect(glm.blocked).toBe('untracked')
    expect(readConfig('e')).toContain('z-ai/glm-5.2')
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('price ceiling: blocked, nothing written', async () => {
    settings = { ...settings, maxPriceMultiplier: 1.2 } // glm-5.3 is 1.40× glm-5.2
    makeHarness('f', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_f', 'z-ai/glm-5.2')!
    expect(glm.blocked).toMatch(/^price-ceiling:/)
    expect(glm.applied).toBeUndefined()
    expect(readConfig('f')).toContain('z-ai/glm-5.2')
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(deps.harness.updateConfig).not.toHaveBeenCalled()
  })

  it('snapshot-only bump is notify-only', async () => {
    makeHarness('g', {
      config: fpConfig([['openrouter', 'deepseek/deepseek-v4-flash']]),
      tracking: { [trackingKey('openrouter', 'deepseek/deepseek-v4-flash')]: true },
    })
    const report = await checkModelUpdates(deps)
    const ds = entryFor(report, 'h_g', 'deepseek/deepseek-v4-flash')!
    expect(ds.successor).toBe('deepseek/deepseek-v4-flash-0731')
    expect(ds.kind).toBe('snapshot')
    expect(ds.blocked).toBe('notify-only:snapshot')
    expect(readConfig('g')).toContain('deepseek/deepseek-v4-flash\n')
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('unstable rows are never successors, so a tracked entry with only a preview ahead is untouched', async () => {
    makeHarness('h', {
      config: fpConfig([['openrouter', 'google/gemini-2.5-flash']]),
      tracking: { [trackingKey('openrouter', 'google/gemini-2.5-flash')]: true },
    })
    const report = await checkModelUpdates(deps)
    const g = entryFor(report, 'h_h', 'google/gemini-2.5-flash')!
    expect(g.successor).toBeUndefined()
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('ollama entries are never applied even when tracked', async () => {
    liveLists.openrouter = OR_LIVE
    makeHarness('i', {
      config: fpConfig([['ollama', 'qwen3:30b']]),
      tracking: { [trackingKey('ollama', 'qwen3:30b')]: true },
    })
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_i', 'qwen3:30b')!.applied).toBeUndefined()
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('writer refusal (no credential for the provider) → nothing written, no restart, no tracking change, blocked audit row', async () => {
    const h = makeHarness('j', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      env: 'ANTHROPIC_API_KEY=sk-ant-test\n', // no OPENROUTER key
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const before = readConfig('j')
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_j', 'z-ai/glm-5.2')!
    expect(glm.applied).toBeUndefined()
    expect(glm.blocked).toMatch(/^validation:Invalid model cascade:.*openrouter/)
    expect(readConfig('j')).toBe(before)
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(deps.harness.updateConfig).not.toHaveBeenCalled()
    expect(h.modelTracking).toEqual({ 'openrouter/z-ai/glm-5.2': true })
    expect(deps.audit.append).toHaveBeenCalledTimes(1)
    expect(deps.audit.append).toHaveBeenCalledWith({
      who: 'scheduler',
      what: 'cascade:auto-update:blocked',
      target: 'j',
      meta: expect.objectContaining({ harness: 'h_j', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', reason: expect.stringMatching(/^Invalid model cascade:/) }),
    })
  })

  it('a restart already in flight blocks the apply', async () => {
    makeHarness('k', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    restarting.add('h_k')
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_k', 'z-ai/glm-5.2')!.blocked).toBe('restart-in-flight')
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(readConfig('k')).toContain('z-ai/glm-5.2')
  })

  it('apply mode is off unless enabled AND mode=apply', async () => {
    settings = { ...settings, enabled: false, mode: 'apply' }
    makeHarness('l', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_l', 'z-ai/glm-5.2')!.applied).toBeUndefined()
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })
})

describe('applyModelUpdate — manual one-click', () => {
  it('applies a reported successor (untracked is fine for a human), audits as api', async () => {
    makeHarness('m', { config: fpConfig([['openrouter', 'z-ai/glm-5.2'], ['openrouter', 'moonshotai/kimi-k2.7-code']]) })
    const r = await applyModelUpdate({ harnessId: 'h_m', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(r).toEqual({ ok: true, harnessId: 'h_m', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', priceRatio: expect.any(Number) })
    expect(readConfig('m')).toContain('    model: z-ai/glm-5.3')
    expect(deps.harness.restart).toHaveBeenCalledWith('h_m', 'quick')
    expect(deps.audit.append).toHaveBeenCalledWith(expect.objectContaining({ who: 'api', what: 'cascade:auto-update', target: 'm' }))
    // untracked before → still untracked after (no key invented)
    expect(deps.harness.updateConfig).toHaveBeenCalledWith('h_m', { models: ['z-ai/glm-5.3', 'moonshotai/kimi-k2.7-code'], modelTracking: {} })
  })

  it('rotates the tracking key when the entry was tracked', async () => {
    const h = makeHarness('n', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      tracking: { 'openrouter/z-ai/glm-5.2': true },
    })
    await applyModelUpdate({ harnessId: 'h_n', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(h.modelTracking).toEqual({ 'openrouter/z-ai/glm-5.3': true })
  })

  it('refuses a `to` that is not the live successor (stale UI)', async () => {
    makeHarness('o', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]) })
    const r = await applyModelUpdate({ harnessId: 'h_o', from: 'z-ai/glm-5.2', to: 'z-ai/glm-9' }, deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(409)
    expect(readConfig('o')).toContain('z-ai/glm-5.2')
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('refuses an entry that is not in the cascade, an unknown harness, and a blocked (price) successor', async () => {
    makeHarness('q', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]) })
    expect((await applyModelUpdate({ harnessId: 'h_q', from: 'nope/nope', to: 'x' }, deps)).ok).toBe(false)
    expect((await applyModelUpdate({ harnessId: 'h_missing', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps))).toMatchObject({ ok: false, status: 404 })
    settings = { ...settings, maxPriceMultiplier: 1.1 }
    const r = await applyModelUpdate({ harnessId: 'h_q', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (!r.ok) expect(r.error).toMatch(/price-ceiling/)
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('a human may apply a snapshot bump, but never onto ollama, and never while restarting', async () => {
    // the 0731 retrain is ~3.6× the 0423 preview on completion — lift the ceiling for this case
    settings = { ...settings, maxPriceMultiplier: 4 }
    makeHarness('r', { config: fpConfig([['openrouter', 'deepseek/deepseek-v4-flash'], ['ollama', 'qwen3:30b']]) })
    const local = await applyModelUpdate({ harnessId: 'h_r', from: 'qwen3:30b', to: 'qwen3.5:30b' }, deps)
    expect(local.ok).toBe(false)
    const r = await applyModelUpdate({ harnessId: 'h_r', from: 'deepseek/deepseek-v4-flash', to: 'deepseek/deepseek-v4-flash-0731' }, deps)
    expect(r.ok).toBe(true)
    expect(readConfig('r')).toContain('deepseek/deepseek-v4-flash-0731')

    restarting.add('h_r')
    const again = await applyModelUpdate({ harnessId: 'h_r', from: 'deepseek/deepseek-v4-flash-0731', to: 'anything' }, deps)
    expect(again.ok).toBe(false)
  })

  it('writer refusal → 400 with the writer\'s message, nothing written, no restart, blocked audit row', async () => {
    makeHarness('s', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]), env: 'ANTHROPIC_API_KEY=sk-ant-test\n' })
    const before = readConfig('s')
    const r = await applyModelUpdate({ harnessId: 'h_s', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(r).toMatchObject({ ok: false, status: 400 })
    if (!r.ok) expect(r.error).toMatch(/^Invalid model cascade: .*openrouter/)
    expect(readConfig('s')).toBe(before)
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(deps.harness.updateConfig).not.toHaveBeenCalled()
    expect(deps.audit.append).toHaveBeenCalledTimes(1)
    expect(deps.audit.append).toHaveBeenCalledWith(expect.objectContaining({ who: 'api', what: 'cascade:auto-update:blocked', target: 's' }))
  })
})

describe('harnessDataDir', () => {
  it('maps personal → ~/.hermes and a named service → ~/.hermes-<name>', async () => {
    // Bypass this file's guessDataDir stub: the real mapping is what production uses.
    const real = await vi.importActual<typeof import('@/lib/services/harness')>('@/lib/services/harness')
    expect(real.guessDataDir('hermes-personal', 'hermes-personal')).toBe(path.join(os.homedir(), '.hermes'))
    expect(real.guessDataDir('hermes-osint', 'hermes-osint')).toBe(path.join(os.homedir(), '.hermes-osint'))
    // and the scheduler's helper derives the same (serviceName, containerName) pair the writer does
    expect(harnessDataDir({ name: 'personal', serviceName: 'hermes-personal' })).toBe(path.join(root, 'personal'))
    expect(harnessDataDir({ name: 'osint', serviceName: 'hermes-osint' })).toBe(path.join(root, 'osint'))
  })
})

describe('evaluateApply / resolveIntervalMs', () => {
  const base = (): Parameters<typeof evaluateApply>[0] => ({
    harness: { id: 'h_x' } as Harness,
    entry: { provider: 'openrouter', model: 'a', tracked: true, retired: false, successor: 'b', kind: 'version', priceRatio: 1 },
    unstable: false,
    settings: { enabled: true, mode: 'apply', intervalHours: 24, maxPriceMultiplier: 1.5 },
    automatic: true,
    isRestarting: () => false,
  })

  it('passes a clean tracked version bump and names each guard that declines', () => {
    expect(evaluateApply(base())).toBeNull()
    expect(evaluateApply({ ...base(), entry: { ...base().entry, provider: 'bedrock' } })).toMatch(/provider-not-auto-updatable/)
    expect(evaluateApply({ ...base(), entry: { ...base().entry, provider: 'custom' } })).toMatch(/provider-not-auto-updatable/)
    expect(evaluateApply({ ...base(), unstable: true })).toBe('unstable-successor')
    expect(evaluateApply({ ...base(), entry: { ...base().entry, priceRatio: Infinity } })).toMatch(/price-ceiling/)
    // No pricing published (direct Anthropic / Z.ai) → the ceiling cannot be
    // checked, so the scheduler must not rotate unattended. A human's one-click
    // apply stays permissive.
    expect(evaluateApply({ ...base(), entry: { ...base().entry, priceRatio: undefined } })).toBe('price-unknown')
    expect(evaluateApply({ ...base(), entry: { ...base().entry, priceRatio: undefined }, automatic: false })).toBeNull()
    expect(evaluateApply({ ...base(), entry: { ...base().entry, kind: 'snapshot' }, automatic: false })).toBeNull()
  })

  it('env MODEL_UPDATE_INTERVAL_MS overrides intervalHours', () => {
    const s = { enabled: true, mode: 'notify' as const, intervalHours: 6, maxPriceMultiplier: 1.5 }
    expect(resolveIntervalMs(s, undefined)).toBe(6 * 3600 * 1000)
    expect(resolveIntervalMs(s, '5000')).toBe(5000)
    expect(resolveIntervalMs(s, 'junk')).toBe(6 * 3600 * 1000)
  })
})

// --- Audit ------------------------------------------------------------------
describe('checkModelUpdates — apply guards added by the audit', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  // matilde-shaped: model.default is kimi-k3 and the tracked row is the FIRST
  // FALLBACK. PR #243 blocked this as primary-mismatch on the wrong premise
  // (row 0 == primary). The runtime tries kimi-k3 first and glm-5.2 second, so
  // rotating the fallback row must touch nothing but that row.
  const fallbackTrackedCfg = [
    'model:',
    '  provider: openrouter',
    '  default: moonshotai/kimi-k3',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.2',
    '  - provider: anthropic',
    '    model: claude-sonnet-4-6',
    '',
  ].join('\n')

  it('a tracked FALLBACK row is rotated without touching model.default (no primary-mismatch block)', async () => {
    makeHarness('pm', { config: fallbackTrackedCfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_pm', 'z-ai/glm-5.2')!
    expect(glm.successor).toBe('z-ai/glm-5.3')
    expect(glm.role).toBe('fallback')
    expect(glm.blocked).toBeUndefined()
    expect(glm.applied).toBe(true)
    expect(readConfig('pm')).toBe(fallbackTrackedCfg.replace('z-ai/glm-5.2', 'z-ai/glm-5.3'))
    expect(deps.harness.restart).toHaveBeenCalledWith('h_pm', 'quick')
    // The primary is reported first, as the primary; a rotated entry keeps
    // the id it was evaluated under, flagged applied.
    const entries = report.harnesses.find((h) => h.id === 'h_pm')!.entries
    expect(entries.map((e) => [e.model, e.role, e.applied])).toEqual([
      ['moonshotai/kimi-k3', 'primary', undefined],
      ['z-ai/glm-5.2', 'fallback', true],
      ['claude-sonnet-4-6', 'fallback', undefined],
    ])
  })

  it('manual apply of a fallback row on the same shape leaves model.default alone', async () => {
    makeHarness('pm2', { config: fallbackTrackedCfg })
    const res = await applyModelUpdate({ harnessId: 'h_pm2', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(res.ok).toBe(true)
    expect(readConfig('pm2')).toBe(fallbackTrackedCfg.replace('z-ai/glm-5.2', 'z-ai/glm-5.3'))
    expect(deps.harness.restart).toHaveBeenCalledWith('h_pm2', 'quick')
  })

  it('a rotation keeps the other rows\' extra keys (inline api_key) and the model block\'s base_url', async () => {
    const cfg = [
      'model:',
      '  provider: openrouter',
      '  default: z-ai/glm-5.2',
      '  base_url: https://openrouter.example/v1',
      'fallback_providers:',
      '  - provider: openrouter',
      '    model: z-ai/glm-5.2',
      '  - provider: custom',
      '    model: some-proxy-model',
      '    base_url: http://proxy:4000/v1',
      '    api_key: sk-proxy-inline',
      '',
    ].join('\n')
    makeHarness('rk', { config: cfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_rk', 'z-ai/glm-5.2')!.applied).toBe(true)
    const out = readConfig('rk')
    expect(out).toContain('    api_key: sk-proxy-inline')
    expect(out).toContain('  base_url: https://openrouter.example/v1')
    expect(out).toContain('    model: z-ai/glm-5.3')
  })

  it('the report surfaces tracking keys that match no current row (orphaned after a stale save)', async () => {
    makeHarness('or', {
      config: fpConfig([['openrouter', 'z-ai/glm-5.2']]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.3')]: true },
    })
    settings = { ...settings, mode: 'notify' }
    const report = await checkModelUpdates(deps)
    const h = report.harnesses.find((x) => x.id === 'h_or')!
    expect(h.orphanedTracking).toEqual(['openrouter/z-ai/glm-5.3'])
    expect(entryFor(report, 'h_or', 'z-ai/glm-5.2')!.tracked).toBe(false)
  })
})

describe('re-audit: rotations, retired rows, the persisted report', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  const keyEnvCfg = [
    'model:',
    '  provider: openrouter',
    '  default: z-ai/glm-5.2',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.2',
    '    key_env: OPENROUTER_KEY_B',
    '    api_mode: chat_completions',
    '  - provider: anthropic',
    '    model: claude-sonnet-4-6',
    '',
  ].join('\n')

  it('a rotation carries the rotated row\'s own keys (key_env, api_mode) onto the successor row', async () => {
    makeHarness('ke', {
      config: keyEnvCfg,
      env: 'OPENROUTER_API_KEY=sk-or\nOPENROUTER_KEY_B=sk-or-b\nANTHROPIC_API_KEY=sk-ant\n',
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_ke', 'z-ai/glm-5.2')!.applied).toBe(true)
    expect(readConfig('ke')).toContain('  - provider: openrouter\n    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B\n    api_mode: chat_completions\n  - provider: anthropic')
  })

  it('a rotation is not refused for the provider\'s default var when the row authenticates via key_env', async () => {
    makeHarness('ke2', {
      config: keyEnvCfg,
      env: 'OPENROUTER_KEY_B=sk-or-b\nANTHROPIC_API_KEY=sk-ant\n',
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_ke2', 'z-ai/glm-5.2')!
    expect(e.blocked).toBeUndefined()
    expect(e.applied).toBe(true)
    expect(readConfig('ke2')).toContain('    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B')
  })

  it('a retired-by-absence tracked row is rotated unattended when the last report carried its pricing', async () => {
    makeHarness('ra', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]), tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    // Run 1 (notify): glm-5.2 is still listed; its pricing lands in the report.
    settings = { ...settings, mode: 'notify' }
    await checkModelUpdates(deps)
    // The provider removes glm-5.2. Run 2 (apply).
    liveLists.openrouter = { ...OR_LIVE, models: OR_LIVE.models.filter((m) => m.id !== 'z-ai/glm-5.2') }
    settings = { ...settings, mode: 'apply' }
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_ra', 'z-ai/glm-5.2')!
    expect(e.retired).toBe(true)
    expect(e.successor).toBe('z-ai/glm-5.3')
    expect(e.priceRatio).toBeCloseTo(0.00000286 / 0.0000020416, 6)
    expect(e.blocked).toBeUndefined()
    expect(e.applied).toBe(true)
    expect(readConfig('ra')).toContain('    model: z-ai/glm-5.3')
    expect(deps.harness.restart).toHaveBeenCalledWith('h_ra', 'quick')
  })

  it('a retired-by-absence row with no known pricing is blocked with a DISTINCT reason, not "price-unknown"', async () => {
    makeHarness('rb', { config: fpConfig([['openrouter', 'z-ai/glm-5.2']]), tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    // Run 1 (notify): glm-5.2 is listed without pricing, so the report records
    // its release date but no price. (With NO previous report the row's date is
    // unknown too and the finder reports no successor at all — round-3 audit.)
    liveLists.openrouter = { ...OR_LIVE, models: OR_LIVE.models.map((m) => (m.id === 'z-ai/glm-5.2' ? { ...m, pricing: null } : m)) }
    settings = { ...settings, mode: 'notify' }
    await checkModelUpdates(deps)
    liveLists.openrouter = { ...OR_LIVE, models: OR_LIVE.models.filter((m) => m.id !== 'z-ai/glm-5.2') }
    settings = { ...settings, mode: 'apply' }
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_rb', 'z-ai/glm-5.2')!
    expect(e.retired).toBe(true)
    expect(e.successor).toBe('z-ai/glm-5.3')
    expect(e.blocked).toBe('retired-current-no-pricing')
    expect(e.applied).toBeUndefined()
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('the current row\'s pricing is found case-insensitively', async () => {
    makeHarness('ci', { config: fpConfig([['openrouter', 'Z-AI/glm-5.2']]) })
    settings = { ...settings, mode: 'notify' }
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_ci', 'Z-AI/glm-5.2')!
    expect(e.successor).toBe('z-ai/glm-5.3')
    expect(e.priceRatio).toBeDefined()
  })

  it('a manual apply marks the entry applied in the persisted report, so the card stops offering it', async () => {
    makeHarness('ma', { config: fpConfig([['openrouter', 'z-ai/glm-5.2'], ['openrouter', 'moonshotai/kimi-k2.7']]) })
    settings = { ...settings, mode: 'notify' }
    await checkModelUpdates(deps)
    const res = await applyModelUpdate({ harnessId: 'h_ma', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(res.ok).toBe(true)
    const persisted = readModelUpdateReport(storage)!
    const h = persisted.harnesses.find((x) => x.id === 'h_ma')!
    expect(h.entries.find((e) => e.model === 'z-ai/glm-5.2')).toMatchObject({ successor: 'z-ai/glm-5.3', applied: true })
    // The other pending entry is untouched.
    expect(h.entries.find((e) => e.model === 'moonshotai/kimi-k2.7')).toMatchObject({ successor: 'moonshotai/kimi-k3' })
    expect(h.entries.find((e) => e.model === 'moonshotai/kimi-k2.7')!.applied).toBeUndefined()
  })
})

describe('resolveIntervalMs — bounded (audit)', () => {
  it('never exceeds the 32-bit timer limit (a monthly interval must not become a 1ms hot loop)', () => {
    const s = { enabled: true, mode: 'notify' as const, intervalHours: 720, maxPriceMultiplier: 1.5 }
    expect(resolveIntervalMs(s, undefined)).toBeLessThanOrEqual(2 ** 31 - 1)
    expect(resolveIntervalMs(s, undefined)).toBeGreaterThan(24 * 3600 * 1000)
    expect(resolveIntervalMs(s, '9999999999')).toBeLessThanOrEqual(2 ** 31 - 1)
    expect(resolveIntervalMs(s, String(2 ** 31 - 1))).toBe(2 ** 31 - 1)
  })
})

// --- r3 nits: duplicate sections ---------------------------------------------
describe('duplicate top-level sections (r3)', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })
  // Two fallback_providers: blocks: the reader only sees the first, so a
  // rotation would rewrite a file whose effective cascade nobody can name.
  const cfg = [
    'model:',
    '  provider: openrouter',
    '  default: z-ai/glm-5.2',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.2',
    'platforms: {}',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: moonshotai/kimi-k3',
    '',
  ].join('\n')

  it('scheduler: blocked with reason duplicate-sections, nothing written, no restart, blocked audit row', async () => {
    makeHarness('dup', { config: cfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    const glm = entryFor(report, 'h_dup', 'z-ai/glm-5.2')!
    expect(glm.successor).toBe('z-ai/glm-5.3')
    expect(glm.applied).toBeUndefined()
    expect(glm.blocked).toBe('duplicate-sections')
    expect(readConfig('dup')).toBe(cfg)
    expect(deps.harness.restart).not.toHaveBeenCalled()
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ what: 'cascade:auto-update:blocked', meta: expect.objectContaining({ reason: expect.stringMatching(/^duplicate-sections/) }) }),
    )
  })

  it('manual apply: 409 with the duplicate-sections error, nothing written', async () => {
    makeHarness('dup2', { config: cfg })
    const res = await applyModelUpdate({ harnessId: 'h_dup2', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(409)
      expect(res.error).toMatch(/duplicate-sections/)
    }
    expect(readConfig('dup2')).toBe(cfg)
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })
})

describe('round-3 audit: substitutions keyed by provider + model; successor already a row; retired row with no date', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  it('two tracked rows with the same model under different providers are BOTH rotated, each on its own row', async () => {
    liveLists.anthropic = { ...OR_LIVE, provider: 'anthropic' }
    const h = makeHarness('dup', {
      config: fpConfig([
        ['openrouter', 'z-ai/glm-5.2'],
        ['anthropic', 'z-ai/glm-5.2'],
      ]),
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true, [trackingKey('anthropic', 'z-ai/glm-5.2')]: true },
    })
    const report = await checkModelUpdates(deps)
    const entries = report.harnesses.find((x) => x.id === 'h_dup')!.entries
    expect(entries.map((e) => [e.provider, e.applied])).toEqual([
      ['openrouter', true],
      ['anthropic', true],
    ])
    const cfg = readConfig('dup')
    expect(cfg).toContain('  - provider: openrouter\n    model: z-ai/glm-5.3\n  - provider: anthropic\n    model: z-ai/glm-5.3\n')
    expect(cfg).not.toContain('glm-5.2')
    expect(h.modelTracking).toEqual({ [trackingKey('openrouter', 'z-ai/glm-5.3')]: true, [trackingKey('anthropic', 'z-ai/glm-5.3')]: true })
    const applied = (deps.audit.append as ReturnType<typeof vi.fn>).mock.calls.filter(([e]) => e.what === 'cascade:auto-update')
    expect(applied.map(([e]) => e.meta.provider).sort()).toEqual(['anthropic', 'openrouter'])
  })

  const twoRowCfg = [
    'model:',
    '  provider: openrouter',
    '  default: z-ai/glm-5.2',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.2',
    '    key_env: OPENROUTER_KEY_B',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.3',
    '    key_env: OPENROUTER_KEY_C',
    '',
  ].join('\n')
  const twoRowEnv = 'OPENROUTER_API_KEY=sk-or\nOPENROUTER_KEY_B=sk-b\nOPENROUTER_KEY_C=sk-c\n'

  it('a tracked row whose successor is already a row of the same provider is blocked, not duplicated', async () => {
    makeHarness('dupsucc', { config: twoRowCfg, env: twoRowEnv, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_dupsucc', 'z-ai/glm-5.2')!
    expect(e.successor).toBe('z-ai/glm-5.3')
    expect(e.blocked).toBe('successor-already-in-cascade')
    expect(e.applied).toBeUndefined()
    expect(readConfig('dupsucc')).toBe(twoRowCfg)
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('manual apply is refused on the same successor-already-a-row condition, nothing written', async () => {
    makeHarness('dupsucc2', { config: twoRowCfg, env: twoRowEnv })
    const res = await applyModelUpdate({ harnessId: 'h_dupsucc2', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('Blocked: successor-already-in-cascade')
    expect(readConfig('dupsucc2')).toBe(twoRowCfg)
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('a retired-by-absence row whose release date is unknown gets NO version successor: an older higher tuple is a near miss, blocked retired-current-no-date', async () => {
    liveLists.openrouter = {
      ...OR_LIVE,
      models: [
        { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200, expiration: null, pricing: p(0.00000234, 0.0000117) },
        { id: 'x-ai/grok-4.6', canonical: 'x-ai/grok-4.6-20260801', created: 1785542400, expiration: null, pricing: p(0.000003, 0.000015) },
      ],
    }
    makeHarness('nodate', { config: fpConfig([['openrouter', 'x-ai/grok-4.7']]), tracking: { [trackingKey('openrouter', 'x-ai/grok-4.7')]: true } })
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_nodate', 'x-ai/grok-4.7')!
    expect(e.retired).toBe(true)
    expect(e.successor).toBeUndefined()
    expect(e.nearMisses).toContain('x-ai/grok-4.20')
    expect(e.blocked).toBe('retired-current-no-date')
    expect(readConfig('nodate')).toContain('model: x-ai/grok-4.7')
    expect(deps.harness.restart).not.toHaveBeenCalled()
  })

  it('the previous report carries the current row\'s release date, so a later retired-by-absence run keeps the date guard', async () => {
    const grok = (extra: LiveModelList['models']): LiveModelList => ({
      ...OR_LIVE,
      models: [
        { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200, expiration: null, pricing: p(0.00000234, 0.0000117) },
        ...extra,
      ],
    })
    const g47 = { id: 'x-ai/grok-4.7', canonical: 'x-ai/grok-4.7-20260916', created: 1789948800, expiration: null, pricing: p(0.000003, 0.000015) }
    const g49 = { id: 'x-ai/grok-4.9', canonical: 'x-ai/grok-4.9-20260920', created: 1790294400, expiration: null, pricing: p(0.000003, 0.000015) }
    makeHarness('dated', { config: fpConfig([['openrouter', 'x-ai/grok-4.7']]), tracking: { [trackingKey('openrouter', 'x-ai/grok-4.7')]: true } })
    // Run 1 (notify): 4.7 is listed; its date lands in the report.
    liveLists.openrouter = grok([g47])
    settings = { ...settings, mode: 'notify' }
    const first = await checkModelUpdates(deps)
    expect(entryFor(first, 'h_dated', 'x-ai/grok-4.7')!.released).toBe('20260916')
    // Run 2 (apply): 4.7 is gone; 4.20 (older) and 4.9 (newer) are live.
    liveLists.openrouter = grok([g49])
    settings = { ...settings, mode: 'apply' }
    const second = await checkModelUpdates(deps)
    const e = entryFor(second, 'h_dated', 'x-ai/grok-4.7')!
    expect(e.retired).toBe(true)
    expect(e.successor).toBe('x-ai/grok-4.9')
    expect(e.nearMisses).toContain('x-ai/grok-4.20')
    expect(e.applied).toBe(true)
    expect(readConfig('dated')).toContain('model: x-ai/grok-4.9')
  })
})

describe('round-4 audit: converging successors in one batch; report memory across a fetch miss', () => {
  const twoRowCfg = [
    'model:',
    '  provider: openrouter',
    '  default: z-ai/glm-5.2',
    '  fallback:',
    '    - z-ai/glm-5.3',
    'fallback_providers:',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.2',
    '    key_env: OPENROUTER_KEY_B',
    '  - provider: openrouter',
    '    model: z-ai/glm-5.3',
    '    key_env: OPENROUTER_KEY_C',
    '',
  ].join('\n')
  const twoRowEnv = 'OPENROUTER_API_KEY=sk-or\nOPENROUTER_KEY_B=sk-b\nOPENROUTER_KEY_C=sk-c\n'
  const g54 = { id: 'z-ai/glm-5.4', canonical: 'z-ai/glm-5.4-20260915', created: 1789700000, expiration: null, pricing: p(0.00000091, 0.00000286) }

  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  it('two tracked rows of one provider converging on the same successor: one rotates, the other is blocked, the file has ONE row of the successor', async () => {
    liveLists.openrouter = { ...OR_LIVE, models: [g54, ...OR_LIVE.models] }
    const h = makeHarness('conv', {
      config: twoRowCfg,
      env: twoRowEnv,
      tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true, [trackingKey('openrouter', 'z-ai/glm-5.3')]: true },
    })
    const report = await checkModelUpdates(deps)
    const e52 = entryFor(report, 'h_conv', 'z-ai/glm-5.2')!
    const e53 = entryFor(report, 'h_conv', 'z-ai/glm-5.3')!
    expect(e52.successor).toBe('z-ai/glm-5.4')
    expect(e53.successor).toBe('z-ai/glm-5.4')
    expect([e52.applied, e53.applied].filter(Boolean)).toHaveLength(1)
    expect([e52.blocked, e53.blocked].filter(Boolean)).toEqual(['successor-already-in-cascade'])
    const cfg = readConfig('conv')
    expect(cfg.match(/model: z-ai\/glm-5\.4/g)).toHaveLength(1)
    expect(readFallbackProviders(path.join(root, 'conv')).map((r) => r.model).sort()).toEqual(['z-ai/glm-5.3', 'z-ai/glm-5.4'])
    expect(cfg).toContain('key_env: OPENROUTER_KEY_B')
    expect(cfg).toContain('key_env: OPENROUTER_KEY_C')
    expect(cfg).not.toContain('    - z-ai/glm-5.4\n    - z-ai/glm-5.4')
    expect(h.modelTracking).toEqual({ [trackingKey('openrouter', 'z-ai/glm-5.4')]: true, [trackingKey('openrouter', 'z-ai/glm-5.3')]: true })
    const applied = (deps.audit.append as ReturnType<typeof vi.fn>).mock.calls.filter(([e]) => e.what === 'cascade:auto-update')
    expect(applied).toHaveLength(1)
    expect(deps.harness.restart).toHaveBeenCalledTimes(1)
  })

  const grok = (extra: LiveModelList['models']): LiveModelList => ({
    ...OR_LIVE,
    models: [
      { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200, expiration: null, pricing: p(0.00000234, 0.0000117) },
      ...extra,
    ],
  })
  const g47 = { id: 'x-ai/grok-4.7', canonical: 'x-ai/grok-4.7-20260916', created: 1789948800, expiration: null, pricing: p(0.000003, 0.000015) }
  const g49 = { id: 'x-ai/grok-4.9', canonical: 'x-ai/grok-4.9-20260920', created: 1790294400, expiration: null, pricing: p(0.000003, 0.000015) }

  it('a transient live-fetch miss does not erase the last known pricing + release date from the report', async () => {
    makeHarness('miss', { config: fpConfig([['openrouter', 'x-ai/grok-4.7']]), tracking: { [trackingKey('openrouter', 'x-ai/grok-4.7')]: true } })
    liveLists.openrouter = grok([g47])
    settings = { ...settings, mode: 'notify' }
    const first = await checkModelUpdates(deps)
    expect(entryFor(first, 'h_miss', 'x-ai/grok-4.7')!.released).toBe('20260916')
    // Run 2: the provider is unreachable. The entry stays unflagged but keeps what run 1 knew.
    liveLists.openrouter = null
    const second = await checkModelUpdates(deps)
    const e2 = entryFor(second, 'h_miss', 'x-ai/grok-4.7')!
    expect(e2.retired).toBe(false)
    expect(e2.successor).toBeUndefined()
    expect(e2.released).toBe('20260916')
    expect(e2.pricing).toEqual(p(0.000003, 0.000015))
    // Run 3 (apply): 4.7 is gone; 4.20 (older) and 4.9 (newer) are live — the date guard is still armed.
    liveLists.openrouter = grok([g49])
    settings = { ...settings, mode: 'apply' }
    const third = await checkModelUpdates(deps)
    const e3 = entryFor(third, 'h_miss', 'x-ai/grok-4.7')!
    expect(e3.retired).toBe(true)
    expect(e3.successor).toBe('x-ai/grok-4.9')
    expect(e3.applied).toBe(true)
    expect(readConfig('miss')).toContain('model: x-ai/grok-4.9')
  })

  it('a run in which a harness\'s rows cannot be read keeps that harness\'s previous report block', async () => {
    makeHarness('gone', { config: fpConfig([['openrouter', 'x-ai/grok-4.7']]), tracking: { [trackingKey('openrouter', 'x-ai/grok-4.7')]: true } })
    liveLists.openrouter = grok([g47])
    settings = { ...settings, mode: 'notify' }
    await checkModelUpdates(deps)
    // Run 2: config.yaml is momentarily unreadable (0 rows).
    const cfgPath = path.join(root, 'gone', 'config.yaml')
    const saved = fs.readFileSync(cfgPath, 'utf-8')
    fs.rmSync(cfgPath)
    const second = await checkModelUpdates(deps)
    expect(entryFor(second, 'h_gone', 'x-ai/grok-4.7')?.released).toBe('20260916')
    fs.writeFileSync(cfgPath, saved)
    // Run 3 (apply): the date guard still knows 4.20 is older.
    liveLists.openrouter = grok([g49])
    settings = { ...settings, mode: 'apply' }
    const third = await checkModelUpdates(deps)
    const e3 = entryFor(third, 'h_gone', 'x-ai/grok-4.7')!
    expect(e3.successor).toBe('x-ai/grok-4.9')
    expect(e3.applied).toBe(true)
  })

  it('a harness whose cascade was emptied carries only pricing + release date forward, never a phantom successor', async () => {
    makeHarness('emptied', { config: fpConfig([['openrouter', 'x-ai/grok-4.7']]), tracking: { [trackingKey('openrouter', 'x-ai/grok-4.7')]: true } })
    liveLists.openrouter = grok([g47, g49])
    settings = { ...settings, mode: 'notify' }
    const first = await checkModelUpdates(deps)
    const e1 = entryFor(first, 'h_emptied', 'x-ai/grok-4.7')!
    expect(e1.successor).toBe('x-ai/grok-4.9')
    expect(e1.released).toBe('20260916')
    // The operator hand-edits config.yaml down to a bare primary: no
    // fallback_providers at all. The primary IS a chain, so the block is
    // rebuilt from it: the removed row is gone (its tracking key is orphaned),
    // and nothing can render as "1 update available".
    fs.writeFileSync(path.join(root, 'emptied', 'config.yaml'), 'model:\n  provider: ollama\n  default: qwen3:30b\n')
    for (let run = 0; run < 3; run++) {
      const report = await checkModelUpdates(deps)
      const block = report.harnesses.find((h) => h.id === 'h_emptied')!
      expect(block.entries.map((e) => [e.model, e.role])).toEqual([['qwen3:30b', 'primary']])
      expect(block.orphanedTracking).toEqual(['openrouter/x-ai/grok-4.7'])
      expect(entryFor(report, 'h_emptied', 'x-ai/grok-4.7')).toBeUndefined()
    }
    // A file with NEITHER a primary nor rows (unreadable, mid-rewrite) still carries the previous block.
    fs.writeFileSync(path.join(root, 'emptied', 'config.yaml'), 'platforms: {}\n')
    const report = await checkModelUpdates(deps)
    expect(report.harnesses.find((h) => h.id === 'h_emptied')!.entries.map((e) => e.model)).toEqual(['qwen3:30b'])
  })
})

// --- Chain semantics (fix for PR #243's wrong premise) ------------------------
describe('chain semantics: the primary is a tracked entry too', () => {
  beforeEach(() => {
    settings = { ...settings, mode: 'apply' }
  })

  it('cyborg (primary not in the rows): the report lists the primary first with role primary, then each row', async () => {
    settings = { ...settings, mode: 'notify' }
    makeHarness('cyborg', { config: CYBORG })
    const report = await checkModelUpdates(deps)
    const entries = report.harnesses.find((h) => h.id === 'h_cyborg')!.entries
    expect(entries.map((e) => [e.provider, e.model, e.role])).toEqual([
      ['openrouter', 'z-ai/glm-5.3', 'primary'],
      ['anthropic', 'claude-sonnet-4-6', 'fallback'],
      ['openrouter', 'anthropic/claude-sonnet-4.6', 'fallback'],
      ['openrouter', 'deepseek/deepseek-v4-flash-0731', 'fallback'],
      ['ollama', 'qwen3.5:9b', 'fallback'],
    ])
  })

  it('cryptids (primary duplicated as row 0): ONE entry for the primary, not two', async () => {
    settings = { ...settings, mode: 'notify' }
    makeHarness('cryptids', { config: CRYPTIDS })
    const report = await checkModelUpdates(deps)
    const entries = report.harnesses.find((h) => h.id === 'h_cryptids')!.entries
    expect(entries.map((e) => [e.model, e.role])).toEqual([
      ['z-ai/glm-5.3', 'primary'],
      ['claude-sonnet-4-6', 'fallback'],
      ['qwen3:30b', 'fallback'],
    ])
  })

  it('rotating a tracked PRIMARY on a file that does not repeat it rewrites model.default and adds no row', async () => {
    const cfg = CYBORG.replace('  default: z-ai/glm-5.3', '  default: z-ai/glm-5.2')
    makeHarness('cyb', { config: cfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_cyb', 'z-ai/glm-5.2')!
    expect(e.role).toBe('primary')
    expect(e.applied).toBe(true)
    expect(readConfig('cyb')).toBe(cfg.replace('  default: z-ai/glm-5.2', '  default: z-ai/glm-5.3'))
    expect(readCascade(path.join(root, 'cyb')).primaryDuplicatedAsRow0).toBe(false)
    expect(harnesses.find((h) => h.id === 'h_cyb')!.modelTracking).toEqual({ [trackingKey('openrouter', 'z-ai/glm-5.3')]: true })
  })

  it('rotating a tracked PRIMARY on a file that repeats it rewrites model.default AND the duplicate row 0 together', async () => {
    const cfg = CRYPTIDS.replaceAll('z-ai/glm-5.3', 'z-ai/glm-5.2')
    makeHarness('cry', { config: cfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    expect(entryFor(report, 'h_cry', 'z-ai/glm-5.2')!.applied).toBe(true)
    expect(readConfig('cry')).toBe(CRYPTIDS)
    const after = readCascade(path.join(root, 'cry'))
    expect(after.primaryDuplicatedAsRow0).toBe(true)
    // A duplicate row that no longer matched the primary after a rotation would be a bug.
    expect(after.fallbacks[0]).toEqual(after.primary)
  })

  it('a tracked fallback whose successor is the PRIMARY is blocked (successor-already-in-cascade)', async () => {
    // matilde-shaped, but the primary is glm-5.3 and a fallback row is glm-5.2.
    const cfg = MATILDE.replace('  default: moonshotai/kimi-k3', '  default: z-ai/glm-5.3').replace('    model: z-ai/glm-5.3', '    model: z-ai/glm-5.2')
    makeHarness('succ', { config: cfg, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.2')]: true } })
    const report = await checkModelUpdates(deps)
    const e = entryFor(report, 'h_succ', 'z-ai/glm-5.2')!
    expect(e.successor).toBe('z-ai/glm-5.3')
    expect(e.blocked).toBe('successor-already-in-cascade')
    expect(readConfig('succ')).toBe(cfg)
  })

  it('orphaned tracking is judged against the chain: the primary\'s key is never an orphan', async () => {
    settings = { ...settings, mode: 'notify' }
    makeHarness('orph', { config: CYBORG, tracking: { [trackingKey('openrouter', 'z-ai/glm-5.3')]: true, [trackingKey('openrouter', 'gone/model')]: true } })
    const report = await checkModelUpdates(deps)
    const h = report.harnesses.find((x) => x.id === 'h_orph')!
    expect(h.orphanedTracking).toEqual(['openrouter/gone/model'])
    expect(entryFor(report, 'h_orph', 'z-ai/glm-5.3')!.tracked).toBe(true)
  })

  it('manual apply on the primary (not in the rows) works by model id, no provider needed', async () => {
    const cfg = CYBORG.replace('  default: z-ai/glm-5.3', '  default: z-ai/glm-5.2')
    makeHarness('man', { config: cfg })
    const res = await applyModelUpdate({ harnessId: 'h_man', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' }, deps)
    expect(res.ok).toBe(true)
    expect(readConfig('man')).toBe(CYBORG)
    expect(cascadeChain(readCascade(path.join(root, 'man')))[0].model).toBe('z-ai/glm-5.3')
  })
})
