// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService, toHarnessSlug } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

describe('HarnessService.createOverlay', () => {
  let tmpDir: string
  let storage: Storage
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-create-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    const docker = new DockerService()
    const audit = new AuditService(storage)
    const config = new ConfigService(storage)
    service = new HarnessService(storage, docker, audit, config)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('creates a new harness overlay', async () => {
    storage.write('harnesses.json', [])
    const result = await service.createOverlay({
      name: 'test-agent',
      tier: 'team',
      platform: 'mattermost',
      channel: 'test-channel',
    })
    expect(result.id).toBe('h_test_agent')
    expect(result.name).toBe('test-agent')
    expect(result.tier).toBe('team')
  })

  it('prevents duplicate names', async () => {
    storage.write('harnesses.json', [{ id: 'h_existing', name: 'existing' }])
    await expect(service.createOverlay({ name: 'existing' })).rejects.toThrow()
  })

  it('uses sensible defaults', async () => {
    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'minimal' })
    expect(result.tier).toBe('individual')
    expect(result.platform).toBe('hermes')
  })

  // Slug normalization (re-cut of #90): docker image/service/network refs must
  // be lowercase, and on a case-insensitive filesystem a capitalized name
  // (e.g. "Mare") collides with its lowercase compose/data dirs — so `up`
  // fails with "no such service: hermes-mare". Normalize at creation.
  it('normalizes an uppercase name to a lowercase docker-safe slug', async () => {
    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'Mare' })
    expect(result.name).toBe('mare')
    expect(result.id).toBe('h_mare')
    expect(result.serviceName).toBe('hermes-mare')
    // Exact-case dir checks via readdir — a plain existsSync('.hermes-mare')
    // would false-pass on macOS's case-insensitive filesystem.
    expect(fs.readdirSync(tmpDir)).toContain('.hermes-mare')
    expect(path.dirname(result.composeFile!)).toBe(
      path.join(tmpDir, '.hermes-swarm-map', 'compose', 'mare')
    )
  })

  it('slugs spaces and mixed case to hyphens', async () => {
    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'My Cool Agent' })
    expect(result.name).toBe('my-cool-agent')
    expect(result.id).toBe('h_my_cool_agent')
    expect(result.serviceName).toBe('hermes-my-cool-agent')
  })

  it('rejects a name that slugs to an existing harness', async () => {
    storage.write('harnesses.json', [{ id: 'h_mare', name: 'mare' }])
    await expect(service.createOverlay({ name: 'Mare' })).rejects.toThrow(/already exists/)
  })

  it('rejects a name with no sluggable characters', async () => {
    storage.write('harnesses.json', [])
    await expect(service.createOverlay({ name: '!!!' })).rejects.toThrow()
  })
})

describe('toHarnessSlug', () => {
  it('lowercases, hyphenates non-alphanumerics, and trims edge dashes', () => {
    expect(toHarnessSlug('Mare')).toBe('mare')
    expect(toHarnessSlug('My Cool Agent')).toBe('my-cool-agent')
    expect(toHarnessSlug('  Mare!! ')).toBe('mare')
    expect(toHarnessSlug('A__B..C')).toBe('a-b-c')
    expect(toHarnessSlug('already-a-slug')).toBe('already-a-slug')
    expect(toHarnessSlug('!!!')).toBe('')
  })
})

describe('HarnessService.importFromDir', () => {
  let tmpDir: string
  let hermesDir: string
  let storage: Storage
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-import-'))
    hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    const docker = new DockerService()
    const audit = new AuditService(storage)
    const config = new ConfigService(storage)
    service = new HarnessService(storage, docker, audit, config)

    // Create a fake hermes data dir
    fs.writeFileSync(path.join(hermesDir, 'SOUL.md'), '# Test Agent\nI am a test agent.')
    fs.writeFileSync(path.join(hermesDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test123\nAPI_SERVER_PORT=8642\n')
    fs.mkdirSync(path.join(hermesDir, 'memories'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(hermesDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('imports a harness from a data directory', async () => {
    storage.write('harnesses.json', [])
    const result = await service.importFromDir(hermesDir, 'imported-agent')
    expect(result.name).toBe('imported-agent')
    expect(result.changes.copied).toBe(true)
    expect(result.destDir).toBe(path.join(tmpDir, '.hermes-imported-agent'))
    // Verify the overlay was registered with persona
    const overlays = storage.read<any[]>('harnesses.json', [])
    const overlay = overlays.find((h: any) => h.name === 'imported-agent')
    expect(overlay).toBeDefined()
    expect(overlay.persona).toContain('test agent')
  })

  it('does NOT write git credentials on import — the runtime provisions them at boot', async () => {
    storage.write('harnesses.json', [])
    fs.writeFileSync(
      path.join(hermesDir, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-test123\nGITHUB_TOKEN=github_pat_IMPORTED\n',
    )
    const result = await service.importFromDir(hermesDir, 'gitcred-test')
    // Git credential provisioning moved into the agent runtime (a cont-init boot
    // hook reads the agent's own .env). HSM no longer writes these files, so it
    // can't clobber a user's git setup and there's no second source of truth.
    const credPath = path.join(result.destDir, 'home', '.git-credentials')
    expect(fs.existsSync(credPath)).toBe(false)
  })

  it('adds DISCORD_THREAD_REQUIRE_MENTION=true to an imported Discord agent', async () => {
    storage.write('harnesses.json', [])
    fs.writeFileSync(path.join(hermesDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test123\nDISCORD_BOT_TOKEN=tok\n')
    const result = await service.importFromDir(hermesDir, 'discord-import')
    const env = fs.readFileSync(path.join(result.destDir, '.env'), 'utf-8')
    expect(env).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('keeps an imported agent\'s explicit thread gate value', async () => {
    storage.write('harnesses.json', [])
    fs.writeFileSync(
      path.join(hermesDir, '.env'),
      'ANTHROPIC_API_KEY=sk-ant-test123\nDISCORD_BOT_TOKEN=tok\nDISCORD_THREAD_REQUIRE_MENTION=false\n',
    )
    const result = await service.importFromDir(hermesDir, 'discord-optout')
    const env = fs.readFileSync(path.join(result.destDir, '.env'), 'utf-8')
    expect(env).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=false$/m)
    expect(env).not.toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('detects persona from SOUL.md', async () => {
    storage.write('harnesses.json', [])
    const result = await service.importFromDir(hermesDir, 'soul-test')
    // Verify persona was stored in the overlay
    const overlays = storage.read<any[]>('harnesses.json', [])
    const overlay = overlays.find((h: any) => h.name === 'soul-test')
    expect(overlay).toBeDefined()
    expect(overlay.persona).toBeTruthy()
    expect(overlay.persona.length).toBeGreaterThan(0)
  })
})
