// @vitest-environment node
//
// Settings round-trip for the model-update policy, against a real
// ConfigService on a tmpdir Storage (no mocks between route and disk).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Storage } from '@/lib/services/storage'
import { ConfigService, validateModelAutoUpdate, validateSettingsPatch, DEFAULT_MODEL_AUTO_UPDATE } from '@/lib/services/config'

let dir: string
const state = vi.hoisted(() => ({ config: undefined as unknown, audit: { append: vi.fn() } }))
const audit = state.audit

vi.mock('@/lib/services', () => ({
  services: {
    get config() {
      return state.config
    },
    audit: state.audit,
  },
}))

import { GET, PUT } from './route'

const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/settings/model-auto-update', { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-model-auto-update-'))
  state.config = new ConfigService(new Storage(dir))
  audit.append.mockReset()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('/api/settings/model-auto-update', () => {
  it('GET returns the defaults (disabled, notify, 24h, 1.5×) before anything is set', async () => {
    expect(await (await GET()).json()).toEqual(DEFAULT_MODEL_AUTO_UPDATE)
    expect(DEFAULT_MODEL_AUTO_UPDATE).toEqual({ enabled: false, mode: 'notify', intervalHours: 24, maxPriceMultiplier: 1.5 })
  })

  it('PUT merges a partial patch, persists it, audits, and GET reads it back', async () => {
    const res = await put({ enabled: true, mode: 'apply' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true, mode: 'apply', intervalHours: 24, maxPriceMultiplier: 1.5 })
    expect(await (await GET()).json()).toEqual({ enabled: true, mode: 'apply', intervalHours: 24, maxPriceMultiplier: 1.5 })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).modelAutoUpdate.mode).toBe('apply')
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ who: 'api', what: 'settings:model-auto-update' }))

    const res2 = await put({ maxPriceMultiplier: 2 })
    expect(await res2.json()).toEqual({ enabled: true, mode: 'apply', intervalHours: 24, maxPriceMultiplier: 2 })
  })

  it('PUT rejects a bad mode, a non-positive interval, an unknown key, and a non-object', async () => {
    expect((await put({ mode: 'yolo' })).status).toBe(400)
    expect((await put({ intervalHours: 0 })).status).toBe(400)
    expect((await put({ maxPriceMultiplier: -1 })).status).toBe(400)
    expect((await put({ evil: true })).status).toBe(400)
    expect((await put([1])).status).toBe(400)
    expect((await put('x')).status).toBe(400)
    // nothing persisted
    expect(await (await GET()).json()).toEqual(DEFAULT_MODEL_AUTO_UPDATE)
    expect(audit.append).not.toHaveBeenCalled()
  })
})

describe('validateModelAutoUpdate / validateSettingsPatch', () => {
  it('a full block validates and is accepted under settings.modelAutoUpdate', () => {
    const block = { enabled: true, mode: 'notify', intervalHours: 6, maxPriceMultiplier: 1.1 }
    expect(validateModelAutoUpdate(block)).toEqual(block)
    expect(validateSettingsPatch({ modelAutoUpdate: block })).toEqual({ modelAutoUpdate: block })
  })
  it('a partial block is rejected at the settings layer (the route merges first)', () => {
    expect(() => validateSettingsPatch({ modelAutoUpdate: { enabled: true } })).toThrow(/mode/)
  })
})
