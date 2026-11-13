// @vitest-environment node
/**
 * SurfaceAdminService wired to the REAL HarnessService, the way
 * lib/services/index.ts wires it. surface-admins.test.ts uses a stand-in for
 * the harness directory; this proves the real one behaves the same for the
 * case that needs it: an agent Docker discovers that has no stored row yet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@/lib/services/docker')

import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import { SurfaceAdminService } from '../surface-admins'

let tmpDir: string
let storage: Storage
let svc: SurfaceAdminService

const stored = () => storage.read<Array<{ id: string; surfaceAdmins?: Record<string, string[]> }>>('harnesses.json', [])

function writeEnv(name: string, content: string) {
  const dir = path.join(tmpDir, `.hermes-${name}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.env'), content)
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-discovered-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  const composeFile = path.join(tmpDir, 'compose', 'iris', 'docker-compose.yml')
  fs.mkdirSync(path.dirname(composeFile), { recursive: true })
  fs.writeFileSync(composeFile, 'services: {}\n')

  storage = new Storage(tmpDir)
  storage.write('settings.json', { hermesDir: tmpDir, dataDir: tmpDir, theme: 'light', composeFiles: [composeFile] })

  // One running container, hermes-iris, and no harnesses.json at all.
  const docker = new DockerService()
  /* eslint-disable @typescript-eslint/no-explicit-any */
  ;(docker.isAvailable as any).mockReturnValue(true)
  ;(docker.listComposeProjects as any).mockReturnValue([{ name: 'iris', status: 'running', configFiles: [composeFile] }])
  ;(docker.inspectContainers as any).mockReturnValue([
    { name: 'hermes-iris', service: 'hermes-iris', state: 'running', status: 'Up', ports: [], composeFile },
  ])
  ;(docker.getAllContainerStats as any).mockReturnValue({})
  ;(docker.listContainers as any).mockReturnValue([])
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const audit = new AuditService(storage)
  const harness = new HarnessService(storage, docker, audit, new ConfigService(storage))
  svc = new SurfaceAdminService(storage, audit, harness)

  expect(harness.get('h_iris')?.status).toBe('running')
  expect(stored()).toEqual([])
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('approveGroupInvite with the real harness directory', () => {
  const envOf = (name: string) => fs.readFileSync(path.join(tmpDir, `.hermes-${name}`, '.env'), 'utf-8')

  it('approves for a discovered agent with no stored row, by slug or by id, and stores no row', () => {
    writeEnv('iris', 'TELEGRAM_ALLOWED_USERS=111\n')
    expect(svc.approveGroupInvite('iris', 'telegram', '-100777', '111'))
      .toEqual({ ok: true, approved: true, updated: true, harnessId: 'h_iris' })
    expect(svc.approveGroupInvite('h_iris', 'telegram', '-100888', '111'))
      .toEqual({ ok: true, approved: true, updated: true, harnessId: 'h_iris' })
    expect(envOf('iris')).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100777,-100888')
    expect(svc.isGroupAllowed('iris', 'telegram', '-100888')).toBe(true)
    expect(svc.isAdmin('iris', 'telegram', '111')).toBe(true)
    expect(stored()).toEqual([])
  })

  it('answers 404 for a directory Docker lists no agent for, and leaves its .env alone', () => {
    const env = 'TELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_INVITE_POLICY=allow-all\n'
    writeEnv('ghost', env)
    for (const id of ['h_ghost', 'ghost']) {
      expect(svc.approveGroupInvite(id, 'telegram', '-100777', '111'), id).toMatchObject({ ok: false, status: 404 })
    }
    expect(envOf('ghost')).toBe(env)
  })
})

describe('setAdmins with the real harness directory', () => {
  it('stores a discovered agent under its own id, by id or by slug', () => {
    writeEnv('iris', 'SIGNAL_ALLOWED_USERS=+64111\n')
    expect(svc.setAdmins('iris', 'signal', ['+64111', '+64222'], '+64111')).toMatchObject({ ok: true, harnessId: 'h_iris' })
    expect(stored().map((h) => h.id)).toEqual(['h_iris'])
    expect(stored()[0]).toMatchObject({ name: 'iris', surfaceAdmins: { signal: ['+64111', '+64222'] } })

    // The row now exists, so the next write updates it in place.
    expect(svc.setAdmins('h_iris', 'signal', ['+64222'], '+64222')).toMatchObject({ ok: true, harnessId: 'h_iris' })
    expect(stored().map((h) => h.id)).toEqual(['h_iris'])
    expect(svc.isAdmin('iris', 'signal', '+64111')).toBe(false)
    expect(svc.isAdmin('iris', 'signal', '+64222')).toBe(true)
  })

  it('refuses an id Docker does not list, even with a .env on disk, and stores nothing', () => {
    writeEnv('ghost', 'SIGNAL_ALLOWED_USERS=+64111\n')
    for (const id of ['h_ghost', 'ghost']) {
      expect(svc.setAdmins(id, 'signal', ['+64111'], '+64111'), id).toMatchObject({ ok: false, status: 404 })
    }
    expect(stored()).toEqual([])
  })

  it('refuses another spelling of the discovered agent, and stores nothing', () => {
    writeEnv('iris', 'SIGNAL_ALLOWED_USERS=+64111\n')
    for (const id of ['h_Iris', 'h_iris_', 'h_h_iris']) {
      expect(svc.setAdmins(id, 'signal', ['+64111'], '+64111').ok, id).toBe(false)
    }
    expect(stored()).toEqual([])
  })
})
