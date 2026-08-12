// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import { generateStandaloneCompose, readComposeImage } from '../harness-compose'

vi.mock('../docker')

// Subclass to pin time + force compose-target resolution to our tmp file.
class TestHarness extends HarnessService {
  constructor(s: Storage, d: DockerService, a: AuditService, c: ConfigService, private fixedNow: number, private compose: string) {
    super(s, d, a, c)
  }
  protected now() { return this.fixedNow }
  get(id: string): any { return { id, name: id.replace(/^h_/, ''), serviceName: `hermes-${id.replace(/^h_/, '')}`, composeFile: this.compose } }
}

let tmp: string, composeFile: string, docker: DockerService, svc: TestHarness
const fakeRegistry = { getDigest: vi.fn(async () => 'sha256:latest'), listTags: vi.fn(async () => ['latest']) } as any

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hi-'))
  composeFile = path.join(tmp, 'docker-compose.yml')
  fs.writeFileSync(composeFile, generateStandaloneCompose('a', 8642, '/data/a', { imageOrBuild: { build: '/src' } }))
  docker = new DockerService()
  const storage = new Storage(tmp)
  svc = new TestHarness(storage, docker, new AuditService(storage), new ConfigService(storage), Date.parse('2026-06-12T00:00:30Z'), composeFile)
  fakeRegistry.getDigest.mockClear()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('setAgentImage', () => {
  it('rewrites the compose to the pinned image and recreates', async () => {
    const res = await svc.setAgentImage('h_a', 'ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12', fakeRegistry)
    expect(res.ok).toBe(true)
    expect(readComposeImage(fs.readFileSync(composeFile, 'utf-8'))).toBe('ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12')
    // docker.restart(composeFile, service, mode, projectName?, buildSource?) —
    // pinning an image recreates with no build source (nothing to build).
    expect(docker.restart).toHaveBeenCalledWith(composeFile, 'hermes-a', 'recreate', undefined, undefined)
  })
})

describe('setAgentImage error paths', () => {
  it('throws a friendly not-found error when the compose file is missing', async () => {
    fs.rmSync(composeFile)
    await expect(svc.setAgentImage('h_a', 'ghcr.io/x:1', fakeRegistry)).rejects.toThrow(/not found/i)
    expect(docker.restart).not.toHaveBeenCalled() // no recreate on a failed pin
  })
})

describe('currentImage / imageStatus', () => {
  it('reports local-build before a pin, then the pinned ref after', async () => {
    expect(svc.currentImage('h_a')).toBe('local-build')
    const status = await svc.imageStatus('h_a', fakeRegistry)
    expect(status.current).toBe('local-build')
    expect(status.updateAvailable).toBe(true) // local-build + a latest digest exists
    await svc.setAgentImage('h_a', 'ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12', fakeRegistry)
    expect(svc.currentImage('h_a')).toBe('ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12')
  })
})

describe('agentHealth canary', () => {
  it('healthy when running, stable, and past the boot window', () => {
    ;(docker.inspectState as any).mockReturnValue({ running: true, status: 'running', restartCount: 0, startedAt: '2026-06-12T00:00:00Z' })
    expect(svc.agentHealth('h_a')).toMatchObject({ status: 'healthy', running: true })
  })
  it('starting when running but very young', () => {
    ;(docker.inspectState as any).mockReturnValue({ running: true, status: 'running', restartCount: 0, startedAt: '2026-06-12T00:00:27Z' })
    expect(svc.agentHealth('h_a').status).toBe('starting')
  })
  it('unhealthy when not running', () => {
    ;(docker.inspectState as any).mockReturnValue({ running: false, status: 'exited', restartCount: 0, startedAt: '' })
    expect(svc.agentHealth('h_a')).toMatchObject({ status: 'unhealthy', running: false })
  })
  it('unhealthy when restart-looping', () => {
    ;(docker.inspectState as any).mockReturnValue({ running: true, status: 'running', restartCount: 5, startedAt: '2026-06-12T00:00:00Z' })
    expect(svc.agentHealth('h_a').status).toBe('unhealthy')
  })
})
