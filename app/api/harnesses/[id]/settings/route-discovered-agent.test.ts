// @vitest-environment node
/**
 * #222 end-to-end, on the agent the feature was written for: a RUNNING one.
 *
 * route.test.ts mocks `services.harness.get` AND stubs the compose generator,
 * so it can only prove "the route forwards whatever get() returned". It cannot
 * see the failure that actually happened in production, which lives one layer
 * down: for a container Docker discovers, `HarnessService.discover()` builds a
 * fresh Harness literal, and the overlay's extraMounts/extraEnv were not
 * copied onto it. `get()` therefore returned `extraMounts: undefined` for
 * iris, the route faithfully forwarded `undefined`, and the next resources/VPN
 * PUT wrote a compose with the approval-gate spool mount gone. The container
 * came back healthy with its gate severed.
 *
 * This test wires the REAL HarnessService (Docker discovery returning a
 * container), the REAL compose generator, and real files in a tmp dir, and
 * asserts on the bytes of the regenerated compose.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Auto-mocked so restart('recreate') does not shell out to Docker.
vi.mock('@/lib/services/docker')

// The route reads the `services` singleton, which would build itself against
// the real ~/.hermes-swarm-map. Swap in a container we can fill with real
// service instances rooted at a tmp dir. The object identity is stable, so the
// route's `services.harness` resolves to whatever beforeEach put there.
const holder = vi.hoisted(() => ({ svc: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: holder.svc }))

vi.mock('@/lib/resolvers', () => ({
  resolveIdentifier: vi.fn(async () => null),
  expandSignalAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandTelegramAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandDiscordAllowlist: vi.fn(async (_id: string, users: string[]) => users),
}))

import { PUT } from './route'
import { HarnessService } from '@/lib/services/harness'
import { Storage } from '@/lib/services/storage'
import { DockerService } from '@/lib/services/docker'
import { AuditService } from '@/lib/services/audit'
import { ConfigService } from '@/lib/services/config'
import { SurfaceAdminService } from '@/lib/services/surface-admins'
import { generateStandaloneCompose } from '@/lib/services/harness-compose'

const SPOOL = {
  hostPath: '/srv/iris/nimbleco/intake',
  containerPath: '/opt/iris-intake',
  mode: 'rw' as const,
  note: 'approval-gate spool',
}
const MOUNT_LINE = `${SPOOL.hostPath}:${SPOOL.containerPath}:${SPOOL.mode}`

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_iris/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Settings PUT on a DISCOVERED (running) agent keeps its extra mounts (#222)', () => {
  let tmpDir: string
  let composeFile: string
  let agentDir: string
  let storage: Storage
  let docker: DockerService
  let harness: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-e2e-mounts-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)

    // The agent's data dir + .env — what the route rewrites.
    agentDir = path.join(tmpDir, '.hermes-iris')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, '.env'), 'GITHUB_TOKEN=x\n', { mode: 0o600 })

    // The CURRENT on-disk compose, generated the same way the agent's real one
    // was: with the gate mount present. This is the file the PUT regenerates.
    composeFile = path.join(tmpDir, 'compose', 'iris', 'docker-compose.yml')
    fs.mkdirSync(path.dirname(composeFile), { recursive: true })
    fs.writeFileSync(
      composeFile,
      generateStandaloneCompose('iris', 8642, agentDir, {
        defaultImage: 'ghcr.io/cyborg-garden/hermes-agent-mt:latest',
        memory: '2G',
        cpus: '2.0',
        extraMounts: [SPOOL],
        extraEnv: { IRIS_INTAKE_DIR: '/opt/iris-intake' },
      }),
      'utf-8',
    )

    storage = new Storage(tmpDir)
    storage.write('settings.json', {
      hermesDir: tmpDir,
      dataDir: tmpDir,
      theme: 'light',
      composeFiles: [composeFile],
    })
    storage.write('harnesses.json', [
      {
        id: 'h_iris',
        name: 'iris',
        tier: 'team',
        resources: { memory: '2G', cpus: '2.0' },
        extraMounts: [SPOOL],
        extraEnv: { IRIS_INTAKE_DIR: '/opt/iris-intake' },
      },
    ])

    docker = new DockerService()
    // iris is RUNNING. This is the whole point: discovery returns a container,
    // so list()/get() go through the discovered literal, never normalizeStored.
    ;(docker.isAvailable as any).mockReturnValue(true)
    ;(docker.listComposeProjects as any).mockReturnValue([
      { name: 'iris', status: 'running', configFiles: [composeFile] },
    ])
    ;(docker.inspectContainers as any).mockReturnValue([
      {
        name: 'hermes-iris',
        service: 'hermes-iris',
        state: 'running',
        status: 'Up 3 days',
        ports: [{ published: 8642, target: 8000 }],
        composeFile,
      },
    ])
    ;(docker.getAllContainerStats as any).mockReturnValue({})
    ;(docker.listContainers as any).mockReturnValue([])

    const audit = new AuditService(storage)
    const config = new ConfigService(storage)
    harness = new HarnessService(storage, docker, audit, config)
    holder.svc.harness = harness
    holder.svc.config = config
    holder.svc.surfaceAdmins = new SurfaceAdminService(storage, audit)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('the fixture really is a discovered, running agent', () => {
    const iris = harness.get('h_iris')
    expect(iris).toBeDefined()
    expect(iris!.status).toBe('running')
    expect(iris!.composeFile).toBe(composeFile)
  })

  it('a resources PUT regenerates a compose that STILL CONTAINS the gate mount', async () => {
    // Precondition: the mount is on disk before the PUT.
    expect(fs.readFileSync(composeFile, 'utf-8')).toContain(MOUNT_LINE)

    const res = await PUT(
      makeRequest({ dmPolicy: 'approved-only', resources: { memory: '4G', cpus: '4.0' } }),
      makeParams('h_iris'),
    )
    expect(res.status).toBe(200)

    const regenerated = fs.readFileSync(composeFile, 'utf-8')
    // The change we asked for did land — so this really was a regeneration,
    // not a no-op that trivially preserved the file.
    expect(regenerated).toContain('memory: 4G')
    // …and the capability nobody mentioned in the request survived it.
    expect(regenerated).toContain(MOUNT_LINE)
    expect(regenerated).toContain('IRIS_INTAKE_DIR=/opt/iris-intake')
  })

  it('a VPN-enable PUT regenerates a compose that STILL CONTAINS the gate mount', async () => {
    const res = await PUT(
      makeRequest({ dmPolicy: 'approved-only', vpnEnabled: true }),
      makeParams('h_iris'),
    )
    expect(res.status).toBe(200)

    const regenerated = fs.readFileSync(composeFile, 'utf-8')
    expect(regenerated).toContain('wireguard')
    expect(regenerated).toContain(MOUNT_LINE)
    expect(regenerated).toContain('IRIS_INTAKE_DIR=/opt/iris-intake')
  })
})
