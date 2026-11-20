// @vitest-environment node
// Fleet wiring for the Discord thread gate: target enumeration, the opt-out
// setting, the once-per-start heal, and the report-only posture route.
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

import {
  fleetThreadGateTargets,
  healFleetDiscordThreadGatesAtStartup,
} from '../discord-thread-gate-fleet'
import { GET } from '@/app/api/fleet/discord-thread-posture/route'

let home: string
const agentDir = (name: string) => path.join(home, `.hermes-${name}`)
function mkAgent(name: string, env: string, yaml?: string) {
  fs.mkdirSync(agentDir(name), { recursive: true })
  fs.writeFileSync(path.join(agentDir(name), '.env'), env, { mode: 0o600 })
  if (yaml !== undefined) fs.writeFileSync(path.join(agentDir(name), 'config.yaml'), yaml)
}
const env = (name: string) => fs.readFileSync(path.join(agentDir(name), '.env'), 'utf-8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-gate-fleet-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  listMock.mockReturnValue([
    { id: 'h_harbor', name: 'harbor', runtime: 'hermes' },
    { id: 'h_kestrel', name: 'kestrel', runtime: 'hermes' },
    { id: 'h_public_bot', name: 'public-bot', runtime: 'hermes' },
  ])
  getSettingsMock.mockReturnValue({ discordThreadMentionOptOuts: ['kestrel'] })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('fleetThreadGateTargets', () => {
  it('maps harness ids to data dirs', () => {
    expect(fleetThreadGateTargets()).toEqual([
      { name: 'harbor', dataDir: agentDir('harbor') },
      { name: 'kestrel', dataDir: agentDir('kestrel') },
      { name: 'public-bot', dataDir: agentDir('public-bot') },
    ])
  })
})

describe('healFleetDiscordThreadGatesAtStartup', () => {
  it('heals agents lacking the key, honours the opt-out setting, keeps explicit values', () => {
    mkAgent('harbor', 'DISCORD_BOT_TOKEN=t\n', 'discord:\n  thread_require_mention: false\n')
    mkAgent('kestrel', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('public-bot', 'DISCORD_BOT_TOKEN=t\nDISCORD_THREAD_REQUIRE_MENTION=false\n')

    const res = healFleetDiscordThreadGatesAtStartup()
    expect(res).toMatchObject({ healed: ['harbor'], skipped: ['kestrel'], failed: [] })
    expect(env('harbor')).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    expect(env('kestrel')).toBe('DISCORD_BOT_TOKEN=t\n')
    expect(env('public-bot')).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=false$/m)
    expect(fs.statSync(path.join(agentDir('harbor'), '.env')).mode & 0o777).toBe(0o600)
  })

  it('never throws — a broken settings read degrades to null', () => {
    getSettingsMock.mockImplementation(() => { throw new Error('boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(healFleetDiscordThreadGatesAtStartup()).toBeNull()
  })

  it('works with no opt-out setting at all', () => {
    getSettingsMock.mockReturnValue({})
    mkAgent('kestrel', 'DISCORD_BOT_TOKEN=t\n')
    expect(healFleetDiscordThreadGatesAtStartup()?.healed).toEqual(['kestrel'])
  })
})

describe('GET /api/fleet/discord-thread-posture', () => {
  it('reports open agents and writes nothing', async () => {
    mkAgent('harbor', 'DISCORD_BOT_TOKEN=t\n', 'discord:\n  thread_require_mention: false\n')
    mkAgent('kestrel', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('public-bot', 'DISCORD_BOT_TOKEN=t\nDISCORD_THREAD_REQUIRE_MENTION=true\n')
    const before = ['harbor', 'kestrel', 'public-bot'].map(env)

    const res = await GET(new Request('http://localhost/api/fleet/discord-thread-posture'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.open).toEqual(['harbor'])
    expect(body.adapterDefault).toBe(false)
    const byName = Object.fromEntries(body.agents.map((a: { name: string }) => [a.name, a]))
    expect(byName.kestrel.status).toBe('opted-out')
    expect(byName['public-bot'].status).toBe('ok')
    expect(['harbor', 'kestrel', 'public-bot'].map(env)).toEqual(before)
  })

  it('?adapterDefault=true treats an agent relying on the default as gated', async () => {
    mkAgent('harbor', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('kestrel', 'SIGNAL_ACCOUNT=+1\n')
    mkAgent('public-bot', 'SIGNAL_ACCOUNT=+1\n')
    const res = await GET(new Request('http://localhost/api/fleet/discord-thread-posture?adapterDefault=true'))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agents[0]).toMatchObject({ name: 'harbor', status: 'ok', source: 'adapter-default' })
  })
})
