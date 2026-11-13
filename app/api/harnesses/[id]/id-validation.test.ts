// @vitest-environment node
/**
 * The routes that edit an agent's files directly (settings, pairing, surface
 * connect/disconnect, policy group register) against real files in a temp
 * home. The id in the URL must be exactly a listed agent's id. Any other id —
 * another spelling of a listed agent, an id that names nothing, or a
 * malformed one — is refused with nothing on disk changed.
 *
 * harness-id-sweep.test.ts checks every route with the services mocked out;
 * this file checks these five against the bytes on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ restart: vi.fn(), updateConfig: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/services', () => ({
  services: {
    // Exact-id lookup over the one listed agent, like HarnessService.get.
    harness: {
      get: (id: string) => (id === 'h_foo_bar' ? { id, name: 'foo-bar' } : undefined),
      restart: h.restart,
      updateConfig: h.updateConfig,
    },
    config: { getSettings: () => ({}) },
    surfaceAdmins: { syncFromAllowlist: h.sync, listAdmins: () => ({ admins: [], source: 'allowlist' }) },
    keys: { list: () => [] },
  },
}))
vi.mock('@/lib/resolvers', () => ({
  resolveIdentifier: vi.fn(async () => null),
  resolveTelegramAdmins: vi.fn(async () => ({ ok: true, ids: [], resolved: [] })),
  expandSignalAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandTelegramAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandDiscordAllowlist: vi.fn(async (_id: string, users: string[]) => users),
}))

import { GET as getSettings, PUT as putSettings } from './settings/route'
import { GET as getPairing, DELETE as deletePairing } from './pairing/route'
import { POST as connect } from './surfaces/connect/route'
import { POST as disconnect } from './surfaces/disconnect/route'
import { POST as postPolicy } from './policy/route'
import { GET as getHarness } from './route'

const ENV = 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_ALLOWED_USERS=111\nTELEGRAM_GROUP_ALLOWED_CHATS=g1\n'
const PAIRING = JSON.stringify({ '111': { user_name: 'a', approved_at: 1 } })

// Not the listed id: other spellings of it, an id for nothing, malformed ids.
const OTHER_SPELLINGS = ['h_foo-bar', 'foo-bar', 'h_FOO_BAR', 'foo_bar']
const UNKNOWN = ['h_nobody']
const MALFORMED = ['x/../.hermes-foo-bar', 'h_x/../.hermes-foo-bar', '../.hermes-foo-bar', 'h_foo_bar/', 'h_foo.bar']

let home: string
const agentDir = () => path.join(home, '.hermes-foo-bar')
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const json = (method: string, body: unknown, query = '') =>
  new Request(`http://localhost/api/x${query}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function snapshot(dir = home, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + e.name
    if (e.isDirectory()) Object.assign(out, { [rel + '/']: '' }, snapshot(path.join(dir, e.name), rel + '/'))
    else out[rel] = fs.readFileSync(path.join(dir, e.name), 'utf-8')
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'id-validation-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  fs.mkdirSync(path.join(agentDir(), 'platforms', 'pairing'), { recursive: true })
  fs.writeFileSync(path.join(agentDir(), '.env'), ENV)
  fs.writeFileSync(path.join(agentDir(), 'platforms', 'pairing', 'telegram-approved.json'), PAIRING)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

const SETTINGS_BODY = { dmPolicy: 'allow-all', groupInvitePolicy: 'allow-all', mentionGating: false, surfaces: {} }
const WRITES: Array<[string, (id: string) => Promise<Response>]> = [
  ['PUT settings', (id) => putSettings(json('PUT', SETTINGS_BODY), params(id))],
  ['DELETE pairing', (id) => deletePairing(json('DELETE', { platform: 'telegram', userId: '111' }), params(id))],
  ['POST surfaces/connect', (id) => connect(json('POST', { platform: 'telegram', config: { botToken: 'new-token' } }), params(id))],
  ['POST surfaces/disconnect', (id) => disconnect(json('POST', { platform: 'telegram' }), params(id))],
  ['POST policy', (id) => postPolicy(json('POST', { action: 'group-register', platform: 'telegram', chatId: 'g2' }), params(id))],
]

describe.each(WRITES)('%s', (_name, call) => {
  it.each([...OTHER_SPELLINGS, ...UNKNOWN])('answers 404 for %s and changes nothing', async (id) => {
    const before = snapshot()
    const res = await call(id)
    expect(res.status).toBe(404)
    expect(snapshot()).toEqual(before)
    expect(h.restart).not.toHaveBeenCalled()
    expect(h.updateConfig).not.toHaveBeenCalled()
    expect(h.sync).not.toHaveBeenCalled()
  })

  it.each(MALFORMED)('answers 400 for %s and changes nothing', async (id) => {
    const before = snapshot()
    const res = await call(id)
    expect(res.status).toBe(400)
    expect(snapshot()).toEqual(before)
    expect(h.restart).not.toHaveBeenCalled()
  })

  it('still works for the listed id', async () => {
    const before = snapshot()
    const res = await call('h_foo_bar')
    expect(res.status).toBe(200)
    expect(snapshot()).not.toEqual(before)
  })
})

describe('DELETE pairing', () => {
  it('refuses a platform that is not one of the surfaces, and changes nothing', async () => {
    // A file the platform name would otherwise be joined into a path to.
    fs.writeFileSync(path.join(agentDir(), 'other-approved.json'), PAIRING)
    const before = snapshot()
    for (const platform of ['../../other', 'telegram/../telegram', 'nope', '']) {
      const res = await deletePairing(json('DELETE', { platform, userId: '111' }), params('h_foo_bar'))
      expect(res.status, platform).toBe(400)
      expect(snapshot(), platform).toEqual(before)
    }
  })
})

describe('reads', () => {
  it.each(MALFORMED)('GET settings and GET pairing answer 400 for %s', async (id) => {
    expect((await getSettings(new Request('http://x'), params(id))).status).toBe(400)
    expect((await getPairing(new Request('http://x'), params(id))).status).toBe(400)
  })

  it('GET harness answers 404 for an id that is not listed and returns the listed one', async () => {
    for (const id of [...OTHER_SPELLINGS, ...UNKNOWN]) {
      expect((await getHarness(new Request('http://x'), params(id))).status, id).toBe(404)
    }
    const res = await getHarness(new Request('http://x'), params('h_foo_bar'))
    expect(await res.json()).toEqual({ id: 'h_foo_bar', name: 'foo-bar' })
  })

  it('GET pairing still lists the approved users of the listed agent', async () => {
    const res = await getPairing(new Request('http://x'), params('h_foo_bar'))
    expect((await res.json()).users).toHaveLength(1)
  })
})
