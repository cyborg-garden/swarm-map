import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KeysService } from '../keys'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Regression suite for the key/.env drift bug: a key could be assigned to a
// harness in keys.json without its var ever reaching that harness's .env, and
// deleting a key left its (now stale) var behind in every assigned agent's .env.
// The agent then booted with a missing or stale credential.
describe('keys .env sync (assign / unassign / remove)', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-envsync-home-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-envsync-store-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  const envFor = (name: string) => path.join(tmpHome, `.hermes-${name}`, '.env')
  const readEnv = (name: string) => {
    try { return fs.readFileSync(envFor(name), 'utf-8') } catch { return '' }
  }

  const GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

  describe('an agent marked no-anthropic', () => {
    const ANT = ['sk', 'ant', 'api03', 'not-a-real-key'].join('-')
    beforeEach(() => {
      fs.mkdirSync(path.join(tmpHome, '.hermes-zdr'), { recursive: true })
      fs.writeFileSync(path.join(tmpHome, '.hermes-zdr', '.hsm-no-anthropic'), '')
    })

    it('never has an Anthropic key written, by any route', () => {
      const key = keys.add({ provider: 'anthropic', value: ANT, assignedTo: [] })
      expect(keys.writeKeyToEnv('h_zdr', 'anthropic', ANT)).toBe(false)
      keys.setAssignment(key.id, ['h_zdr', 'h_other'])
      keys.resync(key.id)
      keys.rotateValue(key.id, ANT + 'X')
      expect(readEnv('zdr')).toBe('')
      expect(readEnv('other')).toMatch(/^ANTHROPIC_API_KEY=/m)
    })

    it('does not show as assigned on paper', () => {
      const key = keys.add({ provider: 'anthropic', value: ANT, assignedTo: [] })
      keys.setAssignment(key.id, ['h_zdr', 'h_other'])
      expect(keys.list().find((k) => k.id === key.id)?.assignedTo).toEqual(['h_other'])
    })

    it('refuses an Anthropic value filed under another provider', () => {
      expect(keys.writeKeyToEnv('h_zdr', 'custom', ANT, { envVar: 'SOME_KEY' })).toBe(false)
      expect(readEnv('zdr')).toBe('')
    })

    it('refuses by target variable and by any spelling of the provider', () => {
      expect(keys.writeKeyToEnv('h_zdr', 'custom', 'cc-abc', { envVar: 'ANTHROPIC_TOKEN' })).toBe(false)
      expect(keys.writeKeyToEnv('h_zdr', 'Anthropic', 'eyJabc')).toBe(false)
      expect(readEnv('zdr')).toBe('')
    })

    it('add and rotate do not record the agent either', () => {
      const key = keys.add({ provider: 'anthropic', value: ANT, assignedTo: ['h_zdr', 'h_other'] })
      expect(key.assignedTo).toEqual(['h_other'])
      expect(keys.rotateValue(key.id, ANT + 'X', { assignedTo: ['h_zdr', 'h_other'] })?.assignedTo).toEqual(['h_other'])
    })

    it('still takes other keys', () => {
      expect(keys.writeKeyToEnv('h_zdr', 'github', GH)).toBe(true)
      expect(readEnv('zdr')).toMatch(/^GITHUB_TOKEN=/m)
    })
  })

  // ASSUMPTION (bug): deleting a key leaves its var in each assigned agent's
  // .env — the agent keeps running with a credential the operator thinks is gone.
  it('remove() strips the key var from every assigned harness .env', () => {
    const key = keys.add({ provider: 'github', value: GH, assignedTo: ['h_nimbleco'] })
    keys.writeKeyToEnv('h_nimbleco', 'github', GH)
    expect(readEnv('nimbleco')).toMatch(/^GITHUB_TOKEN=/m)

    keys.remove(key.id)
    expect(readEnv('nimbleco')).not.toMatch(/^GITHUB_TOKEN=/m)
  })

  it('remove() preserves unrelated vars in the assigned .env', () => {
    fs.mkdirSync(path.join(tmpHome, '.hermes-nimbleco'), { recursive: true })
    fs.writeFileSync(envFor('nimbleco'), 'SIGNAL_ACCOUNT=+100\n')
    const key = keys.add({ provider: 'github', value: GH, assignedTo: ['h_nimbleco'] })
    keys.writeKeyToEnv('h_nimbleco', 'github', GH)

    keys.remove(key.id)
    const env = readEnv('nimbleco')
    expect(env).toMatch(/^SIGNAL_ACCOUNT=\+100$/m)
    expect(env).not.toMatch(/^GITHUB_TOKEN=/m)
  })

  // ASSUMPTION (bug): recording an assignment must also materialize the value
  // into the newly-assigned agent's .env. setAssignment is the consistent
  // service-level primitive that does both (routes should call it).
  it('setAssignment() writes the value into a newly-assigned harness .env', () => {
    const key = keys.add({ provider: 'github', value: GH }) // added, unassigned, no env write
    expect(readEnv('nimbleco')).not.toMatch(/GITHUB_TOKEN/)

    keys.setAssignment(key.id, ['h_nimbleco'])
    expect(readEnv('nimbleco')).toMatch(new RegExp(`^GITHUB_TOKEN=${GH}$`, 'm'))
  })

  it('setAssignment() removes the var from a dropped harness .env', () => {
    const key = keys.add({ provider: 'github', value: GH })
    keys.setAssignment(key.id, ['h_nimbleco'])
    expect(readEnv('nimbleco')).toMatch(/^GITHUB_TOKEN=/m)

    keys.setAssignment(key.id, [])
    expect(readEnv('nimbleco')).not.toMatch(/^GITHUB_TOKEN=/m)
  })

  it('setAssignment() reflects the assignment in keys.json / list()', () => {
    const key = keys.add({ provider: 'github', value: GH })
    keys.setAssignment(key.id, ['h_nimbleco'])
    expect(keys.list([]).find((k) => k.id === key.id)!.assignedTo).toEqual(['h_nimbleco'])
  })

  // setAssignment returns exactly the harnesses whose .env changed, so the route
  // knows which containers to recreate (env_file is read at container creation).
  it('setAssignment() returns the affected harnesses (added ∪ removed)', () => {
    const key = keys.add({ provider: 'github', value: GH, assignedTo: ['h_a'] })
    keys.setAssignment(key.id, ['h_a']) // materialize initial assignment
    const affected = keys.setAssignment(key.id, ['h_b']) // drop a, add b
    expect([...affected].sort()).toEqual(['h_a', 'h_b'])
  })
})

// Bluesky writes a PAIR of vars (identifier + app password). Assignment and
// removal must keep both halves in lockstep with keys.json.
describe('bluesky pair .env sync (assign / unassign / remove)', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bskysync-home-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bskysync-store-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  const readEnv = (name: string) => {
    try { return fs.readFileSync(path.join(tmpHome, `.hermes-${name}`, '.env'), 'utf-8') } catch { return '' }
  }

  const PASS = 'abcd-efgh-ijkl-mnop'

  it('setAssignment() writes both vars into a newly-assigned harness .env', () => {
    const key = keys.add({ provider: 'bluesky', value: PASS, identifier: 'nimbleco.ai' })
    keys.setAssignment(key.id, ['h_iris'])
    const env = readEnv('iris')
    expect(env).toMatch(new RegExp(`^BLUESKY_APP_PASSWORD=${PASS}$`, 'm'))
    expect(env).toMatch(/^BLUESKY_IDENTIFIER=nimbleco\.ai$/m)
  })

  it('setAssignment() strips both vars from a dropped harness .env', () => {
    const key = keys.add({ provider: 'bluesky', value: PASS, identifier: 'nimbleco.ai' })
    keys.setAssignment(key.id, ['h_iris'])
    keys.setAssignment(key.id, [])
    const env = readEnv('iris')
    expect(env).not.toMatch(/BLUESKY_APP_PASSWORD/)
    expect(env).not.toMatch(/BLUESKY_IDENTIFIER/)
  })

  it('remove() strips both vars from every assigned harness .env', () => {
    const key = keys.add({ provider: 'bluesky', value: PASS, identifier: 'nimbleco.ai' })
    keys.setAssignment(key.id, ['h_iris'])
    keys.remove(key.id)
    const env = readEnv('iris')
    expect(env).not.toMatch(/BLUESKY_APP_PASSWORD/)
    expect(env).not.toMatch(/BLUESKY_IDENTIFIER/)
  })

  it('rotateValue() rewrites the pair with the (possibly updated) identifier', () => {
    const key = keys.add({ provider: 'bluesky', value: PASS, identifier: 'old.handle' })
    keys.setAssignment(key.id, ['h_iris'])
    keys.rotateValue(key.id, 'qrst-uvwx-yzab-cdef', { identifier: 'new.handle' })
    const env = readEnv('iris')
    expect(env).toMatch(/^BLUESKY_APP_PASSWORD=qrst-uvwx-yzab-cdef$/m)
    expect(env).toMatch(/^BLUESKY_IDENTIFIER=new\.handle$/m)
  })
})
