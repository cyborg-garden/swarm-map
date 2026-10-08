// @vitest-environment node
// Fleet wiring for the bot-role setting: startup sync, and the
// GET (report) / POST (apply now) route.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const listMock = vi.hoisted(() => vi.fn())
const getSettingsMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services', () => ({
  services: {
    harness: { list: listMock },
    config: { getSettings: getSettingsMock },
  },
}))

import { syncFleetDiscordAllowedBotRolesAtStartup } from '../discord-allowed-bot-roles-fleet'
import { GET, POST } from '@/app/api/fleet/discord-allowed-bot-roles/route'

const ROLE = '1600000000000000001'
const ENV = 'DISCORD_BOT_TOKEN=t\nDISCORD_ALLOW_BOTS=mentions\n'

let home: string
const dir = (n: string) => path.join(home, `.hermes-${n}`)
const envOf = (n: string) => fs.readFileSync(path.join(dir(n), '.env'), 'utf-8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-roles-fleet-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  for (const n of ['iris', 'mare']) {
    fs.mkdirSync(dir(n), { recursive: true })
    fs.writeFileSync(path.join(dir(n), '.env'), ENV)
  }
  listMock.mockReturnValue([
    { id: 'h_iris', name: 'iris', runtime: 'hermes' },
    { id: 'h_mare', name: 'mare', runtime: 'hermes' },
    { id: 'h_l', name: 'l', runtime: 'letta' },
  ])
  getSettingsMock.mockReturnValue({ discordAllowedBotRoles: [ROLE] })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('syncFleetDiscordAllowedBotRolesAtStartup', () => {
  it('writes the setting into every Discord agent', () => {
    expect(syncFleetDiscordAllowedBotRolesAtStartup()?.updated).toEqual(['iris', 'mare'])
    expect(envOf('iris')).toBe(ENV + `DISCORD_ALLOWED_BOT_ROLES=${ROLE}\n`)
  })

  it('ignores a hand-edited setting that is not a list of role IDs, writing nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const bad of [[`${ROLE}\nDISCORD_ALLOW_ALL_USERS=true`], ['trusted-bot'], 'x', [123], [], ['1531068097719570432']]) {
      getSettingsMock.mockReturnValue({ discordAllowedBotRoles: bad })
      expect(syncFleetDiscordAllowedBotRolesAtStartup()).toBeNull()
    }
    expect(envOf('iris')).toBe(ENV)
  })

  it('does nothing when the setting is unset or null (unmanaged)', () => {
    getSettingsMock.mockReturnValue({})
    expect(syncFleetDiscordAllowedBotRolesAtStartup()).toBeNull()
    getSettingsMock.mockReturnValue({ discordAllowedBotRoles: null })
    expect(syncFleetDiscordAllowedBotRolesAtStartup()).toBeNull()
    expect(envOf('iris')).toBe(ENV)
  })

  it('never throws', () => {
    listMock.mockImplementation(() => { throw new Error('boom') })
    expect(syncFleetDiscordAllowedBotRolesAtStartup()).toBeNull()
  })
})

describe('/api/fleet/discord-allowed-bot-roles', () => {
  it('GET reports drift without writing', async () => {
    const body = await (await GET()).json()
    expect(body.desired).toEqual([ROLE])
    expect(body.drift).toEqual(['iris', 'mare'])
    expect(envOf('iris')).toBe(ENV)
  })

  it('POST applies the setting and says a restart is needed', async () => {
    const res = await POST()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.restartNeeded).toEqual(['iris', 'mare'])
    expect(envOf('mare')).toContain(`DISCORD_ALLOWED_BOT_ROLES=${ROLE}`)
  })

  it('POST refuses when the setting is unmanaged', async () => {
    getSettingsMock.mockReturnValue({})
    expect((await POST()).status).toBe(409)
    expect(envOf('iris')).toBe(ENV)
  })
})

describe('PUT /api/settings with discordAllowedBotRoles', () => {
  it('syncs the fleet right away', async () => {
    const updateSettings = vi.fn((p: Record<string, unknown>) => p)
    const { services } = await import('@/lib/services')
    ;(services.config as unknown as { updateSettings: typeof updateSettings }).updateSettings = updateSettings
    const { PUT } = await import('@/app/api/settings/route')
    const res = await PUT(new Request('http://x/api/settings', {
      method: 'PUT', body: JSON.stringify({ discordAllowedBotRoles: [ROLE] }),
    }))
    expect(res.status).toBe(200)
    expect(envOf('iris')).toContain(`DISCORD_ALLOWED_BOT_ROLES=${ROLE}`)
  })

  it('does not sync for unrelated settings', async () => {
    const updateSettings = vi.fn((p: Record<string, unknown>) => p)
    const { services } = await import('@/lib/services')
    ;(services.config as unknown as { updateSettings: typeof updateSettings }).updateSettings = updateSettings
    const { PUT } = await import('@/app/api/settings/route')
    await PUT(new Request('http://x/api/settings', { method: 'PUT', body: JSON.stringify({ onboarded: true }) }))
    expect(envOf('iris')).toBe(ENV)
  })
})
