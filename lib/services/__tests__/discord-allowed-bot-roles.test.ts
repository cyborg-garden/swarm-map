// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DISCORD_ALLOWED_BOT_ROLES_VAR,
  GUILD_IDS_VAR,
  guildIds,
  discordAllowedBotRolesPosture,
  isAllowedBotRoleList,
  setAllowedBotRolesEnv,
  syncDiscordAllowedBotRoles,
} from '../discord-allowed-bot-roles'
import { validateSettingsPatch } from '../config'

const ROLE = '1600000000000000001'
const ROLE2 = '1600000000000000002'
// A guild id is also its @everyone role id. The real one is instance config
// (DISCORD_GUILD_IDS), never source; tests use a made-up one.
const GARDEN_GUILD_ID = '1600000000000000099'
beforeEach(() => { vi.stubEnv('DISCORD_GUILD_IDS', GARDEN_GUILD_ID) })
afterEach(() => { vi.unstubAllEnvs() })
const BASE = 'DISCORD_BOT_TOKEN=t\nDISCORD_ALLOW_BOTS=mentions\nDISCORD_ALLOWED_USERS=123456789012345678\n'

describe('setAllowedBotRolesEnv', () => {
  it('appends the var when absent, leaving every other line alone', () => {
    const { status, env } = setAllowedBotRolesEnv(BASE, [ROLE])
    expect(status).toBe('updated')
    expect(env).toBe(BASE + `${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE}\n`)
  })

  it('is unchanged when the value already matches', () => {
    const env = BASE + `${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE},${ROLE2}\n`
    expect(setAllowedBotRolesEnv(env, [ROLE, ROLE2])).toEqual({ status: 'unchanged', env })
  })

  it('replaces an existing value in place and collapses duplicate lines', () => {
    const env = `${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE2}\n` + BASE + `${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE2}\n`
    const out = setAllowedBotRolesEnv(env, [ROLE])
    expect(out.status).toBe('updated')
    expect(out.env.match(new RegExp(`^${DISCORD_ALLOWED_BOT_ROLES_VAR}=`, 'gm'))).toHaveLength(1)
    expect(out.env.startsWith(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE}\n`)).toBe(true)
    expect(out.env).toContain('DISCORD_ALLOW_BOTS=mentions')
  })

  it('heals an empty value (which would turn the gate off)', () => {
    const out = setAllowedBotRolesEnv(BASE + `${DISCORD_ALLOWED_BOT_ROLES_VAR}=\n`, [ROLE])
    expect(out.status).toBe('updated')
    expect(out.env).toContain(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE}`)
  })

  it('refuses anything that is not a non-empty list of role IDs', () => {
    for (const bad of [[], ['trusted-bot'], ['123'], [`${ROLE}\nDISCORD_ALLOW_ALL_USERS=true`], [`${ROLE},1`], [GARDEN_GUILD_ID]]) {
      expect(() => setAllowedBotRolesEnv(BASE, bad as string[])).toThrow()
    }
  })
})

describe('validateSettingsPatch — discordAllowedBotRoles', () => {
  it('accepts role IDs and null, dedups', () => {
    expect(validateSettingsPatch({ discordAllowedBotRoles: [ROLE, ROLE] })).toEqual({ discordAllowedBotRoles: [ROLE] })
    expect(validateSettingsPatch({ discordAllowedBotRoles: null })).toEqual({ discordAllowedBotRoles: null })
  })

  it('refuses [], names, non-IDs, injection, and the @everyone (guild) id', () => {
    for (const bad of [[], ROLE, ['trusted-bot'], ['123'], [`${ROLE}\nX=y`], [GARDEN_GUILD_ID], [ROLE, GARDEN_GUILD_ID]]) {
      expect(() => validateSettingsPatch({ discordAllowedBotRoles: bad })).toThrow()
    }
  })

  it('agrees with the writer-side check (they are separate copies)', () => {
    const cases: unknown[] = [[ROLE], [], ['x'], [GARDEN_GUILD_ID], [ROLE, ROLE2], ['1'.repeat(22)], [123]]
    for (const c of cases) {
      let accepted = true
      try { validateSettingsPatch({ discordAllowedBotRoles: c }) } catch { accepted = false }
      expect(accepted).toBe(isAllowedBotRoleList(c))
    }
  })
})

describe('fleet sync + posture', () => {
  let home: string
  const dir = (n: string) => path.join(home, `.hermes-${n}`)
  const envOf = (n: string) => fs.readFileSync(path.join(dir(n), '.env'), 'utf-8')
  const targets = () => ['iris', 'mare', 'personal', 'gone'].map((name) => ({ name, dataDir: dir(name) }))

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-roles-'))
    for (const n of ['iris', 'mare']) {
      fs.mkdirSync(dir(n), { recursive: true })
      fs.writeFileSync(path.join(dir(n), '.env'), BASE, { mode: 0o600 })
    }
    fs.mkdirSync(dir('personal'), { recursive: true })
    fs.writeFileSync(path.join(dir('personal'), '.env'), 'SIGNAL_ACCOUNT=+1\n')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('writes Discord agents only, keeps the .env mode, and is idempotent', () => {
    const r = syncDiscordAllowedBotRoles(targets(), [ROLE])
    expect(r.updated).toEqual(['iris', 'mare'])
    expect(r.skipped).toEqual([{ name: 'personal', reason: 'no-discord' }, { name: 'gone', reason: 'no-env' }])
    expect(envOf('iris')).toContain(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE}`)
    expect(envOf('personal')).toBe('SIGNAL_ACCOUNT=+1\n')
    expect(fs.statSync(path.join(dir('iris'), '.env')).mode & 0o777).toBe(0o600)
    expect(syncDiscordAllowedBotRoles(targets(), [ROLE]).unchanged).toEqual(['iris', 'mare'])
  })

  it('never throws on a bad list; reports every agent as failed instead', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = syncDiscordAllowedBotRoles(targets(), ['nope'])
    expect(r.failed).toEqual(['iris', 'mare'])
    expect(envOf('iris')).toBe(BASE)
  })

  it('posture reports drift and allow_bots without writing', () => {
    const p = discordAllowedBotRolesPosture(targets(), [ROLE])
    expect(p.drift).toEqual(['iris', 'mare'])
    expect(p.agents[0]).toEqual({ name: 'iris', status: 'drift', roles: [], allowBots: 'mentions' })
    expect(envOf('iris')).toBe(BASE)
    expect(discordAllowedBotRolesPosture(targets(), null).agents.every((a) => a.status === 'unmanaged')).toBe(true)
  })
})

describe('applyAllowedBotRolesSetting', () => {
  it('writes for a Discord agent when the setting is a valid list', async () => {
    const { applyAllowedBotRolesSetting } = await import('../discord-allowed-bot-roles')
    expect(applyAllowedBotRolesSetting(BASE, [ROLE])).toContain(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=${ROLE}`)
  })

  it('leaves the text alone when unmanaged, invalid, or not a Discord agent', async () => {
    const { applyAllowedBotRolesSetting } = await import('../discord-allowed-bot-roles')
    for (const s of [undefined, null, [], ['x'], [GARDEN_GUILD_ID], 'x']) {
      expect(applyAllowedBotRolesSetting(BASE, s)).toBe(BASE)
    }
    expect(applyAllowedBotRolesSetting('SIGNAL_ACCOUNT=+1\n', [ROLE])).toBe('SIGNAL_ACCOUNT=+1\n')
  })
})


describe('guild ids come from instance config, not source', () => {
  it('reads DISCORD_GUILD_IDS as a comma list of snowflakes, ignoring junk', () => {
    vi.stubEnv(GUILD_IDS_VAR, ` ${GARDEN_GUILD_ID}, 1600000000000000098 ,x,`)
    expect(guildIds()).toEqual([GARDEN_GUILD_ID, '1600000000000000098'])
  })

  it('refuses every listed guild id as a role, in both copies of the rule', () => {
    vi.stubEnv(GUILD_IDS_VAR, `1600000000000000098,${GARDEN_GUILD_ID}`)
    for (const g of ['1600000000000000098', GARDEN_GUILD_ID]) {
      expect(isAllowedBotRoleList([g])).toBe(false)
      expect(() => validateSettingsPatch({ discordAllowedBotRoles: [g] })).toThrow()
    }
  })

  it('unset = no guild-id refusal (safe default for any other deployment)', () => {
    vi.stubEnv(GUILD_IDS_VAR, '')
    expect(guildIds()).toEqual([])
    expect(isAllowedBotRoleList([GARDEN_GUILD_ID])).toBe(true)
    expect(validateSettingsPatch({ discordAllowedBotRoles: [GARDEN_GUILD_ID] })).toEqual({ discordAllowedBotRoles: [GARDEN_GUILD_ID] })
  })

  it('no deployment\'s guild id is hardcoded in the services', () => {
    for (const f of ['discord-allowed-bot-roles.ts', 'config.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      expect(src).not.toMatch(/['"][0-9]{17,20}['"]/)
    }
  })
})
