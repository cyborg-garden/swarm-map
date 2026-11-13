// @vitest-environment node
/**
 * A stored row whose `runtime` tag Swarm Map does not know is read-only:
 * every write and lifecycle request for its id is refused, and the one thing
 * that works is forgetting the row.
 *
 * The rule lives in the shared id step, lib/harness-ref.ts: requireHarness()
 * answers 409 for the id of such a row, whether the id came from the URL or
 * from a request body, and matches the stored id exactly. The three
 * surfaces/[platform] routes resolve through SurfaceAdminService instead,
 * which treats such a row as no agent. app/api/harness-id-sweep.test.ts walks
 * every route file with the services mocked; this file runs the real
 * HarnessService and SurfaceAdminService over real files in a temp home.
 *
 * Only the tag decides. A row with no tag, or a null one, is Hermes.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@/lib/services/docker')

const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path')
  const data = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'swarm-unknown-runtime-data-'))
  // lib/services/data-dir reads DATA_DIR once, at import.
  process.env.DATA_DIR = data
  return { data }
})

const holder = vi.hoisted(() => ({ svc: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: holder.svc }))

import { requireHarness, refuseUnknownHarnesses } from '@/lib/harness-ref'
import { DELETE as deleteAgent, GET as getAgent } from '../[id]/route'
import { PATCH as patchTier } from '../[id]/tier/route'
import { POST as startAgent } from '../[id]/start/route'
import { GET as getAdmins, PUT as putAdmins } from '../[id]/surfaces/[platform]/admins/route'
import { GET as getIsAdmin } from '../[id]/surfaces/[platform]/admins/[userId]/route'
import { GET as getGroup, POST as postGroup } from '../[id]/surfaces/[platform]/groups/[groupId]/route'
import { HarnessService } from '@/lib/services/harness'
import { SurfaceAdminService } from '@/lib/services/surface-admins'
import { Storage } from '@/lib/services/storage'
import { DockerService } from '@/lib/services/docker'
import { AuditService } from '@/lib/services/audit'
import { ConfigService } from '@/lib/services/config'

const OWNER = '111111111111111111'
const OLD_ENV = `DISCORD_BOT_TOKEN=x\nDISCORD_ALLOWED_USERS=${OWNER}\nDISCORD_GROUP_INVITE_POLICY=allow-all\nDISCORD_ALLOWED_CHANNELS=c1\n`
const IRIS = { id: 'h_iris', name: 'iris', runtime: 'hermes', tier: 'team' }

let home: string
let storage: Storage
let harness: HarnessService
let docker: DockerService

const rows = () => storage.read<Array<Record<string, unknown>>>('harnesses.json', [])
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) })
const json = (method: string, body: unknown, query = '') =>
  new Request(`http://localhost/x${query}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const oldEnv = () => fs.readFileSync(path.join(home, '.hermes-old', '.env'), 'utf-8')

// Everything under the fake home, as "relative/path" → file bytes.
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-unknown-runtime-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  storage = new Storage(scratch.data)
  storage.write('settings.json', { hermesDir: home, dataDir: scratch.data, theme: 'light', composeFiles: [] })

  // What a Hermes agent called "old" would own. If the row is ever treated as
  // Hermes, these are what a write would land in.
  fs.mkdirSync(path.join(home, '.hermes-old'))
  fs.writeFileSync(path.join(home, '.hermes-old', '.env'), OLD_ENV)
  fs.mkdirSync(path.join(home, '.hermes-iris'))
  fs.writeFileSync(path.join(home, '.hermes-iris', '.env'), OLD_ENV)

  docker = new DockerService()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(docker.isAvailable as any).mockReturnValue(false)
  const audit = new AuditService(storage)
  harness = new HarnessService(storage, docker, audit, new ConfigService(storage))
  for (const key of Object.keys(holder.svc)) delete holder.svc[key]
  Object.assign(holder.svc, { harness, audit, surfaceAdmins: new SurfaceAdminService(storage, audit, harness) })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(path.join(scratch.data, 'harnesses.json'), { force: true })
})

afterAll(() => fs.rmSync(scratch.data, { recursive: true, force: true }))

describe.each([
  ['a retired tag', { id: 'h_old', name: 'old', runtime: 'letta' }, 'retired'],
  ['an unknown tag', { id: 'h_old', name: 'old', runtime: 'pi-from-the-future' }, 'unknown'],
])('a row with %s', (_label, row, reason) => {
  let before: Record<string, string>

  beforeEach(() => {
    storage.write('harnesses.json', [row, IRIS])
    before = snapshot()
  })

  it('the shared step answers 409 for its id, with the tag and the reason', async () => {
    const { harness: resolved, refusal } = requireHarness('h_old')
    expect(resolved).toBeUndefined()
    expect(refusal?.status).toBe(409)
    expect(await refusal!.json()).toMatchObject({ reason, runtime: row.runtime, error: expect.stringContaining('Forget the row') })
  })

  it('matches the stored id exactly: no other spelling is the row', () => {
    for (const id of ['old', 'h_Old', 'H_old', 'h_old_', 'h_ol', 'h_h_old']) {
      expect(requireHarness(id).refusal?.status, id).toBe(404)
    }
  })

  it('an id from a request body is refused the same way', async () => {
    const refusal = refuseUnknownHarnesses(['h_iris', 'h_old'])
    expect(refusal?.status).toBe(409)
    expect(await refusal!.json()).toMatchObject({ reason, runtime: row.runtime })
    expect(refuseUnknownHarnesses(['h_iris'])).toBeUndefined()
  })

  it('write and lifecycle routes change nothing', async () => {
    const tier = await patchTier(json('PATCH', { tier: 'public' }), params({ id: 'h_old' }))
    expect(tier.status).toBe(409)
    const start = await startAgent(json('POST', {}), params({ id: 'h_old' }))
    expect(start.status).toBe(409)
    expect(rows()).toEqual([row, IRIS])
    expect(snapshot()).toEqual(before)
  })

  it('the surface policy routes treat it as no agent, by id and by bare slug', async () => {
    for (const id of ['h_old', 'old']) {
      const put = await putAdmins(json('PUT', { admins: [OWNER], actor: OWNER }), params({ id, platform: 'discord' }))
      expect(put.status, id).toBe(404)
      const invite = await postGroup(json('POST', { addedByUserId: OWNER }), params({ id, platform: 'discord', groupId: 'c2' }))
      expect(invite.status, id).toBe(404)
      const admins = await getAdmins(new Request('http://localhost/x'), params({ id, platform: 'discord' }))
      expect((await admins.json()).admins, id).toEqual([])
      const isAdmin = await getIsAdmin(new Request('http://localhost/x'), params({ id, platform: 'discord', userId: OWNER }))
      expect((await isAdmin.json()).is_admin, id).toBe(false)
      const group = await getGroup(new Request('http://localhost/x'), params({ id, platform: 'discord', groupId: 'c1' }))
      expect((await group.json()).allowed, id).toBe(false)
    }
    expect(rows()).toEqual([row, IRIS])
    expect(oldEnv()).toBe(OLD_ENV)
    expect(snapshot()).toEqual(before)
  })

  it('it has no detail to read', async () => {
    expect((await getAgent(new Request('http://localhost/x'), params({ id: 'h_old' }))).status).toBe(409)
  })

  it('forgetting the row works, and touches nothing but the row', async () => {
    const res = await deleteAgent(json('DELETE', {}, '?deleteFiles=true'), params({ id: 'h_old' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ removed: true, stopped: false, filesDeleted: false, volumeRemoved: false })
    expect(rows()).toEqual([IRIS])
    expect(snapshot()).toEqual(before)
  })

  it('the other agent in the file is not affected', async () => {
    expect(requireHarness('h_iris').harness?.id).toBe('h_iris')
    const tier = await patchTier(json('PATCH', { tier: 'public' }), params({ id: 'h_iris' }))
    expect(tier.status).toBe(200)
    expect(rows()).toEqual([row, { ...IRIS, tier: 'public' }])
    const invite = await postGroup(json('POST', { addedByUserId: OWNER }), params({ id: 'iris', platform: 'discord', groupId: 'c2' }))
    expect(await invite.json()).toMatchObject({ approved: true })
  })
})

describe('a Hermes agent is never refused this way', () => {
  // Every shape a Hermes agent's stored row can have, beside rows for other
  // ids that do carry an unknown tag and have look-alike names.
  const NEIGHBOURS = [
    { id: 'h_older', name: 'older', runtime: 'letta' },
    { id: 'h_ol', name: 'ol', runtime: 'pi-from-the-future' },
    { id: 'h_very_old', name: 'very-old', runtime: 'letta' },
  ]
  it.each([
    ['a tagged row', [{ id: 'h_old', name: 'old', runtime: 'hermes' }]],
    ['a row with no tag', [{ id: 'h_old', name: 'old', tier: 'team' }]],
    ['a row with a null tag', [{ id: 'h_old', name: 'old', runtime: null }]],
    ['a row holding only surface admins', [{ id: 'h_old', surfaceAdmins: { discord: [OWNER] } }]],
    ["a row whose id looks like the removed integration's", [{ id: 'h_letta_server', surfaceAdmins: { discord: [OWNER] } }]],
  ] as Array<[string, Array<Record<string, unknown>>]>)('%s', async (_label, stored) => {
    storage.write('harnesses.json', [...stored, ...NEIGHBOURS])
    const id = stored[0].id as string
    expect(requireHarness(id).harness?.id).toBe(id)
    expect(refuseUnknownHarnesses([id])).toBeUndefined()
    const slug = id.replace(/^h_/, '').replace(/_/g, '-')
    fs.mkdirSync(path.join(home, `.hermes-${slug}`), { recursive: true })
    fs.writeFileSync(path.join(home, `.hermes-${slug}`, '.env'), OLD_ENV)
    for (const spelled of [id, slug]) {
      const isAdmin = await getIsAdmin(new Request('http://localhost/x'), params({ id: spelled, platform: 'discord', userId: OWNER }))
      expect((await isAdmin.json()).is_admin, spelled).toBe(true)
    }
  })

  it('an id with no stored row at all is unknown, not unmanaged', () => {
    storage.write('harnesses.json', NEIGHBOURS)
    expect(requireHarness('h_old').refusal?.status).toBe(404)
  })

  it('a harnesses.json that is missing names no unmanaged row', () => {
    fs.rmSync(path.join(scratch.data, 'harnesses.json'), { force: true })
    expect(requireHarness('h_old').refusal?.status).toBe(404)
    expect(refuseUnknownHarnesses(['h_old'])?.status).toBe(404)
  })
})
