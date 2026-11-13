// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KeysService } from '../keys'
import { RETIRED_RUNTIMES } from '../runtime-adapter'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('KeysService', () => {
  let tmpDir: string
  let keys: KeysService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-keys2-'))
    const storage = new Storage(tmpDir)
    const audit = new AuditService(storage)
    keys = new KeysService(storage, audit)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adds a manual key and masks the value', () => {
    const key = keys.add({ provider: 'anthropic', value: 'sk-ant-12345678' })
    expect(key.maskedValue).toBe('sk-a…5678')
    expect(key.health).toBe('good')
  })

  it('lists manual keys without raw values', () => {
    keys.add({ provider: 'test', value: 'secret-token-value-here' })
    const list = keys.list([])
    expect(list.length).toBeGreaterThanOrEqual(1)
    // The raw value must never appear
    const serialized = JSON.stringify(list)
    expect(serialized).not.toContain('secret-token-value-here')
  })

  it('removes a manual key', () => {
    const key = keys.add({ provider: 'removeme', value: 'remove-this-key' })
    const removed = keys.remove(key.id)
    expect(removed).toBe(true)
  })
})

describe('notion token detection (env discovery)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-notion-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-notion-store-')))
    keys = new KeysService(storage, new AuditService(storage))
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const writeAgentEnv = (name: string, line: string) => {
    const dir = path.join(tmpHome, `.hermes-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), line + '\n')
  }

  it('detects a legacy secret_-prefixed NOTION_API_KEY as notion', () => {
    writeAgentEnv('a', 'NOTION_API_KEY=secret_LEGACYTOKEN12345')
    const found = keys.list(['a']).find((k) => k.provider === 'notion')
    expect(found).toBeTruthy()
  })

  it('detects a current ntn_-prefixed NOTION_API_KEY as notion', () => {
    writeAgentEnv('b', 'NOTION_API_KEY=ntn_NEWSTYLETOKEN12345')
    const found = keys.list(['b']).find((k) => k.provider === 'notion')
    expect(found).toBeTruthy()
  })

  it('detects an ntn_-prefixed NOTION_TOKEN as notion', () => {
    writeAgentEnv('c', 'NOTION_TOKEN=ntn_NEWSTYLETOKEN67890')
    const found = keys.list(['c']).find((k) => k.provider === 'notion')
    expect(found).toBeTruthy()
  })
})

describe('bluesky pair detection (env discovery)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bsky-disc-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bsky-disc-store-')))
    keys = new KeysService(storage, new AuditService(storage))
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeAgentEnv(name: string, content: string) {
    const dir = path.join(tmpHome, `.hermes-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), content + '\n')
  }

  it('detects BLUESKY_APP_PASSWORD as a bluesky key carrying its companion identifier', () => {
    writeAgentEnv('a', 'BLUESKY_IDENTIFIER=nimbleco.ai\nBLUESKY_APP_PASSWORD=abcd-efgh-ijkl-mnop')
    const found = keys.list(['a']).find((k) => k.provider === 'bluesky')
    expect(found).toBeTruthy()
    expect(found!.identifier).toBe('nimbleco.ai')
  })

  it('does NOT surface BLUESKY_IDENTIFIER as a key of its own', () => {
    writeAgentEnv('b', 'BLUESKY_IDENTIFIER=nimbleco.ai')
    expect(keys.list(['b'])).toHaveLength(0)
  })

  it('detects the app password even without a companion identifier', () => {
    writeAgentEnv('c', 'BLUESKY_APP_PASSWORD=abcd-efgh-ijkl-mnop')
    const found = keys.list(['c']).find((k) => k.provider === 'bluesky')
    expect(found).toBeTruthy()
    expect(found!.identifier).toBeUndefined()
  })
})

describe('key discovery skips rows Swarm Map does not manage', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let storage: Storage
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-retired-keys-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-retired-keys-store-')))
    keys = new KeysService(storage, new AuditService(storage))
    for (const name of ['old', 'kept', 'odd']) {
      fs.mkdirSync(path.join(tmpHome, `.hermes-${name}`))
      fs.writeFileSync(path.join(tmpHome, `.hermes-${name}`, '.env'), `OPENROUTER_API_KEY=sk-or-v1-${name}-0123456789abcdef\n`)
    }
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const assigned = () => keys.list().flatMap((k) => k.assignedTo ?? [])

  it('a retired row\'s name is not resolved to ~/.hermes-<name>', () => {
    storage.write('harnesses.json', [
      { id: 'h_kept', name: 'kept', runtime: 'hermes' },
      { id: 'h_old', name: 'old', runtime: Object.keys(RETIRED_RUNTIMES)[0] },
      { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future' },
    ])
    expect(assigned()).toContain('h_kept')
    expect(assigned()).not.toContain('h_old')
    expect(assigned()).not.toContain('h_odd')
  })

  it('control: the same row tagged hermes IS scanned', () => {
    storage.write('harnesses.json', [{ id: 'h_old', name: 'old', runtime: 'hermes' }])
    expect(assigned()).toContain('h_old')
  })
})
