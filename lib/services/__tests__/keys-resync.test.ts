import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { KeysService } from '../keys'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Regression suite for assigned-on-paper drift that setAssignment cannot repair.
//
// The fleet case: the capsolver key was assigned to h_personal while custom keys
// still resolved to CUSTOM_API_KEY (fixed in #151). The fix changed future
// writes only. setAssignment syncs the DIFF of an assignment, so re-saving an
// unchanged assignment writes nothing, and personal never received
// CAPSOLVER_API_KEY. resync() rewrites an assigned key into its agents' .env.
//
// The layout below mirrors the Mini: personal's data dir is ~/.hermes, and a
// stray ~/.hermes-personal/ exists beside it that no container mounts.
describe('KeysService.resync()', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let storage: Storage
  let keys: KeysService

  const CAP = 'CAP-0123456789abcdef0123456789abcdef'

  const dirFor = (name: string) => path.join(tmpHome, name === 'personal' ? '.hermes' : `.hermes-${name}`)
  const envFor = (name: string) => path.join(dirFor(name), '.env')
  const readEnv = (p: string) => {
    try { return fs.readFileSync(p, 'utf-8') } catch { return '' }
  }
  const seedEnv = (p: string, body: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-resync-home-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-resync-store-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  // A key recorded as assigned to personal + nimbleco, with only nimbleco's
  // .env carrying the right var. Personal holds the pre-#151 misnamed var.
  function seedDriftedFleet() {
    seedEnv(envFor('personal'), 'MATTERMOST_TOKEN=mm\nCUSTOM_API_KEY=' + CAP + '\n')
    seedEnv(path.join(tmpHome, '.hermes-personal', '.env'), 'STRAY=1\n')
    seedEnv(envFor('nimbleco'), 'CAPSOLVER_API_KEY=' + CAP + '\n')
    seedEnv(envFor('osint'), 'OTHER=1\n')
    return keys.add({ provider: 'custom', name: 'capsolver', envVar: 'CAPSOLVER_API_KEY', value: CAP, assignedTo: ['h_personal', 'h_nimbleco'] })
  }

  it('setAssignment() with an unchanged assignment cannot repair drift (why resync exists)', () => {
    const key = seedDriftedFleet()
    expect(keys.setAssignment(key.id, ['h_personal', 'h_nimbleco'])).toEqual([])
    expect(readEnv(envFor('personal'))).not.toMatch(/^CAPSOLVER_API_KEY=/m)
  })

  it('writes the value into personal at ~/.hermes/.env, never ~/.hermes-personal/.env', () => {
    const key = seedDriftedFleet()
    const before = fs.readFileSync(path.join(tmpHome, '.hermes-personal', '.env'), 'utf-8')

    keys.resync(key.id, ['h_personal'])

    expect(readEnv(path.join(tmpHome, '.hermes', '.env'))).toMatch(new RegExp(`^CAPSOLVER_API_KEY=${CAP}$`, 'm'))
    expect(fs.readFileSync(path.join(tmpHome, '.hermes-personal', '.env'), 'utf-8')).toBe(before)
  })

  it('preserves unrelated vars and leaves the legacy misnamed var alone', () => {
    const key = seedDriftedFleet()
    keys.resync(key.id, ['h_personal'])
    const env = readEnv(envFor('personal'))
    expect(env).toMatch(/^MATTERMOST_TOKEN=mm$/m)
    expect(env).toMatch(/^CUSTOM_API_KEY=/m)
  })

  it('returns only the harnesses whose .env actually changed', () => {
    const key = seedDriftedFleet()
    expect(keys.resync(key.id)!.changed).toEqual(['h_personal'])
    // Second pass is a no-op: nothing to recreate.
    expect(keys.resync(key.id)!.changed).toEqual([])
  })

  it('does not rewrite an already-correct .env (no mtime churn)', () => {
    const key = seedDriftedFleet()
    const p = envFor('nimbleco')
    const old = new Date('2026-01-01T00:00:00Z')
    fs.utimesSync(p, old, old)
    keys.resync(key.id)
    expect(fs.statSync(p).mtimeMs).toBe(old.getTime())
  })

  it('never writes to a harness the key is not assigned to', () => {
    const key = seedDriftedFleet()
    const result = keys.resync(key.id, ['h_osint'])!
    expect(result.changed).toEqual([])
    expect(result.notAssigned).toEqual(['h_osint'])
    expect(readEnv(envFor('osint'))).toBe('OTHER=1\n')
  })

  it('without a harness list, resyncs every assigned harness and no others', () => {
    const key = seedDriftedFleet()
    keys.resync(key.id)
    expect(readEnv(envFor('osint'))).toBe('OTHER=1\n')
    expect(fs.existsSync(path.join(tmpHome, '.hermes-cyborg'))).toBe(false)
  })

  it('returns undefined for an unknown key', () => {
    expect(keys.resync('k_nope')).toBeUndefined()
  })

  it('audits the resync without the value', () => {
    const key = seedDriftedFleet()
    keys.resync(key.id, ['h_personal'])
    const log = fs.readFileSync(path.join(tmpStore, 'audit.jsonl'), 'utf-8')
    expect(log).toMatch(/"what":"key:resync"/)
    expect(log).not.toContain(CAP)
  })
})
