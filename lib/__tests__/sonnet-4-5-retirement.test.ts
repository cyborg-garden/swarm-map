// @vitest-environment node
//
// Sonnet 4.5 retires on 2026-11-30. It must not be offered anywhere a model
// can be picked, while an agent whose stored config still names it stays
// readable, writable and visibly flagged as retired (#136 pattern: flag, do
// not delete).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MODEL_CATALOG, isCatalogRetired, validateCascadeEntries } from '../model-catalog'
import { Storage } from '../services/storage'
import { ConfigService } from '../services/config'

const RETIRED_IDS = ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']

describe('Sonnet 4.5 retirement — catalog', () => {
  it('lists Sonnet 4.5 as retired with its 2026-11-30 date, never as a live row', () => {
    for (const id of RETIRED_IDS) {
      const row = MODEL_CATALOG.anthropic.find((m) => m.id === id)
      expect(row, id).toBeDefined()
      expect(row!.retired).toBe(true)
      expect(row!.deprecates).toBe('2026-11-30')
    }
  })

  it('isCatalogRetired flags the retired ids and nothing current', () => {
    for (const id of RETIRED_IDS) expect(isCatalogRetired('anthropic', id)).toBe(true)
    expect(isCatalogRetired(' Anthropic ', 'claude-sonnet-4-5')).toBe(true)
    expect(isCatalogRetired('anthropic', 'claude-sonnet-4-6')).toBe(false)
    expect(isCatalogRetired('anthropic', 'some-free-text-model')).toBe(false)
    expect(isCatalogRetired('no-such-provider', 'claude-sonnet-4-5')).toBe(false)
    // inherited Object keys are not providers
    expect(isCatalogRetired('constructor', 'claude-sonnet-4-5')).toBe(false)
  })

  it('an existing cascade naming Sonnet 4.5 still validates (fail-open)', () => {
    expect(
      validateCascadeEntries([{ provider: 'anthropic', model: 'claude-sonnet-4-5' }], new Set(['ANTHROPIC_API_KEY'])),
    ).toEqual([])
  })
})

describe('Sonnet 4.5 retirement — built-in model list', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-seed-')) })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a fresh seed does not write Sonnet 4.5 into models.json', async () => {
    vi.stubEnv('DATA_DIR', dir)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.resetModules()
    await import('../seed')
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf-8')) as Array<{ id: string }>
    const ids = models.map((m) => m.id)
    expect(ids).toContain('claude-sonnet-4-6')
    for (const id of RETIRED_IDS) expect(ids).not.toContain(id)
  })

  it('listModels hides a Sonnet 4.5 row an older install already seeded, without deleting it', () => {
    const storage = new Storage(dir)
    const seeded = [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vendor: 'anthropic', accessTier: 'admin', costClass: 'high' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', accessTier: 'admin', costClass: 'high' },
      { id: 'qwen3.5-9b', name: 'Qwen 3.5 9B', vendor: 'ollama', accessTier: 'open', costClass: 'local' },
    ]
    storage.write('models.json', seeded)
    const config = new ConfigService(storage)

    expect(config.listModels().map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'qwen3.5-9b'])

    // Editing another row must not drop the hidden one from disk.
    config.updateModel('qwen3.5-9b', { notes: 'edited' })
    const onDisk = storage.read<Array<{ id: string; notes?: string }>>('models.json', [])
    expect(onDisk.map((m) => m.id)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-5', 'qwen3.5-9b'])
    expect(onDisk[2].notes).toBe('edited')
    // A retired row is not editable through the picker's list.
    expect(config.updateModel('claude-sonnet-4-5', { notes: 'x' })).toBeUndefined()
  })
})
