import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KeysService } from '../keys'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

// A key is written into the .env of the agents it is assigned to. The agent
// is named by a harness id or name, which must be a well-formed one (letters,
// digits, '_' and '-') before it is turned into a directory.
describe('keys: the agent a key is written to must be a well-formed id', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-envtarget-home-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-envtarget-store-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage))
    fs.mkdirSync(path.join(tmpHome, '.hermes-real'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, '.hermes-real', '.env'), 'KEEP=1\n')
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  const BAD = ['../outside', 'x/../.hermes-real', 'h_x/../.hermes-real', 'a/b', '..', 'h_a.b', 'h_a b', '']
  const homeListing = () => fs.readdirSync(tmpHome).sort()
  const realEnv = () => fs.readFileSync(path.join(tmpHome, '.hermes-real', '.env'), 'utf-8')
  const unchanged = (label: string) => {
    expect(homeListing(), label).toEqual(['.hermes-real'])
    expect(realEnv(), label).toBe('KEEP=1\n')
  }

  it('writeKeyToEnv refuses it and writes nothing', () => {
    for (const bad of BAD) {
      expect(() => keys.writeKeyToEnv(bad, 'openai', 'value-1'), JSON.stringify(bad)).toThrow('Invalid harness id')
      unchanged(JSON.stringify(bad))
    }
  })

  it('removeKeyFromEnv leaves every file alone', () => {
    fs.writeFileSync(path.join(tmpHome, '.hermes-real', '.env'), 'KEEP=1\nOPENAI_API_KEY=value-1\n')
    for (const bad of BAD) keys.removeKeyFromEnv(bad, 'openai')
    expect(realEnv()).toBe('KEEP=1\nOPENAI_API_KEY=value-1\n')
    expect(homeListing()).toEqual(['.hermes-real'])
  })

  it('add refuses it and stores no key', () => {
    for (const bad of BAD) {
      expect(() => keys.add({ provider: 'openai', value: 'value-1', assignedTo: ['h_real', bad] }), JSON.stringify(bad)).toThrow('Invalid harness id')
    }
    expect(keys.list().filter((k) => k.provider === 'openai')).toEqual([])
    unchanged('add')
  })

  it('setAssignment refuses it and changes neither the key nor any .env', () => {
    const key = keys.add({ provider: 'openai', value: 'value-1', assignedTo: [] })
    for (const bad of BAD) {
      expect(() => keys.setAssignment(key.id, ['h_real', bad]), JSON.stringify(bad)).toThrow('Invalid harness id')
      expect(keys.list().find((k) => k.id === key.id)?.assignedTo, JSON.stringify(bad)).toEqual([])
      unchanged(JSON.stringify(bad))
    }
  })

  it('rotateValue refuses it and keeps the old value and assignment', () => {
    const key = keys.add({ provider: 'openai', value: 'value-1', assignedTo: [] })
    for (const bad of BAD) {
      expect(() => keys.rotateValue(key.id, 'value-2', { assignedTo: [bad] }), JSON.stringify(bad)).toThrow('Invalid harness id')
      expect(keys.getDecryptedValue(key.id), JSON.stringify(bad)).toBe('value-1')
      unchanged(JSON.stringify(bad))
    }
  })

  it('still writes to an agent named by id or by name', () => {
    keys.writeKeyToEnv('h_real', 'openai', 'value-1')
    expect(realEnv()).toContain('OPENAI_API_KEY=value-1')
    keys.writeKeyToEnv('real', 'openai', 'value-2')
    expect(realEnv()).toContain('OPENAI_API_KEY=value-2')
  })
})
