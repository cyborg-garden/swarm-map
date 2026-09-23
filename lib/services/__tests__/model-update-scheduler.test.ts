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
