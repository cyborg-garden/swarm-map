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
    fs.rmSync(storage.getBaseDir(), { recursive: true, force: true })
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

  it('nor is it scanned when a caller names it outright', () => {
    // list(names) takes names from its caller. The stored row decides, not the list.
    storage.write('harnesses.json', [
      { id: 'h_kept', name: 'kept', runtime: 'hermes' },
      { id: 'h_old', name: 'old', runtime: Object.keys(RETIRED_RUNTIMES)[0] },
    ])
    expect(keys.list(['old', 'kept']).flatMap((k) => k.assignedTo ?? [])).toEqual(['h_kept'])
  })

  it('control: the same row tagged hermes IS scanned', () => {
    storage.write('harnesses.json', [{ id: 'h_old', name: 'old', runtime: 'hermes' }])
    expect(assigned()).toContain('h_old')
  })
})

// Key assignment takes harness ids from the request body and writes the value
// into ~/.hermes-<name>/.env. An id whose row Swarm Map does not manage is
// not a Hermes agent: nothing is written there and it is never recorded as
// assigned.
describe('key assignment leaves rows Swarm Map does not manage alone', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let storage: Storage
  let keys: KeysService
  const ROWS = [
    { id: 'h_kept', name: 'kept', runtime: 'hermes' },
    { id: 'h_old', name: 'old', runtime: Object.keys(RETIRED_RUNTIMES)[0] },
    { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future' },
  ]
  const envPath = (name: string) => path.join(tmpHome, `.hermes-${name}`, '.env')
  const env = (name: string) => fs.readFileSync(envPath(name), 'utf-8')
  const SEED = 'EXISTING=1\nBRAVE_SEARCH_API_KEY=old-brave\n'

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-retired-assign-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-retired-assign-store-')))
    keys = new KeysService(storage, new AuditService(storage))
    storage.write('harnesses.json', ROWS)
    for (const name of ['old', 'kept', 'odd']) {
      fs.mkdirSync(path.join(tmpHome, `.hermes-${name}`))
      fs.writeFileSync(envPath(name), SEED)
    }
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(storage.getBaseDir(), { recursive: true, force: true })
  })

  it.each(['h_old', 'old', 'h_odd'])('writeKeyToEnv(%s) writes nothing and says so', (id) => {
    expect(keys.writeKeyToEnv(id, 'brave', 'new-brave')).toBe(false)
    expect(env('old')).toBe(SEED)
    expect(env('odd')).toBe(SEED)
  })

  it.each(['h_old', 'old', 'h_odd'])('removeKeyFromEnv(%s) removes nothing', (id) => {
    keys.removeKeyFromEnv(id, 'brave')
    expect(env('old')).toBe(SEED)
    expect(env('odd')).toBe(SEED)
  })

  it('a refused write leaves an audit line naming the agent', () => {
    keys.writeKeyToEnv('h_old', 'brave', 'new-brave')
    const audit = fs.readFileSync(path.join(storage.getBaseDir(), 'audit.jsonl'), 'utf-8')
    expect(audit).toContain('key:refused-unmanaged-row')
    expect(audit).toContain('"old"')
  })

  it('writeKeyToEnv does not create a home for an unmanaged id that has none', () => {
    fs.rmSync(path.join(tmpHome, '.hermes-old'), { recursive: true })
    expect(keys.writeKeyToEnv('h_old', 'brave', 'new-brave')).toBe(false)
    expect(fs.existsSync(path.join(tmpHome, '.hermes-old'))).toBe(false)
  })

  it('add() does not record an unmanaged id as assigned', () => {
    const key = keys.add({ provider: 'brave', value: 'new-brave', assignedTo: ['h_old', 'h_kept', 'h_odd'] })
    expect(key.assignedTo).toEqual(['h_kept'])
  })

  it('setAssignment() drops unmanaged ids, writes only to the managed agent', () => {
    const key = keys.add({ provider: 'brave', value: 'new-brave', assignedTo: [] })
    const affected = keys.setAssignment(key.id, ['h_old', 'h_kept', 'h_odd'])
    expect(affected).toEqual(['h_kept'])
    expect(keys.list().find((k) => k.id === key.id)?.assignedTo).toEqual(['h_kept'])
    expect(env('kept')).toContain('BRAVE_SEARCH_API_KEY=new-brave')
    expect(env('old')).toBe(SEED)
    expect(env('odd')).toBe(SEED)
  })

  it('resync() skips an unmanaged id that an older keys.json still lists', () => {
    const key = keys.add({ provider: 'brave', value: 'new-brave', assignedTo: ['h_kept'] })
    // What a keys.json written before the row was retired can hold.
    const stored = storage.read<Array<{ id: string; assignedTo: string[] }>>('keys.json', [])
    stored.find((k) => k.id === key.id)!.assignedTo = ['h_old', 'h_kept']
    storage.write('keys.json', stored)
    const result = keys.resync(key.id)
    expect(result?.changed).toEqual(['h_kept'])
    expect(env('old')).toBe(SEED)
  })

  it('control: the same calls on the managed agent DO write', () => {
    expect(keys.writeKeyToEnv('h_kept', 'brave', 'new-brave')).toBe(true)
    expect(env('kept')).toContain('BRAVE_SEARCH_API_KEY=new-brave')
    keys.removeKeyFromEnv('h_kept', 'brave')
    expect(env('kept')).not.toContain('BRAVE_SEARCH_API_KEY')
  })
})
