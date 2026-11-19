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
  // (e.g. "Wren") collides with its lowercase compose/data dirs — so `up`
  // fails with "no such service: hermes-wren". Normalize at creation.
  it('normalizes an uppercase name to a lowercase docker-safe slug', async () => {
    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'Wren' })
    expect(result.name).toBe('wren')
    expect(result.id).toBe('h_wren')
    expect(result.serviceName).toBe('hermes-wren')
    // Exact-case dir checks via readdir — a plain existsSync('.hermes-wren')
    // would false-pass on macOS's case-insensitive filesystem.
    expect(fs.readdirSync(tmpDir)).toContain('.hermes-wren')
    expect(path.dirname(result.composeFile!)).toBe(
      path.join(tmpDir, '.hermes-swarm-map', 'compose', 'wren')
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
    storage.write('harnesses.json', [{ id: 'h_wren', name: 'wren' }])
    await expect(service.createOverlay({ name: 'Wren' })).rejects.toThrow(/already exists/)
  })

  it('rejects a name with no sluggable characters', async () => {
    storage.write('harnesses.json', [])
    await expect(service.createOverlay({ name: '!!!' })).rejects.toThrow()
  })
})

describe('toHarnessSlug', () => {
  it('lowercases, hyphenates non-alphanumerics, and trims edge dashes', () => {
    expect(toHarnessSlug('Wren')).toBe('wren')
    expect(toHarnessSlug('My Cool Agent')).toBe('my-cool-agent')
    expect(toHarnessSlug('  Wren!! ')).toBe('wren')
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

  it('leaves the source agent\'s broker identity behind', async () => {
    // Otherwise the import asks for tokens as its source, gets the source's scope,
    // and the audit log blames the source.
    fs.writeFileSync(path.join(hermesDir, 'github-broker.json'), '{"url":"http://unused","secret":"not-a-real-secret"}')
    fs.writeFileSync(path.join(hermesDir, '.hsm-github-broker'), '')
    await service.importFromDir(hermesDir, 'broker-import')
    const dest = path.join(tmpDir, '.hermes-broker-import')
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(true)
    expect(fs.existsSync(path.join(dest, 'github-broker.json'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.hsm-github-broker'))).toBe(false)
    expect(fs.existsSync(path.join(hermesDir, 'github-broker.json'))).toBe(true)
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

// The state-volume layout is decided per agent from the Docker engine
// (state-volume.ts), not fixed: on for a VM-backed or unknown engine, off for
// native Linux (#273), and kept for an agent whose databases are already on
// the volume. These run the real create/import paths; only the engine probe
// and the platform are set.
describe('state-volume layout at compose generation', () => {
  const NATIVE = { operatingSystem: 'Ubuntu 24.04.1 LTS', kernelVersion: '6.8.0-45-generic', osType: 'linux', endpoint: 'unix:///var/run/docker.sock' }
  const DESKTOP = { ...NATIVE, operatingSystem: 'Docker Desktop', kernelVersion: '6.10.14-linuxkit' }
  const realPlatform = process.platform
  let tmpDir: string
  let srcDir: string
  let storage: Storage
  let docker: DockerService
  let config: ConfigService
  let service: HarnessService

  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
  const composeOf = (name: string) =>
    fs.readFileSync(path.join(tmpDir, '.hermes-swarm-map', 'compose', name, 'docker-compose.yml'), 'utf-8')
  const hasLayout = (compose: string, name: string) => {
    const on = compose.includes(`  state-init-${name}:`)
    // All four parts move together.
    expect(compose.includes(`- hermes-state-${name}:/state`)).toBe(on)
    expect(/^volumes:\s*$/m.test(compose)).toBe(on)
    expect(compose.includes('condition: service_completed_successfully')).toBe(on)
    return on
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-state-volume-'))
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-agent-src-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    storage.write('harnesses.json', [])
    docker = new DockerService()
    config = new ConfigService(storage)
    service = new HarnessService(storage, docker, new AuditService(storage), config)
    fs.writeFileSync(path.join(srcDir, 'SOUL.md'), '# Test Agent')
    fs.writeFileSync(path.join(srcDir, '.env'), 'API_SERVER_PORT=8642\n')
  })

  afterEach(() => {
    setPlatform(realPlatform)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(srcDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('native Linux engine: a new agent gets plain bind mounts', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(NATIVE)
    await service.createOverlay({ name: 'plain' })
    expect(hasLayout(composeOf('plain'), 'plain')).toBe(false)
  })

  it('Linux process, VM engine (Docker Desktop): a new agent gets the layout', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(DESKTOP)
    await service.createOverlay({ name: 'desk' })
    expect(hasLayout(composeOf('desk'), 'desk')).toBe(true)
  })

  it('Linux process, engine not answering: a new agent gets the layout (the safe side)', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(null)
    await service.createOverlay({ name: 'unknown' })
    expect(hasLayout(composeOf('unknown'), 'unknown')).toBe(true)
  })

  it('macOS: a new agent gets the layout, and the engine is not asked', async () => {
    setPlatform('darwin')
    vi.mocked(docker.hostInfo).mockReturnValue(NATIVE)
    await service.createOverlay({ name: 'mac' })
    expect(hasLayout(composeOf('mac'), 'mac')).toBe(true)
    expect(docker.hostInfo).not.toHaveBeenCalled()
  })

  it('settings.useStateVolume overrides the engine in both directions', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(NATIVE)
    config.updateSettings({ useStateVolume: true })
    await service.createOverlay({ name: 'forced-on' })
    expect(hasLayout(composeOf('forced-on'), 'forced-on')).toBe(true)

    setPlatform('darwin')
    config.updateSettings({ useStateVolume: false })
    await service.createOverlay({ name: 'forced-off' })
    expect(hasLayout(composeOf('forced-off'), 'forced-off')).toBe(false)
  })

  it('import: a data dir whose databases are already on the volume keeps the layout on native Linux', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(NATIVE)
    config.updateSettings({ useStateVolume: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // What state-init leaves in a migrated agent's data dir.
    fs.symlinkSync('/state/state.db', path.join(srcDir, 'state.db'))
    await service.importFromDir(srcDir, 'moved')
    expect(fs.lstatSync(path.join(tmpDir, '.hermes-moved', 'state.db')).isSymbolicLink()).toBe(true)
    expect(hasLayout(composeOf('moved'), 'moved')).toBe(true)
  })

  it('import: a data dir with plain database files stays plain on native Linux', async () => {
    setPlatform('linux')
    vi.mocked(docker.hostInfo).mockReturnValue(NATIVE)
    fs.writeFileSync(path.join(srcDir, 'state.db'), 'a real database')
    await service.importFromDir(srcDir, 'kept')
    expect(fs.readFileSync(path.join(tmpDir, '.hermes-kept', 'state.db'), 'utf-8')).toBe('a real database')
    expect(hasLayout(composeOf('kept'), 'kept')).toBe(false)
  })
})
