// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import type { Harness } from '@/lib/types'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

describe('HarnessService.duplicate', () => {
  let tmpDir: string
  let storage: Storage
  let docker: DockerService
  let audit: AuditService
  let config: ConfigService
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-dup-'))
    storage = new Storage(tmpDir)
    docker = new DockerService()
    audit = new AuditService(storage)
    config = new ConfigService(storage)
    service = new HarnessService(storage, docker, audit, config)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('duplicates a harness overlay with a new name', async () => {
    // Set up an existing overlay
    storage.write('harnesses.json', [
      { id: 'h_personal', name: 'personal', tier: 'individual', platform: 'mattermost', channel: 'sanctum', tools: ['t_web'], models: ['claude-sonnet-4'] },
    ])

    const result = await service.duplicateOverlay('h_personal', 'personal-v2')
    expect(result).toBeDefined()
    expect(result!.id).toBe('h_personal_v2')
    expect(result!.name).toBe('personal-v2')
    expect(result!.tier).toBe('individual')
    expect(result!.tools).toEqual(['t_web'])

    // Original should still exist
    const overlays = storage.read<any[]>('harnesses.json', [])
    expect(overlays).toHaveLength(2)
  })

  it('returns undefined when source overlay does not exist', async () => {
    storage.write('harnesses.json', [])
    const result = await service.duplicateOverlay('h_nonexistent', 'new-name')
    expect(result).toBeUndefined()
  })

  it('generates unique id from name', async () => {
    storage.write('harnesses.json', [
      { id: 'h_personal', name: 'personal', tier: 'team' },
    ])
    const result = await service.duplicateOverlay('h_personal', 'my-new-agent')
    expect(result!.id).toBe('h_my_new_agent')
  })

  it('logs duplication to audit', async () => {
    storage.write('harnesses.json', [
      { id: 'h_personal', name: 'personal', tier: 'individual' },
    ])
    await service.duplicateOverlay('h_personal', 'personal-copy')
    const entries = audit.query({})
    expect(entries).toHaveLength(1)
    expect(entries[0].what).toBe('duplicate')
    expect(entries[0].target).toContain('personal')
  })
})

// Identity reset on duplicate (issue #61): a duplicate must NOT inherit the source's
// HERMES_AGENT_NAME (the HSM policy identity) or SOUL.md (persona/name).
describe('HarnessService.duplicate — identity reset', () => {
  let tmpDir: string
  let homeDir: string
  let storage: Storage
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-dupid-'))
    homeDir = path.join(tmpDir, 'home')
    fs.mkdirSync(homeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    storage = new Storage(tmpDir)
    storage.write('settings.json', { dataDir: tmpDir }) // keep compose in tmp
    const audit = new AuditService(storage)
    const config = new ConfigService(storage)
    service = new HarnessService(storage, new DockerService(), audit, config)

    // Source agent with a real data dir, identity baked in.
    storage.write('harnesses.json', [{ id: 'h_srcagent', name: 'srcagent', tier: 'team' }])
    const srcDir = path.join(homeDir, '.hermes-srcagent')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(
      path.join(srcDir, '.env'),
      'HERMES_AGENT_NAME=srcagent\nAPI_SERVER_PORT=8642\nSIGNAL_ACCOUNT=+15550001111\nDISCORD_BOT_TOKEN=src-bot-token\nSLACK_BOT_TOKEN=xoxb-src\nSLACK_APP_TOKEN=xapp-src\n' +
        // Identity-bound admission vars the old hand-list omitted (drift D4).
        'MATTERMOST_ADMIN_USERS=srcadmin\nDISCORD_ALLOWED_ROLES=111\nDISCORD_IGNORED_CHANNELS=222\nDISCORD_DM_ALLOWED_USERS=333\n' +
        // Behavioral pref — MUST carry to the clone.
        'DISCORD_REQUIRE_MENTION=true\n',
      { mode: 0o600 },
    )
    fs.writeFileSync(path.join(srcDir, 'SOUL.md'), '# srcagent\n\nYou are **srcagent**.\n')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resets HERMES_AGENT_NAME to the new name', async () => {
    await service.duplicateOverlay('h_srcagent', 'dupagent')
    const env = fs.readFileSync(path.join(homeDir, '.hermes-dupagent', '.env'), 'utf-8')
    expect(env).toMatch(/^HERMES_AGENT_NAME=dupagent$/m)
    expect(env).not.toMatch(/^HERMES_AGENT_NAME=srcagent$/m)
  })

  it('regenerates SOUL.md with the new name and no source-name references', async () => {
    await service.duplicateOverlay('h_srcagent', 'dupagent')
    const soul = fs.readFileSync(path.join(homeDir, '.hermes-dupagent', 'SOUL.md'), 'utf-8')
    expect(soul).toContain('dupagent')
    expect(soul).not.toContain('srcagent')
  })

  it('still strips surface credentials (regression)', async () => {
    await service.duplicateOverlay('h_srcagent', 'dupagent')
    const env = fs.readFileSync(path.join(homeDir, '.hermes-dupagent', '.env'), 'utf-8')
    expect(env).not.toMatch(/^SIGNAL_ACCOUNT=/m)
    // Discord bot token must not be cloned — two harnesses can't share one bot.
    expect(env).not.toMatch(/^DISCORD_BOT_TOKEN=/m)
    // Slack tokens (both) must not be cloned either.
    expect(env).not.toMatch(/^SLACK_BOT_TOKEN=/m)
    expect(env).not.toMatch(/^SLACK_APP_TOKEN=/m)
  })

  it('strips the identity-bound admission vars the old list missed (drift D4)', async () => {
    await service.duplicateOverlay('h_srcagent', 'dupagent')
    const env = fs.readFileSync(path.join(homeDir, '.hermes-dupagent', '.env'), 'utf-8')
    // A clone must not inherit the source's Mattermost admins or Discord
    // role/ignored-channel policy — now stripped, via the registry classification.
    expect(env).not.toMatch(/^MATTERMOST_ADMIN_USERS=/m)
    expect(env).not.toMatch(/^DISCORD_ALLOWED_ROLES=/m)
    expect(env).not.toMatch(/^DISCORD_IGNORED_CHANNELS=/m)
    expect(env).not.toMatch(/^DISCORD_DM_ALLOWED_USERS=/m)
    // Behavioral prefs are NOT identity — they carry to the clone.
    expect(env).toMatch(/^DISCORD_REQUIRE_MENTION=true$/m)
  })
})

// Slug normalization on duplicate (re-cut of #90): docker image/service/network
// refs must be lowercase, and on a case-insensitive filesystem a capitalized
// name collides with its lowercase compose/data dirs — the duplicate silently
// reuses the wrong-cased compose and `up` fails with "no such service".
describe('HarnessService.duplicate — slug normalization', () => {
  let tmpDir: string
  let homeDir: string
  let storage: Storage
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-dupslug-'))
    homeDir = path.join(tmpDir, 'home')
    fs.mkdirSync(homeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    storage = new Storage(tmpDir)
    storage.write('settings.json', { dataDir: tmpDir }) // keep compose in tmp
    const audit = new AuditService(storage)
    const config = new ConfigService(storage)
    service = new HarnessService(storage, new DockerService(), audit, config)
    storage.write('harnesses.json', [{ id: 'h_srcagent', name: 'srcagent', tier: 'team' }])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('normalizes the new name to a lowercase docker-safe slug', async () => {
    const result = await service.duplicateOverlay('h_srcagent', 'Dup Agent')
    expect(result).toBeDefined()
    expect(result!.name).toBe('dup-agent')
    expect(result!.id).toBe('h_dup_agent')
    expect(result!.serviceName).toBe('hermes-dup-agent')
    // Exact-case dir checks via readdir — existsSync would false-pass on
    // macOS's case-insensitive filesystem.
    expect(fs.readdirSync(homeDir)).toContain('.hermes-dup-agent')
    expect(fs.readdirSync(path.join(tmpDir, 'compose'))).toContain('dup-agent')
  })

  it('rejects when the slugged name collides with an existing harness', async () => {
    storage.write('harnesses.json', [
      { id: 'h_srcagent', name: 'srcagent', tier: 'team' },
      { id: 'h_mare', name: 'mare' },
    ])
    const result = await service.duplicateOverlay('h_srcagent', 'Mare')
    expect(result).toBeUndefined()
  })

  it('rejects a name with no sluggable characters', async () => {
    const result = await service.duplicateOverlay('h_srcagent', '!!!')
    expect(result).toBeUndefined()
  })
})

// Host access on duplicate (#222): extraMounts/extraEnv name paths on the HOST,
// belonging to the SOURCE agent. `duplicateOverlay` generates the duplicate's
// compose with only {imageOrBuild, defaultImage} — no extras — and then spread
// the whole source onto the new overlay three lines later. That left the compose
// and the overlay silently divergent, and the next unrelated settings PUT
// regenerates FROM the overlay: at that point the duplicate holds the source's
// mounts, at the source's paths, at the source's mode. For the iris agent one of
// those is the approval-gate spool at mode 'rw' — a second agent able to drop
// cards into a gate that is not its own. There is no console field for
// extraMounts, so nothing would ever have surfaced it.
describe('HarnessService.duplicate — host access is not inherited', () => {
  let tmpDir: string
  let homeDir: string
  let storage: Storage
  let service: HarnessService

  const SPOOL = {
    hostPath: '/srv/iris/nimbleco/intake',
    containerPath: '/opt/iris-intake',
    mode: 'rw' as const,
    note: 'approval-gate spool',
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-duphost-'))
    homeDir = path.join(tmpDir, 'home')
    fs.mkdirSync(homeDir, { recursive: true })
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir)
    storage = new Storage(tmpDir)
    storage.write('settings.json', { dataDir: tmpDir })
    service = new HarnessService(
      storage,
      new DockerService(),
      new AuditService(storage),
      new ConfigService(storage),
    )
    storage.write('harnesses.json', [{
      id: 'h_iris',
      name: 'iris',
      tier: 'team',
      extraMounts: [SPOOL],
      extraEnv: { IRIS_INTAKE_DIR: '/opt/iris-intake' },
    }])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does NOT copy the source\'s extraMounts/extraEnv onto the duplicate', async () => {
    const result = await service.duplicateOverlay('h_iris', 'iris-copy')
    expect(result).toBeDefined()
    expect(result!.extraMounts).toBeUndefined()
    expect(result!.extraEnv).toBeUndefined()

    // And not on disk either — the overlay is what a later regeneration reads.
    const onDisk = storage.read<Partial<Harness>[]>('harnesses.json', [])
    const persisted = onDisk.find((h) => h.id === 'h_iris_copy')
    expect(persisted).toBeDefined()
    expect(persisted!.extraMounts).toBeUndefined()
    expect(persisted!.extraEnv).toBeUndefined()

    // The source keeps its own.
    const src = onDisk.find((h) => h.id === 'h_iris')
    expect(src!.extraMounts).toEqual([SPOOL])
  })

  it('leaves the duplicate\'s overlay and its generated compose in agreement', async () => {
    // The real failure was divergence, not the copy per se: the compose never
    // had the mounts, the overlay did, and regeneration believed the overlay.
    const result = await service.duplicateOverlay('h_iris', 'iris-copy')
    const compose = fs.readFileSync(result!.composeFile!, 'utf-8')
    expect(compose).not.toContain('/opt/iris-intake')
    expect(compose).not.toContain('IRIS_INTAKE_DIR')
    expect(result!.extraMounts ?? []).toEqual([])
  })

  it('still carries the non-host-access fields it always did', async () => {
    // Guard against over-stripping: only the two host-access fields go.
    const result = await service.duplicateOverlay('h_iris', 'iris-copy')
    expect(result!.tier).toBe('team')
    expect(result!.parentId).toBe('h_iris')
  })
})
