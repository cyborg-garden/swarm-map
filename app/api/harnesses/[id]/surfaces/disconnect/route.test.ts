/**
 * Tests for POST /api/harnesses/:id/surfaces/disconnect
 *
 * Disconnecting a surface strips its vars from the agent .env, but the running
 * container keeps the stale env (and the live connection) until recreated.
 * Disconnect must recreate the container so the surface actually goes away.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'

const restartMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services', () => ({
  services: {
    harness: { restart: restartMock },
  },
}))

import { POST } from './route'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.spyOn(os, 'homedir').mockReturnValue('/home/test')
  vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  vi.spyOn(fs, 'readFileSync').mockReturnValue('TELEGRAM_BOT_TOKEN=tok\nTELEGRAM_ALLOWED_USERS=1\n')
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('surface disconnect — applies removal by recreating the container', () => {
  it('recreates the container after stripping the telegram env', async () => {
    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/disconnect', {
      method: 'POST',
      body: JSON.stringify({ platform: 'telegram' }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(restartMock).toHaveBeenCalledWith('h_seraph', 'recreate')
  })

  it('recreates the container after stripping the discord env', async () => {
    // A .env carrying the full Discord policy surface — the strip assertions
    // below are only meaningful if every key is actually present beforehand.
    vi.mocked(fs.readFileSync).mockReturnValue([
      'GITHUB_TOKEN=x',
      'DISCORD_BOT_TOKEN=tok',
      'DISCORD_ALLOWED_USERS=111',
      'DISCORD_ALLOWED_CHANNELS=555',
      'DISCORD_ALLOWED_ROLES=777',
      'DISCORD_IGNORED_CHANNELS=888',
      'DISCORD_DM_ALLOWED_USERS=111',
      'DISCORD_ALLOW_BOTS=none',
      'DISCORD_REQUIRE_MENTION=true',
      'DISCORD_CHANNEL_SCOPED_ACCESS=true',
    ].join('\n') + '\n' as never)
    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/disconnect', {
      method: 'POST',
      body: JSON.stringify({ platform: 'discord' }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(restartMock).toHaveBeenCalledWith('h_seraph', 'recreate')

    // Credentials and identity-bound lists are stripped — ids are meaningless
    // outside the disconnected guild and must not leak into a future connect.
    const envWrite = (fs.writeFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .find(c => typeof c[0] === 'string' && (c[0] as string).endsWith('.env'))
    const written = (envWrite?.[1] as string) ?? ''
    for (const key of [
      'DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS',
      'DISCORD_ALLOWED_ROLES', 'DISCORD_IGNORED_CHANNELS', 'DISCORD_DM_ALLOWED_USERS',
    ]) {
      expect(written).not.toContain(`${key}=`)
    }
    // Behavioral preferences survive a disconnect: nothing reseeds their
    // VALUES on reconnect, so stripping them silently changed agent behavior.
    expect(written).toContain('DISCORD_REQUIRE_MENTION=true')
    expect(written).toContain('DISCORD_ALLOW_BOTS=none')
    expect(written).toContain('DISCORD_CHANNEL_SCOPED_ACCESS=true')
  })

  it('recreates the container after stripping the slack env', async () => {
    const req = new Request('http://localhost/api/harnesses/h_seraph/surfaces/disconnect', {
      method: 'POST',
      body: JSON.stringify({ platform: 'slack' }),
    })

    const res = await POST(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(restartMock).toHaveBeenCalledWith('h_seraph', 'recreate')
  })
})

describe('surface disconnect — disables the platform in config.yaml', () => {
  // The gateway starts every platform with `platforms.<p>.enabled: true` —
  // disconnect must flip the flag or the surface comes back on next boot.

  function disconnect(platform: string) {
    return POST(
      new Request('http://localhost/api/harnesses/h_seraph/surfaces/disconnect', {
        method: 'POST',
        body: JSON.stringify({ platform }),
      }),
      makeParams('h_seraph')
    )
  }

  function configWrite() {
    return vi.mocked(fs.writeFileSync).mock.calls.find(c => String(c[0]).endsWith('config.yaml'))
  }

  it('sets enabled: false without deleting sibling keys', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('config.yaml')) {
        return 'platforms:\n  discord:\n    enabled: true\n    intents: default\n  telegram:\n    enabled: true\n'
      }
      return 'DISCORD_BOT_TOKEN=tok\n'
    })

    const res = await disconnect('discord')
    expect(res.status).toBe(200)

    const written = configWrite()?.[1] as string
    expect(written).toContain('  discord:\n    enabled: false\n    intents: default')
    // Other platforms untouched.
    expect(written).toContain('  telegram:\n    enabled: true')
  })

  it('is a no-op when the platform entry is missing (no config write)', async () => {
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('config.yaml')) {
        return 'platforms:\n  telegram:\n    enabled: true\n'
      }
      return 'DISCORD_BOT_TOKEN=tok\n'
    })

    const res = await disconnect('discord')
    expect(res.status).toBe(200)
    expect(configWrite()).toBeUndefined()
  })

  it('skips gracefully when config.yaml does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => !String(p).endsWith('config.yaml'))

    const res = await disconnect('discord')
    expect(res.status).toBe(200)
    expect(configWrite()).toBeUndefined()
  })
})
