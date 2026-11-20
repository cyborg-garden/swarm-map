import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KeysService, anthropicEnvVarForValue } from '../keys'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('KeysService', () => {
  let tmpDir: string
  let keys: KeysService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-keys-'))
    const storage = new Storage(tmpDir)
    const audit = new AuditService(storage)
    keys = new KeysService(storage, audit)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // An added+assigned key is written to the harness .env, so discovery finds it
  // too. The stored entry and the discovered entry must collapse to ONE row.
  it('does not duplicate a key that was added and assigned to a harness', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    const value = 'github_pat_11ABCDEFG0aBcDeFgHiJkLmnwvYN'
    keys.add({ provider: 'github', value, assignedTo: ['h_badger'] })
    keys.writeKeyToEnv('h_badger', 'github', value)

    const github = keys.list(['badger']).filter((k) => k.provider === 'github')
    expect(github).toHaveLength(1)
  })

  it('keeps the optional name on an added+assigned key (no dup, name preserved)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    const value = 'github_pat_11ABCDEFG0aBcDeFgHiJkLmnwvYN'
    keys.add({ provider: 'github', value, name: 'hermes-badger', assignedTo: ['h_badger'] })
    keys.writeKeyToEnv('h_badger', 'github', value)

    const github = keys.list(['badger']).filter((k) => k.provider === 'github')
    expect(github).toHaveLength(1)
    expect(github[0].name).toBe('hermes-badger')
    expect(github[0].assignedTo).toContain('h_badger')
  })

  // Pass [] as harnessNames so discovery is skipped (no real agent dirs in test env)
  it('starts with empty list', () => {
    expect(keys.list([])).toEqual([])
  })

  it('adds a key and masks the value', () => {
    const key = keys.add({ provider: 'anthropic', value: 'sk-ant-12345678' })
    expect(key.provider).toBe('anthropic')
    expect(key.maskedValue).toBe('sk-a…5678')
    expect(key.health).toBe('good')
  })

  it('lists keys with masked values', () => {
    keys.add({ provider: 'anthropic', value: 'sk-ant-12345678' })
    keys.add({ provider: 'openai', value: 'sk-proj-abcdefgh' })
    const list = keys.list([])
    expect(list).toHaveLength(2)
    expect(JSON.stringify(list)).not.toContain('sk-ant-12345678')
    expect(JSON.stringify(list)).not.toContain('sk-proj-abcdefgh')
  })

  it('removes a key', () => {
    const key = keys.add({ provider: 'test', value: 'test-key-value' })
    keys.remove(key.id)
    expect(keys.list([])).toHaveLength(0)
  })

  it('updates key assignment', () => {
    const key = keys.add({ provider: 'test', value: 'test-key' })
    keys.update(key.id, { assignedTo: ['h_audrey', 'h_cryptid'] })
    const updated = keys.list([]).find((k) => k.id === key.id)
    expect(updated!.assignedTo).toEqual(['h_audrey', 'h_cryptid'])
  })
})

// Anthropic accepts two credential formats that require different auth headers:
// standard API keys (sk-ant-api*) authenticate via x-api-key (ANTHROPIC_API_KEY),
// while Bearer-style tokens (sk-ant-oat*, cc-*, JWT eyJ*) must be supplied via
// ANTHROPIC_TOKEN so the client sends Authorization: Bearer — and NOT via
// ANTHROPIC_API_KEY, or the SDK attaches a conflicting x-api-key header too.
describe('anthropicEnvVarForValue', () => {
  it('routes standard API keys to ANTHROPIC_API_KEY', () => {
    expect(anthropicEnvVarForValue('sk-ant-api03-ABCdef')).toBe('ANTHROPIC_API_KEY')
  })
  it('routes setup tokens to ANTHROPIC_TOKEN', () => {
    expect(anthropicEnvVarForValue('sk-ant-oat01-ABCdef')).toBe('ANTHROPIC_TOKEN')
  })
  it('routes cc- access tokens to ANTHROPIC_TOKEN', () => {
    expect(anthropicEnvVarForValue('cc-abcdef')).toBe('ANTHROPIC_TOKEN')
  })
  it('routes JWT (eyJ) tokens to ANTHROPIC_TOKEN', () => {
    expect(anthropicEnvVarForValue('eyJhbG.payload.sig')).toBe('ANTHROPIC_TOKEN')
  })
  it('defaults unknown shapes to ANTHROPIC_API_KEY', () => {
    expect(anthropicEnvVarForValue('whatever')).toBe('ANTHROPIC_API_KEY')
  })
})

describe('anthropic credential env-var routing (writeKeyToEnv/removeKeyFromEnv)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-store-')))
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const envFor = (name: string) => path.join(tmpHome, `.hermes-${name}`, '.env')
  const read = (name: string) => fs.readFileSync(envFor(name), 'utf-8')

  it('writes an OAuth-shaped token to ANTHROPIC_TOKEN, not ANTHROPIC_API_KEY', () => {
    keys.writeKeyToEnv('agentA', 'anthropic', 'sk-ant-oat01-SECRET')
    const env = read('agentA')
    expect(env).toMatch(/^ANTHROPIC_TOKEN=sk-ant-oat01-SECRET$/m)
    expect(env).not.toMatch(/^ANTHROPIC_API_KEY=/m)
  })

  it('writes a standard API key to ANTHROPIC_API_KEY, not ANTHROPIC_TOKEN', () => {
    keys.writeKeyToEnv('agentB', 'anthropic', 'sk-ant-api03-SECRET')
    const env = read('agentB')
    expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-api03-SECRET$/m)
    expect(env).not.toMatch(/^ANTHROPIC_TOKEN=/m)
  })

  it('clears the stale API key when switching to an OAuth token (no dual auth header)', () => {
    keys.writeKeyToEnv('agentC', 'anthropic', 'sk-ant-api03-OLD')
    keys.writeKeyToEnv('agentC', 'anthropic', 'sk-ant-oat01-NEW')
    const env = read('agentC')
    expect(env).toMatch(/^ANTHROPIC_TOKEN=sk-ant-oat01-NEW$/m)
    expect(env).not.toMatch(/^ANTHROPIC_API_KEY=/m)
  })

  it('clears the stale token when switching back to an API key', () => {
    keys.writeKeyToEnv('agentC2', 'anthropic', 'sk-ant-oat01-OLD')
    keys.writeKeyToEnv('agentC2', 'anthropic', 'sk-ant-api03-NEW')
    const env = read('agentC2')
    expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-api03-NEW$/m)
    expect(env).not.toMatch(/^ANTHROPIC_TOKEN=/m)
  })

  it('removeKeyFromEnv clears both anthropic vars', () => {
    keys.writeKeyToEnv('agentD', 'anthropic', 'sk-ant-oat01-X')
    keys.removeKeyFromEnv('agentD', 'anthropic')
    const env = read('agentD')
    expect(env).not.toMatch(/^ANTHROPIC_(TOKEN|API_KEY)=/m)
  })

  it('preserves unrelated env vars when routing anthropic creds', () => {
    fs.mkdirSync(path.join(tmpHome, '.hermes-agentE'), { recursive: true })
    fs.writeFileSync(envFor('agentE'), 'TELEGRAM_BOT_TOKEN=abc\nANTHROPIC_API_KEY=sk-ant-api03-OLD\n')
    keys.writeKeyToEnv('agentE', 'anthropic', 'sk-ant-oat01-NEW')
    const env = read('agentE')
    expect(env).toMatch(/^TELEGRAM_BOT_TOKEN=abc$/m)
    expect(env).toMatch(/^ANTHROPIC_TOKEN=sk-ant-oat01-NEW$/m)
    expect(env).not.toMatch(/^ANTHROPIC_API_KEY=/m)
  })

  it('leaves non-anthropic providers on their normal var', () => {
    keys.writeKeyToEnv('agentF', 'openai', 'sk-proj-XYZ')
    expect(read('agentF')).toMatch(/^OPENAI_API_KEY=sk-proj-XYZ$/m)
  })
})

// Custom-provider keys have no entry in PROVIDER_TO_VAR, so they used to fall
// back to CUSTOM_API_KEY — the wrong var for a key the user named "capsolver".
// A custom key must resolve to a var derived from its name, or from an explicit
// envVar when supplied, and remove must clear that same var.
describe('custom-provider env-var routing (writeKeyToEnv/removeKeyFromEnv)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-chome-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cstore-')))
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const read = (name: string) => fs.readFileSync(path.join(tmpHome, `.hermes-${name}`, '.env'), 'utf-8')

  it('derives the var from a custom key name ("capsolver" → CAPSOLVER_API_KEY)', () => {
    keys.writeKeyToEnv('agentC1', 'custom', 'CAP-secret', { name: 'capsolver' })
    const env = read('agentC1')
    expect(env).toMatch(/^CAPSOLVER_API_KEY=CAP-secret$/m)
    expect(env).not.toMatch(/^CUSTOM_API_KEY=/m)
  })

  it('keeps a name that is already a full env-var identifier', () => {
    keys.writeKeyToEnv('agentC2', 'custom', 'v', { name: 'OPEN_MEASURES_API_KEY' })
    expect(read('agentC2')).toMatch(/^OPEN_MEASURES_API_KEY=v$/m)
  })

  it('lets an explicit envVar override the name-derived var', () => {
    keys.writeKeyToEnv('agentC3', 'custom', 'CAP-x', { name: 'Team Key', envVar: 'CAPSOLVER_API_KEY' })
    const env = read('agentC3')
    expect(env).toMatch(/^CAPSOLVER_API_KEY=CAP-x$/m)
    expect(env).not.toMatch(/^TEAM_KEY/m)
  })

  it('removeKeyFromEnv clears the same name-derived custom var', () => {
    keys.writeKeyToEnv('agentC4', 'custom', 'CAP-y', { name: 'capsolver' })
    keys.removeKeyFromEnv('agentC4', 'custom', { name: 'capsolver' })
    expect(read('agentC4')).not.toMatch(/^CAPSOLVER_API_KEY=/m)
  })

  it('prefixes a digit-leading name so the var is a valid identifier ("2captcha")', () => {
    keys.writeKeyToEnv('agentC5', 'custom', 'CAP-z', { name: '2captcha' })
    const env = read('agentC5')
    // Env vars cannot start with a digit — must be prefixed, not left as 2CAPTCHA_API_KEY.
    expect(env).toMatch(/^_2CAPTCHA_API_KEY=CAP-z$/m)
    expect(env).not.toMatch(/^2CAPTCHA/m)
    const line = env.split('\n').find((l) => l.includes('CAP-z'))!
    expect(line.split('=')[0]).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
  })

  it('does NOT treat a human label ending in "Key" as a complete identifier', () => {
    keys.writeKeyToEnv('agentC6', 'custom', 'v', { name: 'Team Key' })
    // "Team Key" is a label, not a var — it still gets the _API_KEY suffix.
    expect(read('agentC6')).toMatch(/^TEAM_KEY_API_KEY=v$/m)
  })

  it('normalizes an explicit envVar hint ("capsolver api key" → CAPSOLVER_API_KEY)', () => {
    keys.writeKeyToEnv('agentC7', 'custom', 'v', { envVar: 'capsolver api key' })
    expect(read('agentC7')).toMatch(/^CAPSOLVER_API_KEY=v$/m)
  })

  it('a known provider ignores a stale envVar/name hint (stays on its canonical var)', () => {
    keys.writeKeyToEnv('agentC8', 'brave', 'brave-secret', { name: 'Team Key', envVar: 'STALE_VAR' })
    const env = read('agentC8')
    expect(env).toMatch(/^BRAVE_SEARCH_API_KEY=brave-secret$/m)
    expect(env).not.toMatch(/^STALE_VAR=/m)
    expect(env).not.toMatch(/^TEAM_KEY/m)
  })

  it('routes an openrouter key to OPENROUTER_API_KEY, ignoring a stale hint', () => {
    // openrouter is the fleet's cheap-metered provider ([intelligent-routing-cost]).
    // It must be a *mapped* provider so a user-supplied name/envVar hint on the
    // keys form can never redirect the key away from OPENROUTER_API_KEY (the var
    // the hermes-agent openrouter provider reads).
    keys.writeKeyToEnv('agentOR', 'openrouter', 'sk-or-v1-SECRET', { name: 'Fleet OR', envVar: 'STALE_VAR' })
    const env = read('agentOR')
    expect(env).toMatch(/^OPENROUTER_API_KEY=sk-or-v1-SECRET$/m)
    expect(env).not.toMatch(/^STALE_VAR=/m)
    expect(env).not.toMatch(/^FLEET_OR/m)
  })

  it('falls back to CUSTOM_API_KEY for an unnamed custom key, and remove clears it', () => {
    keys.writeKeyToEnv('agentC9', 'custom', 'v', { name: '   ' })
    expect(read('agentC9')).toMatch(/^CUSTOM_API_KEY=v$/m)
    keys.removeKeyFromEnv('agentC9', 'custom', { name: '   ' })
    expect(read('agentC9')).not.toMatch(/^CUSTOM_API_KEY=/m)
  })

  it('persists envVar through add() so list() and reassignment see it', () => {
    const added = keys.add({ provider: 'custom', value: 'CAP-p', name: 'Team Key', envVar: 'CAPSOLVER_API_KEY', assignedTo: [] })
    expect(added.envVar).toBe('CAPSOLVER_API_KEY')
    const listed = keys.list().find((k) => k.id === added.id)
    expect(listed?.envVar).toBe('CAPSOLVER_API_KEY')
  })
})

// A *discovered* key (value lives in an agent .env, surfaced by the registry)
// used to self-delete when unassigned from its last agent: update() stored an
// empty-value override, removeKeyFromEnv stripped the .env, and list() — which
// only emitted manuallyAdded keys — then showed nothing. A key the user is
// actively managing must survive being unassigned.
describe('discovered keys persist when unassigned (no self-delete)', () => {
  let tmpHome: string
  let tmpStore: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-phome-'))
    tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-pstore-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    // The agents scanned by default are configured per deployment.
    vi.stubEnv('SWARM_MAP_DEFAULT_HARNESSES', 'personal,agent-a,agent-b')
    const storage = new Storage(tmpStore)
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  it('keeps a discovered key (and its value) listed after unassigning its last agent', () => {
    const dir = path.join(tmpHome, '.hermes-agent-a')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-DISCOVERED\n')

    const discovered = keys.list().find((k) => k.provider === 'anthropic')
    expect(discovered).toBeTruthy()

    // Route order: update (unassign) THEN strip from env.
    keys.update(discovered!.id, { assignedTo: [] })
    keys.removeKeyFromEnv('agent-a', 'anthropic')

    const after = keys.list().find((k) => k.id === discovered!.id)
    expect(after).toBeTruthy()              // did NOT self-delete
    expect(after!.assignedTo).toEqual([])   // shows as unassigned
    expect(keys.getDecryptedValue(discovered!.id)).toBe('sk-ant-api03-DISCOVERED')
  })

  it('can re-assign a previously-unassigned discovered key (value still available to write)', () => {
    const dir = path.join(tmpHome, '.hermes-agent-b')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-KEEPME\n')
    const id = keys.list().find((k) => k.provider === 'anthropic')!.id

    keys.update(id, { assignedTo: [] })
    keys.removeKeyFromEnv('agent-b', 'anthropic')
    // Re-assign: value must still resolve so it can be written back.
    const val = keys.getDecryptedValue(id)
    expect(val).toBe('sk-ant-api03-KEEPME')
    keys.update(id, { assignedTo: ['h_agent_b'] })
    expect(keys.list().find((k) => k.id === id)!.assignedTo).toEqual(['h_agent_b'])
  })
})

// Bluesky is a credential PAIR: the app password is the key's secret value
// (BLUESKY_APP_PASSWORD) and the account handle rides in the key's
// `identifier` metadata, emitted as BLUESKY_IDENTIFIER at write time.
describe('bluesky credential pair (writeKeyToEnv/removeKeyFromEnv)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let keys: KeysService

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bsky-home-'))
    prevHome = process.env.HOME
    process.env.HOME = tmpHome
    const storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-bsky-store-')))
    keys = new KeysService(storage, new AuditService(storage))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  const envFor = (name: string) => path.join(tmpHome, `.hermes-${name}`, '.env')
  const read = (name: string) => fs.readFileSync(envFor(name), 'utf-8')

  const PASS = 'abcd-efgh-ijkl-mnop'

  it('writes BOTH vars when the identifier hint is present', () => {
    keys.writeKeyToEnv('heron', 'bluesky', PASS, { identifier: 'handle.example.com' })
    const env = read('heron')
    expect(env).toMatch(new RegExp(`^BLUESKY_APP_PASSWORD=${PASS}$`, 'm'))
    expect(env).toMatch(/^BLUESKY_IDENTIFIER=handle\.example\.com$/m)
  })

  it('writes only the password without an identifier hint (never half-clears)', () => {
    fs.mkdirSync(path.join(tmpHome, '.hermes-heron'), { recursive: true })
    fs.writeFileSync(envFor('heron'), 'BLUESKY_IDENTIFIER=hand.written\n')
    keys.writeKeyToEnv('heron', 'bluesky', PASS)
    const env = read('heron')
    expect(env).toMatch(/^BLUESKY_APP_PASSWORD=/m)
    // A pre-existing hand-written identifier survives an identifier-less write.
    expect(env).toMatch(/^BLUESKY_IDENTIFIER=hand\.written$/m)
  })

  it('updates a stale identifier on rewrite', () => {
    keys.writeKeyToEnv('heron', 'bluesky', PASS, { identifier: 'old.handle' })
    keys.writeKeyToEnv('heron', 'bluesky', PASS, { identifier: 'new.handle' })
    const env = read('heron')
    expect(env).toMatch(/^BLUESKY_IDENTIFIER=new\.handle$/m)
    expect(env).not.toMatch(/old\.handle/)
  })

  it('removeKeyFromEnv clears both halves of the pair', () => {
    keys.writeKeyToEnv('heron', 'bluesky', PASS, { identifier: 'handle.example.com' })
    keys.removeKeyFromEnv('heron', 'bluesky')
    const env = read('heron')
    expect(env).not.toMatch(/BLUESKY_APP_PASSWORD/)
    expect(env).not.toMatch(/BLUESKY_IDENTIFIER/)
  })

  it('preserves unrelated env vars when writing/removing the pair', () => {
    fs.mkdirSync(path.join(tmpHome, '.hermes-heron'), { recursive: true })
    fs.writeFileSync(envFor('heron'), 'GITHUB_TOKEN=ghp_KEEP\n')
    keys.writeKeyToEnv('heron', 'bluesky', PASS, { identifier: 'handle.example.com' })
    keys.removeKeyFromEnv('heron', 'bluesky')
    expect(read('heron')).toMatch(/^GITHUB_TOKEN=ghp_KEEP$/m)
  })

  it('add() keeps the identifier on the stored key', () => {
    const key = keys.add({ provider: 'bluesky', value: PASS, identifier: 'handle.example.com' })
    expect(key.identifier).toBe('handle.example.com')
    expect(keys.list([]).find((k) => k.id === key.id)!.identifier).toBe('handle.example.com')
  })
})
