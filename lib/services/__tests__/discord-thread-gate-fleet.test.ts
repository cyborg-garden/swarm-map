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
    { id: 'h_nimbleco', name: 'nimbleco', runtime: 'hermes' },
    { id: 'h_blackhouse', name: 'blackhouse', runtime: 'hermes' },
    { id: 'h_cyborg_public', name: 'cyborg-public', runtime: 'hermes' },
    { id: 'h_letta_x', name: 'letta-x', runtime: 'letta' },
  ])
  getSettingsMock.mockReturnValue({ discordThreadMentionOptOuts: ['blackhouse'] })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('fleetThreadGateTargets', () => {
  it('maps harness ids to data dirs and skips Letta (no .env)', () => {
    expect(fleetThreadGateTargets()).toEqual([
      { name: 'nimbleco', dataDir: agentDir('nimbleco') },
      { name: 'blackhouse', dataDir: agentDir('blackhouse') },
      { name: 'cyborg-public', dataDir: agentDir('cyborg-public') },
    ])
  })
})

describe('healFleetDiscordThreadGatesAtStartup', () => {
  it('heals agents lacking the key, honours the opt-out setting, keeps explicit values', () => {
    mkAgent('nimbleco', 'DISCORD_BOT_TOKEN=t\n', 'discord:\n  thread_require_mention: false\n')
    mkAgent('blackhouse', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('cyborg-public', 'DISCORD_BOT_TOKEN=t\nDISCORD_THREAD_REQUIRE_MENTION=false\n')

    const res = healFleetDiscordThreadGatesAtStartup()
    expect(res).toMatchObject({ healed: ['nimbleco'], skipped: ['blackhouse'], failed: [] })
    expect(env('nimbleco')).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    expect(env('blackhouse')).toBe('DISCORD_BOT_TOKEN=t\n')
    expect(env('cyborg-public')).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=false$/m)
    expect(fs.statSync(path.join(agentDir('nimbleco'), '.env')).mode & 0o777).toBe(0o600)
  })

  it('never throws — a broken settings read degrades to null', () => {
    getSettingsMock.mockImplementation(() => { throw new Error('boom') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(healFleetDiscordThreadGatesAtStartup()).toBeNull()
  })

  it('works with no opt-out setting at all', () => {
    getSettingsMock.mockReturnValue({})
    mkAgent('blackhouse', 'DISCORD_BOT_TOKEN=t\n')
    expect(healFleetDiscordThreadGatesAtStartup()?.healed).toEqual(['blackhouse'])
  })
})

describe('GET /api/fleet/discord-thread-posture', () => {
  it('reports open agents and writes nothing', async () => {
    mkAgent('nimbleco', 'DISCORD_BOT_TOKEN=t\n', 'discord:\n  thread_require_mention: false\n')
    mkAgent('blackhouse', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('cyborg-public', 'DISCORD_BOT_TOKEN=t\nDISCORD_THREAD_REQUIRE_MENTION=true\n')
    const before = ['nimbleco', 'blackhouse', 'cyborg-public'].map(env)

    const res = await GET(new Request('http://localhost/api/fleet/discord-thread-posture'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.open).toEqual(['nimbleco'])
    expect(body.adapterDefault).toBe(false)
    const byName = Object.fromEntries(body.agents.map((a: { name: string }) => [a.name, a]))
    expect(byName.blackhouse.status).toBe('opted-out')
    expect(byName['cyborg-public'].status).toBe('ok')
    expect(['nimbleco', 'blackhouse', 'cyborg-public'].map(env)).toEqual(before)
  })

  it('?adapterDefault=true treats an agent relying on the default as gated', async () => {
    mkAgent('nimbleco', 'DISCORD_BOT_TOKEN=t\n')
    mkAgent('blackhouse', 'SIGNAL_ACCOUNT=+1\n')
    mkAgent('cyborg-public', 'SIGNAL_ACCOUNT=+1\n')
    const res = await GET(new Request('http://localhost/api/fleet/discord-thread-posture?adapterDefault=true'))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.agents[0]).toMatchObject({ name: 'nimbleco', status: 'ok', source: 'adapter-default' })
  })
})
