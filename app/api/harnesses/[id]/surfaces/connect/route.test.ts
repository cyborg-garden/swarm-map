/**
 * Tests for POST /api/harnesses/:id/surfaces/connect
 *
 * Regression: connecting/editing a surface writes the agent .env but the
 * running container kept the OLD environment until a manual force-recreate.
 * A `connect` must recreate the container so the new env actually takes effect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'

// Mock the services module — we assert harness.restart is invoked.
const restartMock = vi.hoisted(() => vi.fn())
const syncFromAllowlistMock = vi.hoisted(() => vi.fn())
const listAdminsMock = vi.hoisted(() => vi.fn((): { source: string; admins: string[] } => ({ source: 'allowlist', admins: [] })))
const getSettingsMock = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('@/lib/services', () => ({
  services: {
    harness: { restart: restartMock },
    surfaceAdmins: { syncFromAllowlist: syncFromAllowlistMock, listAdmins: listAdminsMock },
    config: { getSettings: getSettingsMock },
  },
}))
// Use the real resolvers index (so resolveTelegramAdmins' strict logic is
// exercised through the route) but stub the per-platform network resolvers.
vi.mock('@/lib/resolvers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/resolvers')>()),
  expandSignalAllowlist: vi.fn(async () => [
    '+15550001234',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ]),
}))
const resolveTelegramUsernameMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/resolvers/telegram', () => ({
  resolveTelegramUsername: resolveTelegramUsernameMock,
  getTelegramDisplayName: vi.fn(async () => null),
}))

import { POST } from './route'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

let readSpy: ReturnType<typeof vi.spyOn>
let writeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // vi.restoreAllMocks() only restores spies — hoisted vi.fn() mocks keep their
  // call history across tests unless cleared here.
  restartMock.mockClear()
  syncFromAllowlistMock.mockClear()
  listAdminsMock.mockReset()
  listAdminsMock.mockReturnValue({ source: 'allowlist', admins: [] })
  resolveTelegramUsernameMock.mockClear()
  vi.spyOn(os, 'homedir').mockReturnValue('/home/test')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  readSpy = vi.spyOn(fs, 'readFileSync')
  readSpy.mockReturnValue('TELEGRAM_BOT_TOKEN=old\n')
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('surface connect — applies env by recreating the container', () => {
  it('recreates the container after writing the new telegram env', async () => {
    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/connect', {
      method: 'POST',
      body: JSON.stringify({ platform: 'telegram', config: { token: 'new-bot-token' } }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    // The env was written...
    expect(writeSpy).toHaveBeenCalled()
    // ...and the container recreated so the env takes effect (no rebuild needed).
    expect(restartMock).toHaveBeenCalledWith('h_seraph', 'recreate')
  })

  it('writes both the phone and its resolved UUID into SIGNAL_ALLOWED_USERS', async () => {
    readSpy.mockReturnValue('SIGNAL_ACCOUNT=+16189263363\n')
    // Signal connect runs a pre-flight daemon health check via fetch.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: [] }) })))

    const req = new Request('http://localhost/api/harnesses/h_nimbleco/surfaces/connect', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'signal',
        config: { phone: '+16189263363', adminUser: '+15550001234' },
      }),
    })

    const res = await POST(req, makeParams('h_nimbleco'))
    expect(res.status).toBe(200)

    // Target the .env write — connect now also writes config.yaml afterwards.
    const written = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))?.[1] as string
    expect(written).toContain(
      'SIGNAL_ALLOWED_USERS=+15550001234,aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    )
    vi.unstubAllGlobals()
  })

  it('resolves telegram @handles to numeric IDs and normalizes multiple admins', async () => {
    resolveTelegramUsernameMock.mockResolvedValue({
      display: '@juniper',
      nativeId: '424242',
      profileName: 'Juniper',
    })

    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/connect', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'telegram',
        config: { token: 'new-bot-token', adminUser: '123456789, @juniper' },
      }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(200)

    // The token from the request payload is used (the .env may not have it yet).
    expect(resolveTelegramUsernameMock).toHaveBeenCalledWith('h_seraph', '@juniper', 'new-bot-token')

    // Numeric IDs only in the env — never a raw @handle.
    const envCall = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))
    expect(envCall?.[1]).toContain('TELEGRAM_ALLOWED_USERS=123456789,424242')

    // Display names persisted the same way the settings path does.
    const resolvedCall = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('resolved-identities.json'))
    expect(resolvedCall).toBeTruthy()
    expect(JSON.parse(resolvedCall![1] as string).telegram).toEqual([
      { display: '123456789', nativeId: '123456789' },
      { display: '@juniper', nativeId: '424242', profileName: 'Juniper' },
    ])

    // Policy-plane overlay kept converged with the allowlist just written.
    expect(syncFromAllowlistMock).toHaveBeenCalledWith('h_seraph', 'telegram', ['123456789', '424242'])
  })

  it('returns 400 (and writes nothing) when a telegram @handle fails to resolve', async () => {
    resolveTelegramUsernameMock.mockResolvedValue(null)

    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/connect', {
      method: 'POST',
      body: JSON.stringify({
        platform: 'telegram',
        config: { token: 'new-bot-token', adminUser: '@ghosthandle' },
      }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('@ghosthandle')
    expect(writeSpy).not.toHaveBeenCalled()
    expect(restartMock).not.toHaveBeenCalled()
  })

  it('still succeeds (does not 500) when recreate fails', async () => {
    restartMock.mockImplementationOnce(() => { throw new Error('no compose file') })

    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/connect', {
      method: 'POST',
      body: JSON.stringify({ platform: 'telegram', config: { token: 'new-bot-token' } }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(200)
  })
})

describe('surface connect — enables the platform in config.yaml', () => {
  // The gateway only starts platforms with `platforms.<p>.enabled: true`
  // (gateway/run.py), so connect must manage that flag — .env alone is dead.

  function connectDiscord() {
    return POST(
      new Request('http://localhost/api/harnesses/h_seraph/surfaces/connect', {
        method: 'POST',
        body: JSON.stringify({ platform: 'discord', config: { token: 'bot.token' } }),
      }),
      makeParams('h_seraph')
    )
  }

  function configWrite() {
    return writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('config.yaml'))
  }

  it('flips an existing enabled: false entry to true', async () => {
    readSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('config.yaml')) {
        return 'model:\n  provider: anthropic\n\nplatforms:\n  discord:\n    enabled: false\n    intents: default\n'
      }
      return 'DISCORD_BOT_TOKEN=old\n'
    })

    const res = await connectDiscord()
    expect(res.status).toBe(200)

    const written = configWrite()?.[1] as string
    expect(written).toContain('  discord:\n    enabled: true\n    intents: default')
  })

  it('inserts the platform entry when platforms: exists without it', async () => {
    readSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('config.yaml')) {
        return 'platforms:\n  telegram:\n    enabled: true\n'
      }
      return 'DISCORD_BOT_TOKEN=old\n'
    })

    const res = await connectDiscord()
    expect(res.status).toBe(200)

    const written = configWrite()?.[1] as string
    expect(written).toContain('  discord:\n    enabled: true')
    expect(written).toContain('  telegram:\n    enabled: true')
  })

  it('appends a platforms: block when config.yaml has none', async () => {
    readSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('config.yaml')) {
        return 'model:\n  provider: anthropic\n\nplatform_toolsets:\n  discord: [hermes-discord]\n'
      }
      return 'DISCORD_BOT_TOKEN=old\n'
    })

    const res = await connectDiscord()
    expect(res.status).toBe(200)

    const written = configWrite()?.[1] as string
    expect(written).toContain('platforms:\n  discord:\n    enabled: true')
    // platform_toolsets is NOT the platforms block — untouched.
    expect(written).toContain('platform_toolsets:\n  discord: [hermes-discord]')
  })

  it('does not rewrite config.yaml when the platform is already enabled', async () => {
    readSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('config.yaml')) {
        return 'platforms:\n  discord:\n    enabled: true\n'
      }
      return 'DISCORD_BOT_TOKEN=old\n'
    })

    const res = await connectDiscord()
    expect(res.status).toBe(200)
    expect(configWrite()).toBeUndefined()
  })

  it('seeds DISCORD_THREAD_REQUIRE_MENTION=true in .env and never writes it into config.yaml', async () => {
    // platforms.discord.extra.thread_require_mention OUTRANKS .env in the
    // adapter, so a generator writing it there would silently defeat the
    // .env policy. The value belongs in .env only.
    readSpy.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p).endsWith('config.yaml')) {
        return 'platforms:\n  discord:\n    enabled: false\n'
      }
      return 'DISCORD_BOT_TOKEN=old\n'
    })

    const res = await connectDiscord()
    expect(res.status).toBe(200)

    const envWrite = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))
    expect(envWrite?.[1] as string).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    expect(envWrite?.[1] as string).toMatch(/^DISCORD_REQUIRE_MENTION=true$/m)
    expect(configWrite()?.[1] as string).not.toContain('thread_require_mention')
  })

  it('applies the fleet discordAllowedBotRoles setting to the new Discord agent', async () => {
    getSettingsMock.mockReturnValueOnce({ discordAllowedBotRoles: ['1600000000000000001'] } as never)
    readSpy.mockImplementation(() => 'DISCORD_BOT_TOKEN=old\n')
    const res = await connectDiscord()
    expect(res.status).toBe(200)
    const envWrite = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))
    expect(envWrite?.[1] as string).toMatch(/^DISCORD_ALLOWED_BOT_ROLES=1600000000000000001$/m)
  })

  it('leaves DISCORD_ALLOWED_BOT_ROLES alone when the setting is unmanaged', async () => {
    readSpy.mockImplementation(() => 'DISCORD_BOT_TOKEN=old\n')
    await connectDiscord()
    const envWrite = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))
    expect(envWrite?.[1] as string).not.toContain('DISCORD_ALLOWED_BOT_ROLES')
  })

  it('skips config.yaml gracefully when it does not exist (agent not deployed)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => !String(p).endsWith('config.yaml'))

    const res = await connectDiscord()
    expect(res.status).toBe(200)
    expect(configWrite()).toBeUndefined()
  })
})

describe('POST connect: admins-only DMs', () => {
  const A = '100000000000000001'
  const B = '100000000000000002'
  // Signal connect runs a pre-flight daemon health check via fetch.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: [] }) })))
  })
  afterEach(() => vi.unstubAllGlobals())
  const connect = (platform: string, config: Record<string, string>) => POST(new Request('http://x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, config }),
  }), makeParams('h_test'))
  const envWritten = () => {
    const call = writeSpy.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('.env'))
    return (call?.[1] as string) ?? ''
  }
  const line = (key: string) => envWritten().match(new RegExp(`^${key}=.*$`, 'gm'))

  it('Discord with no admins starts closed', async () => {
    readSpy.mockReturnValue('X=1\n')
    await connect('discord', { token: 't' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS='])
  })

  it('Discord: a missing DM list is not seeded from the whole allowlist', async () => {
    readSpy.mockReturnValue(`DISCORD_BOT_TOKEN=old\nDISCORD_ALLOWED_USERS=${A},${B}\n`)
    await connect('discord', { token: 't' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS='])
  })

  it('Discord: a closed list is not filled from an explicit list just because admins were named', async () => {
    listAdminsMock.mockReturnValue({ source: 'explicit', admins: [B] })
    readSpy.mockReturnValue('DISCORD_DM_ALLOWED_USERS=\n')
    await connect('discord', { token: 't', adminUser: A })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS='])
  })

  it('Discord: warns when a seeded explicit admin is not on the allowlist', async () => {
    listAdminsMock.mockReturnValue({ source: 'explicit', admins: [B] })
    readSpy.mockReturnValue('X=1\n')
    const res = await connect('discord', { token: 't' })
    const body = await res.json() as { warning?: string }
    expect(body.warning).toContain('DISCORD_ALLOWED_USERS')
    expect(body.warning).toContain(B)
  })

  it('Discord seeds the admins named at connect', async () => {
    readSpy.mockReturnValue('X=1\n')
    await connect('discord', { token: 't', adminUser: A })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual([`DISCORD_DM_ALLOWED_USERS=${A}`])
  })

  it('Discord: an explicit admin list wins over the allowlist', async () => {
    listAdminsMock.mockReturnValue({ source: 'explicit', admins: [B] })
    readSpy.mockReturnValue(`DISCORD_ALLOWED_USERS=${A}\n`)
    await connect('discord', { token: 't' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual([`DISCORD_DM_ALLOWED_USERS=${B}`])
  })

  it('Discord: fills a closed list when admins are named, on an agent born closed at deploy', async () => {
    readSpy.mockReturnValue('DISCORD_BOT_TOKEN=old\nDISCORD_ALLOWED_USERS=\nDISCORD_DM_ALLOWED_USERS=\n')
    await connect('discord', { token: 't', adminUser: A })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual([`DISCORD_DM_ALLOWED_USERS=${A}`])
  })

  it('Discord: a token change keeps a hand-set or closed list, and a * stays', async () => {
    readSpy.mockReturnValue(`DISCORD_BOT_TOKEN=old\nDISCORD_ALLOWED_USERS=${A},${B}\nDISCORD_DM_ALLOWED_USERS=${A}\n`)
    await connect('discord', { token: 't' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual([`DISCORD_DM_ALLOWED_USERS=${A}`])
    writeSpy.mockClear()
    readSpy.mockReturnValue(`DISCORD_BOT_TOKEN=old\nDISCORD_ALLOWED_USERS=${A}\nDISCORD_DM_ALLOWED_USERS=\n`)
    await connect('discord', { token: 't' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS='])
    writeSpy.mockClear()
    readSpy.mockReturnValue('DISCORD_BOT_TOKEN=old\nDISCORD_DM_ALLOWED_USERS=*\n')
    await connect('discord', { token: 't', adminUser: A })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS=*'])
  })

  it('Discord: a username or * named at connect never reaches the DM list', async () => {
    readSpy.mockReturnValue('X=1\n')
    await connect('discord', { token: 't', adminUser: `somebody,*,${A}` })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual([`DISCORD_DM_ALLOWED_USERS=${A}`])
  })

  it('other platforms never get a Discord DM line', async () => {
    readSpy.mockReturnValue('X=1\n')
    await connect('slack', { botToken: 'b', appToken: 'a' })
    expect(line('DISCORD_DM_ALLOWED_USERS')).toBeNull()
  })

  it('Signal with no admins starts on the deny value', async () => {
    readSpy.mockReturnValue('X=1\n')
    await connect('signal', { phone: '+15550000000' })
    expect(line('SIGNAL_ALLOWED_USERS')).toEqual(['SIGNAL_ALLOWED_USERS=0'])
  })

  it('Signal: an explicit admin list seeds the list, expanded so sealed-sender DMs match', async () => {
    listAdminsMock.mockReturnValue({ source: 'explicit', admins: ['+15550001234'] })
    readSpy.mockReturnValue('X=1\n')
    await connect('signal', { phone: '+15550000000' })
    expect(line('SIGNAL_ALLOWED_USERS')).toEqual(['SIGNAL_ALLOWED_USERS=+15550001234,aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'])
  })

  it('Signal: an existing list is left alone', async () => {
    listAdminsMock.mockReturnValue({ source: 'explicit', admins: ['+15550001234'] })
    readSpy.mockReturnValue('SIGNAL_ALLOWED_USERS=+15550009999,+15550008888\n')
    await connect('signal', { phone: '+15550000000' })
    expect(line('SIGNAL_ALLOWED_USERS')).toEqual(['SIGNAL_ALLOWED_USERS=+15550009999,+15550008888'])
  })

  it('stays closed when the admin store cannot be read', async () => {
    listAdminsMock.mockImplementation(() => { throw new Error('store unreadable') })
    readSpy.mockReturnValue('X=1\n')
    expect((await connect('discord', { token: 't' })).status).toBe(200)
    expect(line('DISCORD_DM_ALLOWED_USERS')).toEqual(['DISCORD_DM_ALLOWED_USERS='])
  })
})
