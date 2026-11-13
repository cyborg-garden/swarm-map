// @vitest-environment node
/**
 * Making a new agent from a name (create, import) checks the name against the
 * stored agents first. A name that is taken is refused before a directory is
 * made, a file is copied or a .env is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@/lib/services/docker')
vi.mock('child_process')

import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'

let home: string
let source: string
let storage: Storage
let harness: HarnessService

const ROWS = [
  { id: 'h_taken', name: 'taken' },
  { id: 'h_personal', name: 'personal' },
]

// Everything under the fake home, as "relative/path" → file bytes (dirs end in '/').
function snapshot(dir = home, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + e.name
    if (e.isDirectory()) {
      out[rel + '/'] = ''
      Object.assign(out, snapshot(path.join(dir, e.name), rel + '/'))
    } else {
      out[rel] = fs.readFileSync(path.join(dir, e.name), 'utf-8')
    }
  }
  return out
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'name-taken-home-'))
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'name-taken-src-'))
  fs.writeFileSync(path.join(source, '.env'), 'OPENAI_API_KEY=from-source\n')
  fs.writeFileSync(path.join(source, 'config.yaml'), 'model: x\n')
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  fs.mkdirSync(path.join(home, 'data'))
  storage = new Storage(path.join(home, 'data'))
  storage.write('settings.json', { hermesDir: home, dataDir: path.join(home, 'data'), theme: 'light', composeFiles: [] })
  storage.write('harnesses.json', ROWS)
  const docker = new DockerService()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(docker.isAvailable as any).mockReturnValue(false)
  harness = new HarnessService(storage, docker, new AuditService(storage), new ConfigService(storage))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

describe('nameTaken', () => {
  it('is true for a stored name in any spelling that makes the same slug, and for the id built from it', () => {
    for (const name of ['taken', 'Taken', ' TAKEN ', 'taken!', 'personal']) {
      expect(harness.nameTaken(name), name).toBe(true)
    }
    storage.write('harnesses.json', [{ id: 'h_two_words' }])
    expect(harness.nameTaken('two-words')).toBe(true)
    expect(harness.nameTaken('Two Words')).toBe(true)
  })

  it('is true for a stored name even when the row id is not the one built from it', () => {
    // Rows keep the id they were first stored with, so a name can sit on a row
    // whose id says something else.
    storage.write('harnesses.json', [{ id: 'h_first_name', name: 'renamed' }, { id: 'h_no_name' }])
    expect(harness.nameTaken('renamed')).toBe(true)
    expect(harness.nameTaken('Renamed')).toBe(true)
    expect(harness.nameTaken('first-name')).toBe(true)
    expect(harness.nameTaken('no-name')).toBe(true)
    expect(harness.nameTaken('other')).toBe(false)
  })

  it('refuses an import under a name held by a row with another id, before copying anything', async () => {
    storage.write('harnesses.json', [{ id: 'h_first_name', name: 'renamed' }])
    const before = snapshot()
    await expect(harness.importFromDir(source, 'renamed')).rejects.toThrow('already exists')
    expect(snapshot()).toEqual(before)
  })

  it('is false for a free name', () => {
    for (const name of ['free', 'taken2', 'take']) expect(harness.nameTaken(name), name).toBe(false)
  })
})

describe('importFromDir with a taken name', () => {
  it('refuses before copying anything when the stored agent has no data dir on disk', async () => {
    const before = snapshot()
    await expect(harness.importFromDir(source, 'taken')).rejects.toThrow('already exists')
    await expect(harness.importFromDir(source, 'Taken')).rejects.toThrow('already exists')
    expect(snapshot()).toEqual(before)
    expect(fs.existsSync(path.join(home, '.hermes-taken'))).toBe(false)
  })

  it('refuses before touching the directory when it is imported in place', async () => {
    const dir = path.join(home, '.hermes-taken')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=keep\n')
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'model: keep\n')
    const before = snapshot()
    await expect(harness.importFromDir(dir, 'taken')).rejects.toThrow('already exists')
    expect(snapshot()).toEqual(before)
  })

  it('refuses the personal agent the same way', async () => {
    const before = snapshot()
    await expect(harness.importFromDir(source, 'personal')).rejects.toThrow('already exists')
    expect(snapshot()).toEqual(before)
  })

  it('leaves the stored rows as they were', async () => {
    await expect(harness.importFromDir(source, 'taken')).rejects.toThrow()
    expect(storage.read('harnesses.json', [])).toEqual(ROWS)
  })
})

describe('createOverlay with a taken name', () => {
  it('refuses before making a directory', async () => {
    const before = snapshot()
    await expect(harness.createOverlay({ name: 'Taken' })).rejects.toThrow('already exists')
    expect(snapshot()).toEqual(before)
  })
})
