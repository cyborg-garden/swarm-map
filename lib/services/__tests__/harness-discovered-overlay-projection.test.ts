// @vitest-environment node
/**
 * #222 — overlay host-access fields must survive the DISCOVERED projection.
 *
 * `discover()` builds a fresh Harness literal for every container Docker
 * reports, and `list()` returns those objects whenever discovery returns
 * anything at all. `normalizeStored()` — the only other projection — is the
 * fallback for agents with NO running container.
 *
 * So for the one agent #222 was written for (heron, running, gated), every read
 * goes through the discovered literal. If that literal omits extraMounts /
 * extraEnv, then `services.harness.get('h_heron').extraMounts` is `undefined`,
 * and the settings route hands `undefined` to the compose generator — the
 * silent mount drop the whole feature exists to prevent, on the exact path a
 * live agent takes. Every existing test either calls the generator directly or
 * mocks the service, so none of them touch this.
 *
 * These tests drive the REAL HarnessService with Docker discovery RETURNING a
 * container.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

const SPOOL = {
  hostPath: '/srv/heron/harbor/intake',
  containerPath: '/opt/heron-intake',
  mode: 'rw' as const,
  note: 'approval-gate spool',
}

describe('discovered harness projection carries overlay host access (#222)', () => {
  let tmpDir: string
  let storage: Storage
  let docker: DockerService
  let service: HarnessService
  let composeFile: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-disc-mounts-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    docker = new DockerService()
    service = new HarnessService(
      storage,
      docker,
      new AuditService(storage),
      new ConfigService(storage),
    )

    composeFile = path.join(tmpDir, 'docker-compose.yml')
    fs.writeFileSync(composeFile, 'services: {}\n')
    storage.write('settings.json', {
      hermesDir: tmpDir,
      dataDir: tmpDir,
      theme: 'light',
      composeFiles: [composeFile],
    })

    // The overlay is where hand-added host access lives — there is no console
    // field for it, so harnesses.json is the only place it can come from.
    storage.write('harnesses.json', [
      {
        id: 'h_heron',
        name: 'heron',
        tier: 'team',
        extraMounts: [SPOOL],
        extraEnv: { HERON_INTAKE_DIR: '/opt/heron-intake' },
      },
    ])

    // Docker DOES find the container — this is the whole point. heron is running.
    ;(docker.isAvailable as any).mockReturnValue(true)
    ;(docker.listComposeProjects as any).mockReturnValue([
      { name: 'heron', status: 'running', configFiles: [composeFile] },
    ])
    ;(docker.inspectContainers as any).mockReturnValue([
      {
        name: 'hermes-heron',
        service: 'hermes-heron',
        state: 'running',
        status: 'Up 3 days',
        ports: [{ published: 8642, target: 8000 }],
        composeFile,
      },
    ])
    ;(docker.getAllContainerStats as any).mockReturnValue({})
    ;(docker.listContainers as any).mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('discovery really is the path under test (the agent is RUNNING, not a stored fallback)', () => {
    const heron = service.get('h_heron')
    expect(heron).toBeDefined()
    // If this were the normalizeStored fallback, status would be forced
    // 'stopped'. 'running' proves the discovered literal is what we're reading.
    expect(heron!.status).toBe('running')
  })

  it('get() on a RUNNING agent surfaces the overlay extraMounts/extraEnv', () => {
    const heron = service.get('h_heron')
    expect(heron!.extraMounts).toEqual([SPOOL])
    expect(heron!.extraEnv).toEqual({ HERON_INTAKE_DIR: '/opt/heron-intake' })
  })

  it('list() on a RUNNING agent surfaces the overlay extraMounts/extraEnv', () => {
    const heron = service.list().find((h) => h.id === 'h_heron')
    expect(heron).toBeDefined()
    expect(heron!.status).toBe('running')
    expect(heron!.extraMounts).toEqual([SPOOL])
    expect(heron!.extraEnv).toEqual({ HERON_INTAKE_DIR: '/opt/heron-intake' })
  })

  it('omits the fields entirely for an agent that has none (no undefined keys added)', () => {
    storage.write('harnesses.json', [{ id: 'h_heron', name: 'heron', tier: 'team' }])
    const heron = service.get('h_heron')!
    expect('extraMounts' in heron).toBe(false)
    expect('extraEnv' in heron).toBe(false)
  })

  it('an empty extraMounts array does not become a key (parity with normalizeStored)', () => {
    storage.write('harnesses.json', [
      { id: 'h_heron', name: 'heron', extraMounts: [], extraEnv: {} },
    ])
    const heron = service.get('h_heron')!
    expect('extraMounts' in heron).toBe(false)
    expect('extraEnv' in heron).toBe(false)
  })

  // Same projection gap, different fields: the image pin. `imageStatus()` reads
  // `harness.lastKnownDigest` off `this.get(id)`, and you only ever ask for the
  // image status of an agent that is RUNNING — i.e. always the discovered
  // literal. Dropped there, `updateAvailable` is computed from `undefined` and
  // is therefore permanently false: the console can never say "update
  // available" for any live agent. `setAgentImage`'s
  // `digest ?? harness.lastKnownDigest` rollback anchor is lost the same way.
  it('carries pinnedImageRef/lastKnownDigest/apiPort onto the discovered literal', () => {
    storage.write('harnesses.json', [
      {
        id: 'h_heron',
        name: 'heron',
        apiPort: 8642,
        pinnedImageRef: 'ghcr.io/cyborg-garden/hermes-agent-mt:1.4.0',
        lastKnownDigest: 'sha256:aaaa',
      },
    ])
    const heron = service.get('h_heron')!
    expect(heron.status).toBe('running')
    expect(heron.pinnedImageRef).toBe('ghcr.io/cyborg-garden/hermes-agent-mt:1.4.0')
    expect(heron.lastKnownDigest).toBe('sha256:aaaa')
    expect(heron.apiPort).toBe(8642)
  })

  // The model-update scheduler decides whether it may rotate a RUNNING agent's
  // cascade from get(id).modelTracking. Dropped here, no tracked entry is ever
  // applied — and an empty map must not become a key (parity with the rest).
  it('carries modelTracking onto the discovered literal; an empty map is omitted', () => {
    storage.write('harnesses.json', [
      { id: 'h_heron', name: 'heron', modelTracking: { 'openrouter/z-ai/glm-5.2': true } },
    ])
    const heron = service.get('h_heron')!
    expect(heron.status).toBe('running')
    expect(heron.modelTracking).toEqual({ 'openrouter/z-ai/glm-5.2': true })

    storage.write('harnesses.json', [{ id: 'h_heron', name: 'heron', modelTracking: {} }])
    expect('modelTracking' in service.get('h_heron')!).toBe(false)
  })
})
