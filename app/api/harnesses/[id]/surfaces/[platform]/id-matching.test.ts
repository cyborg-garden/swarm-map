// @vitest-environment node
/**
 * The four surface-policy routes, run against the REAL SurfaceAdminService
 * (the sibling route.test.ts files mock it, so they cannot see how an id is
 * matched to an agent).
 *
 *   GET  /api/harnesses/:id/surfaces/:platform/admins
 *   PUT  /api/harnesses/:id/surfaces/:platform/admins
 *   GET  /api/harnesses/:id/surfaces/:platform/admins/:userId
 *   GET  /api/harnesses/:id/surfaces/:platform/groups/:groupId
 *   POST /api/harnesses/:id/surfaces/:platform/groups/:groupId
 *
 * `:id` names an agent by its stored id or its bare slug, and by nothing else.
 * For every other id: reads answer as for an agent with no admins and no
 * groups, writes are refused, and nothing on disk changes. For the two real
 * spellings, the admin check comes before any write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const holder = vi.hoisted(() => ({ svc: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: holder.svc }))

import { GET as getAdmins, PUT as putAdmins } from './admins/route'
import { GET as getIsAdmin } from './admins/[userId]/route'
import { GET as getGroup, POST as postGroup } from './groups/[groupId]/route'
import { SurfaceAdminService } from '@/lib/services/surface-admins'
import { Storage } from '@/lib/services/storage'

const OWNER = '111111111111111111'
const OTHER = '222222222222222222'
const ENV = [
  'DISCORD_BOT_TOKEN=x',
  `DISCORD_ALLOWED_USERS=${OWNER},${OTHER}`,
  `DISCORD_DM_ALLOWED_USERS=${OWNER}`,
  'DISCORD_ALLOWED_CHANNELS=c1',
  '',
].join('\n')
const ROWS = [{ id: 'h_foo_bar', name: 'foo-bar', surfaceAdmins: { discord: [OWNER] } }]

// The two spellings that name the agent, and ids that do not. SAME_DIR ids map
// to the agent's own data dir under the data-dir convention (the upper-case
// ones on a case-insensitive filesystem).
const AGENT_IDS = ['h_foo_bar', 'foo-bar']
const SAME_DIR = ['h_foo-bar', 'h_FOO_BAR', 'FOO-BAR']
const OTHER_IDS = [...SAME_DIR, 'h_h_foo_bar', 'h_nobody', 'x%2F..']

let home: string
let dataDir: string
let storage: Storage
let restart: ReturnType<typeof vi.fn>
let updateConfig: ReturnType<typeof vi.fn>
let auditAppend: ReturnType<typeof vi.fn>

const envPath = () => path.join(home, '.hermes-foo-bar', '.env')
const rows = () => storage.read<unknown[]>('harnesses.json', [])
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
const json = (method: string, body: unknown) =>
  new Request('http://x', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function expectNothingChanged(label: string) {
  expect(rows(), label).toEqual(ROWS)
  expect(fs.readFileSync(envPath(), 'utf-8'), label).toBe(ENV)
  expect(fs.readdirSync(home), label).toEqual(['.hermes-foo-bar'])
  expect(restart, label).not.toHaveBeenCalled()
  expect(updateConfig, label).not.toHaveBeenCalled()
  expect(auditAppend, label).not.toHaveBeenCalled()
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-route-home-'))
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-route-data-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  fs.mkdirSync(path.dirname(envPath()), { recursive: true })
  fs.writeFileSync(envPath(), ENV)
  storage = new Storage(dataDir)
  storage.write('harnesses.json', ROWS)

  restart = vi.fn()
  updateConfig = vi.fn()
  auditAppend = vi.fn()
  // The harness directory lists the one stored agent and nothing else.
  const harness = {
    get: (id: string) => (id === 'h_foo_bar' ? { id } : undefined),
    updateConfig,
    restart,
  }
  holder.svc.harness = harness
  holder.svc.surfaceAdmins = new SurfaceAdminService(storage, { append: auditAppend } as never, harness as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('GET admins', () => {
  it.each(AGENT_IDS)('returns the stored list for %s', async (id) => {
    const res = await getAdmins(new Request('http://x'), params({ id, platform: 'discord' }))
    expect(await res.json()).toEqual({ platform: 'discord', admins: [OWNER], source: 'explicit', allowAllDm: false })
  })

  it.each(OTHER_IDS)('returns no admins for %s', async (id) => {
    const res = await getAdmins(new Request('http://x'), params({ id, platform: 'discord' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ platform: 'discord', admins: [], source: 'allowlist', allowAllDm: false })
    expectNothingChanged(id)
  })
})

describe('GET is-admin', () => {
  it.each(AGENT_IDS)('answers from the stored list for %s', async (id) => {
    const yes = await getIsAdmin(new Request('http://x'), params({ id, platform: 'discord', userId: OWNER }))
    expect(await yes.json()).toEqual({ is_admin: true })
    const no = await getIsAdmin(new Request('http://x'), params({ id, platform: 'discord', userId: OTHER }))
    expect(await no.json()).toEqual({ is_admin: false })
  })

  it.each(OTHER_IDS)('is false for everyone under %s', async (id) => {
    for (const userId of [OWNER, OTHER]) {
      const res = await getIsAdmin(new Request('http://x'), params({ id, platform: 'discord', userId }))
      expect(res.status).toBe(200)
      expect(await res.json(), userId).toEqual({ is_admin: false })
    }
    expectNothingChanged(id)
  })
})

describe('PUT admins', () => {
  it.each(OTHER_IDS)('refuses %s and changes nothing', async (id) => {
    for (const actor of [OTHER, OWNER]) {
      const res = await putAdmins(json('PUT', { admins: [OTHER], actor }), params({ id, platform: 'discord' }))
      // 404 for an id that resolves to no agent; an id with no stored row is
      // turned away at the admin check (403) before the directory is asked.
      expect(res.status, actor).toBe(SAME_DIR.includes(id) || id.includes('%') ? 404 : 403)
      expectNothingChanged(`${id} as ${actor}`)
    }
  })

  it.each(AGENT_IDS)('refuses a caller outside the stored list under %s, before any write', async (id) => {
    const res = await putAdmins(json('PUT', { admins: [OTHER], actor: OTHER }), params({ id, platform: 'discord' }))
    expect(res.status).toBe(403)
    expectNothingChanged(id)
  })

  it.each(AGENT_IDS)('refuses a missing actor under %s, before any write', async (id) => {
    const res = await putAdmins(json('PUT', { admins: [OTHER] }), params({ id, platform: 'discord' }))
    expect(res.status).toBe(400)
    expectNothingChanged(id)
  })

  it.each(AGENT_IDS)('refuses a malformed list from an admin under %s, before any write', async (id) => {
    const res = await putAdmins(json('PUT', { admins: [OTHER, 'nope'], actor: OWNER }), params({ id, platform: 'discord' }))
    expect(res.status).toBe(400)
    expectNothingChanged(id)
  })

  it.each(AGENT_IDS)('lets a stored admin update the one stored row under %s', async (id) => {
    const res = await putAdmins(json('PUT', { admins: [OWNER, OTHER], actor: OWNER }), params({ id, platform: 'discord' }))
    expect(res.status).toBe(200)
    expect(rows()).toEqual([{ ...ROWS[0], surfaceAdmins: { discord: [OWNER, OTHER] } }])
    expect(fs.readFileSync(envPath(), 'utf-8')).toContain(`DISCORD_DM_ALLOWED_USERS=${OWNER},${OTHER}\n`)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith('h_foo_bar', 'recreate')
    expect(fs.readdirSync(home)).toEqual(['.hermes-foo-bar'])
  })
})

describe('GET is-group-allowed', () => {
  it.each(AGENT_IDS)('answers from the agent .env for %s', async (id) => {
    const yes = await getGroup(new Request('http://x'), params({ id, platform: 'discord', groupId: 'c1' }))
    expect(await yes.json()).toEqual({ allowed: true })
    const no = await getGroup(new Request('http://x'), params({ id, platform: 'discord', groupId: 'c9' }))
    expect(await no.json()).toEqual({ allowed: false })
  })

  it.each(OTHER_IDS)('is false under %s', async (id) => {
    const res = await getGroup(new Request('http://x'), params({ id, platform: 'discord', groupId: 'c1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: false })
    expectNothingChanged(id)
  })
})

describe('POST group invite', () => {
  it.each(OTHER_IDS)('refuses %s and changes nothing', async (id) => {
    for (const addedByUserId of [OTHER, OWNER]) {
      const res = await postGroup(json('POST', { addedByUserId }), params({ id, platform: 'discord', groupId: 'c2' }))
      expect([400, 404], addedByUserId).toContain(res.status)
      expect((await res.json()).approved, addedByUserId).toBeUndefined()
      expectNothingChanged(`${id} as ${addedByUserId}`)
    }
  })

  it('refuses a directory the app lists no agent for, and leaves its .env alone', async () => {
    const leftover = path.join(home, '.hermes-leftover')
    const env = `DISCORD_ALLOWED_USERS=${OWNER}\n`
    fs.mkdirSync(leftover)
    fs.writeFileSync(path.join(leftover, '.env'), env)
    for (const id of ['h_leftover', 'leftover']) {
      const res = await postGroup(json('POST', { addedByUserId: OWNER }), params({ id, platform: 'discord', groupId: 'c2' }))
      expect(res.status, id).toBe(404)
    }
    expect(fs.readFileSync(path.join(leftover, '.env'), 'utf-8')).toBe(env)
    expect(fs.readFileSync(envPath(), 'utf-8')).toBe(ENV)
    expect(restart).not.toHaveBeenCalled()
    expect(auditAppend).not.toHaveBeenCalled()
  })

  it.each(AGENT_IDS)('does not approve for someone outside the stored list under %s, and writes nothing', async (id) => {
    const res = await postGroup(json('POST', { addedByUserId: OTHER }), params({ id, platform: 'discord', groupId: 'c2' }))
    expect(res.status).toBe(200)
    expect((await res.json()).approved).toBe(false)
    expectNothingChanged(id)
  })

  it.each(AGENT_IDS)('approves for a stored admin under %s and recreates the stored agent', async (id) => {
    const res = await postGroup(json('POST', { addedByUserId: OWNER }), params({ id, platform: 'discord', groupId: 'c2' }))
    expect(await res.json()).toEqual({ approved: true, restarted: true })
    expect(fs.readFileSync(envPath(), 'utf-8')).toContain('DISCORD_ALLOWED_CHANNELS=c1,c2\n')
    expect(rows()).toEqual(ROWS)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith('h_foo_bar', 'recreate')
  })
})
