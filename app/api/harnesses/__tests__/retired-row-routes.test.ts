// @vitest-environment node
/**
 * A row Swarm Map does not manage (retired or unknown runtime) cannot be
 * changed through ANY per-agent route.
 *
 * HarnessService keeps such a row out of list()/get(), which covers the routes
 * that look the agent up first. Many routes never do: they turn the id in the
 * URL straight into `~/.hermes-<name>` and write there. For a retired `h_old`
 * row that is the data directory of a Hermes agent called "old" (or of
 * nothing Swarm Map made), so those routes were editing a Hermes agent's
 * .env and config.yaml through a row that is not Hermes.
 *
 * This test does not list the routes by hand. It walks
 * app/api/harnesses/[id]/ and calls every exported POST, PUT, PATCH and
 * DELETE handler it finds, against the real services on a scratch home. A
 * route added later is covered the day it lands.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path')
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'swarm-retired-routes-'))
  const home = nodePath.join(root, 'home')
  const data = nodePath.join(root, 'data')
  nodeFs.mkdirSync(home)
  nodeFs.mkdirSync(data)
  // lib/services reads DATA_DIR once, at import.
  process.env.DATA_DIR = data
  process.env.HOME = home
  return { root, home, data }
})

vi.mock('@/lib/services/docker')

const ROUTES_DIR = path.resolve(__dirname, '../[id]')
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return routeFiles(full)
    return e.name === 'route.ts' ? [full] : []
  })
}

/** Every file under the scratch dir, with a hash of its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else out[path.relative(scratch.root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(scratch.root)
  return out
}

const A = '123456789012345678'
// An admin id that exists ONLY in the unmanaged rows, never in an agent's .env.
const ROW_ADMIN = '999999999999999999'
const ENV = [
  'API_SERVER_KEY=k',
  'OPENROUTER_API_KEY=sk-or-test',
  'DISCORD_BOT_TOKEN=t',
  `DISCORD_ALLOWED_USERS=${A}`,
  `DISCORD_DM_ALLOWED_USERS=${A}`,
  'TELEGRAM_BOT_TOKEN=1:t',
  'TELEGRAM_ALLOWED_USERS=111',
  'TELEGRAM_GROUP_ALLOWED_CHATS=-1001',
  'TELEGRAM_GROUP_INVITE_POLICY=allow-all',
  '',
].join('\n')
const CONFIG = 'model:\n  default: x\nplatforms:\n  discord:\n    enabled: true\n  telegram:\n    enabled: true\n'

// The rows under test, and the Hermes data dir each id resolves to.
const LEFTOVER_AGENT = 'h_letta_agent-0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9'
// The server id gets no directory: a leftover-shaped row for it beside a real
// ~/.hermes-letta-server is that Hermes agent's row (see retiredRuntimeOfRow).
const CASES: Array<{ id: string; row: Record<string, unknown>; dir: string | null }> = [
  { id: 'h_old', row: { id: 'h_old', name: 'old', runtime: 'letta', surfaceAdmins: { discord: [ROW_ADMIN] } }, dir: '.hermes-old' },
  { id: 'h_odd', row: { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future', surfaceAdmins: { discord: [ROW_ADMIN] } }, dir: '.hermes-odd' },
  { id: 'h_letta_server', row: { id: 'h_letta_server', surfaceAdmins: { discord: [ROW_ADMIN] } }, dir: null },
  { id: LEFTOVER_AGENT, row: { id: LEFTOVER_AGENT, surfaceAdmins: { discord: [ROW_ADMIN] } }, dir: '.hermes-' + LEFTOVER_AGENT.replace(/^h_/, '').replace(/_/g, '-') },
]

function seed(rows: Array<Record<string, unknown>>) {
  for (const d of [scratch.home, scratch.data]) {
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d)
  }
  fs.writeFileSync(path.join(scratch.data, 'harnesses.json'), JSON.stringify(rows))
  for (const c of CASES) {
    if (!c.dir) continue
    const dir = path.join(scratch.home, c.dir)
    fs.mkdirSync(path.join(dir, 'platforms', 'pairing'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), ENV)
    fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG)
    fs.writeFileSync(path.join(dir, 'SOUL.md'), 'not yours to change')
    fs.writeFileSync(path.join(dir, 'platforms', 'pairing', 'discord-approved.json'), JSON.stringify({ [A]: { user_name: 'a', approved_at: 1 } }))
  }
}

// One body that gets past the "missing field" checks of the routes that write
// straight to ~/.hermes-<name>, so a missing guard shows up as a changed file
// and not as a 400.
const BODY = {
  platform: 'discord',
  credentials: { DISCORD_BOT_TOKEN: 'new-token', DISCORD_ALLOWED_USERS: A },
  token: 'new-token',
  action: 'add-group',
  group: '-1002',
  groupId: '-1002',
  userId: A,
  addedByUserId: '111',
  admins: [A, '223456789012345678'],
  actor: A,
  tier: 'public',
  level: 'all',
  values: {},
  tools: [],
  name: 'copy',
}

function call(handler: Handler, method: string, file: string, id: string, platform = 'discord', query = ''): Promise<Response> {
  const rel = path.relative(ROUTES_DIR, path.dirname(file))
  const url = `http://localhost:3000/api/harnesses/${id}/${rel}?${query ? `${query.slice(1)}&` : ''}deleteFiles=true&platform=discord&userId=${A}&chatId=-1001`
  const init: RequestInit =
    method === 'GET' ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }
  return handler(new Request(url, init), {
    params: Promise.resolve({ id, platform, groupId: '-1002', userId: A }),
  })
}

const files = routeFiles(ROUTES_DIR)
const handlers: Array<{ label: string; file: string; method: string; handler: Handler }> = []
const readers: typeof handlers = []

// The four endpoints a running agent calls about ITSELF, by its bare slug:
// "is this group allowed", "is this user my admin". They answer from the
// agent's own .env and never from the unmanaged row. Every other GET is a
// dashboard read of one agent and is refused like a write.
const SELF_READS = [
  'GET policy/route.ts',
  'GET surfaces/[platform]/admins/route.ts',
  'GET surfaces/[platform]/admins/[userId]/route.ts',
  'GET surfaces/[platform]/groups/[groupId]/route.ts',
]

beforeAll(async () => {
  vi.spyOn(os, 'homedir').mockReturnValue(scratch.home)
  for (const file of files) {
    const mod = (await import(file)) as Record<string, unknown>
    for (const method of MUTATING) {
      if (typeof mod[method] === 'function') {
        handlers.push({ label: `${method} ${path.relative(ROUTES_DIR, file)}`, file, method, handler: mod[method] as Handler })
      }
    }
    if (typeof mod.GET === 'function') {
      readers.push({ label: `GET ${path.relative(ROUTES_DIR, file)}`, file, method: 'GET', handler: mod.GET as Handler })
    }
  }
})

afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(scratch.root, { recursive: true, force: true })
})

describe('the sweep can see the routes (a sweep over nothing passes everything)', () => {
  it('finds the per-agent routes, including the ones that write ~/.hermes-<name> directly', () => {
    const labels = handlers.map((h) => h.label)
    expect(labels.length).toBeGreaterThanOrEqual(25)
    for (const must of [
      'POST surfaces/connect/route.ts',
      'POST surfaces/disconnect/route.ts',
      'POST policy/route.ts',
      'DELETE pairing/route.ts',
      'PUT surfaces/[platform]/admins/route.ts',
      'POST surfaces/[platform]/groups/[groupId]/route.ts',
      'PUT settings/route.ts',
      'POST start/route.ts',
      'DELETE route.ts',
    ]) {
      expect(labels, must).toContain(must)
    }
  })

  it('finds the per-agent GET routes, including every self-read', () => {
    const labels = readers.map((h) => h.label)
    expect(labels.length).toBeGreaterThanOrEqual(19)
    for (const must of [...SELF_READS, 'GET settings/route.ts', 'GET pairing/route.ts', 'GET usage/route.ts', 'GET route.ts']) {
      expect(labels, must).toContain(must)
    }
  })
})

describe.each(CASES)('row $id, which Swarm Map does not manage', ({ id, row, dir }) => {
  beforeEach(() => seed([row, { id: 'h_iris', name: 'iris', runtime: 'hermes' }]))

  it('every mutating per-agent route answers 409 and changes nothing on disk', async () => {
    const wrong: string[] = []
    for (const h of handlers) {
      // The one thing that works on such a row: forget it.
      if (h.label === 'DELETE route.ts') continue
      const before = snapshot()
      let status: number | string
      try {
        status = (await call(h.handler, h.method, h.file, id)).status
      } catch (err) {
        status = `threw ${err instanceof Error ? err.message : String(err)}`
      }
      const after = snapshot()
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f])
      if (status !== 409 || changed.length) {
        wrong.push(`${h.label}: status ${status}${changed.length ? `, changed ${changed.join(', ')}` : ''}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('every per-agent GET is refused too, and none of them writes', async () => {
    const wrong: string[] = []
    for (const h of readers) {
      if (SELF_READS.includes(h.label)) continue
      const before = snapshot()
      let status: number | string
      try {
        status = (await call(h.handler, 'GET', h.file, id)).status
      } catch (err) {
        status = `threw ${err instanceof Error ? err.message : String(err)}`
      }
      const after = snapshot()
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f])
      // GET /api/harnesses/:id is the lookup itself: the row is not an agent, so 404.
      const want = h.label === 'GET route.ts' ? 404 : 409
      if (status !== want || changed.length) {
        wrong.push(`${h.label}: status ${status}, wanted ${want}${changed.length ? `, changed ${changed.join(', ')}` : ''}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('the self-reads answer without serving the row and without writing', async () => {
    for (const h of readers.filter((r) => SELF_READS.includes(r.label))) {
      const before = snapshot()
      const res = await call(h.handler, 'GET', h.file, id)
      const text = await res.text()
      expect(text, h.label).not.toContain(ROW_ADMIN)
      // Answered, not refused: the agent plugin reads these on every message
      // and takes anything but 200 as "no". With no agent home on disk the
      // group check has nothing to read and says 404, as it always did.
      if (dir) expect(res.status, h.label).toBe(200)
      else expect([200, 404], h.label).toContain(res.status)
      expect(snapshot(), h.label).toEqual(before)
    }
  })

  it('the self-reads answer from the agent\'s own .env', async () => {
    if (!dir) return // nothing on disk to answer from; covered by the status check above
    const admins = readers.find((r) => r.label === 'GET surfaces/[platform]/admins/route.ts')!
    expect(await (await call(admins.handler, 'GET', admins.file, id)).json()).toMatchObject({ admins: [A], source: 'allowlist' })
    const isAdmin = readers.find((r) => r.label === 'GET surfaces/[platform]/admins/[userId]/route.ts')!
    expect(await (await call(isAdmin.handler, 'GET', isAdmin.file, id)).json()).toEqual({ is_admin: true })
    const group = readers.find((r) => r.label === 'GET policy/route.ts')!
    expect(await (await call(group.handler, 'GET', group.file, id, 'telegram', '&platform=telegram')).json()).toEqual({ allowed: true })
  })

  it('other spellings of the same id are refused the same way', async () => {
    // Each of these builds the same directory as the stored id.
    const name = id.replace(/^h_/, '').replace(/_/g, '-')
    const spellings = [`h_${name}`, name.toUpperCase(), `h_${name.toUpperCase()}`, name.replace(/-/g, '_')]
    const write = handlers.find((h) => h.label === 'POST surfaces/disconnect/route.ts')!
    const read = readers.find((h) => h.label === 'GET settings/route.ts')!
    for (const spelling of spellings) {
      const before = snapshot()
      expect((await call(write.handler, 'POST', write.file, spelling)).status, `POST ${spelling}`).toBe(409)
      expect((await call(read.handler, 'GET', read.file, spelling)).status, `GET ${spelling}`).toBe(409)
      expect(snapshot(), spelling).toEqual(before)
    }
  })

  it('an agent\'s own budget check is answered, not thrown', async () => {
    // GET policy?action=budget-check reads the asking agent's own usage. The
    // usage readers refuse an unmanaged id by default (they throw), so this
    // one call has to say it is a self-read.
    const h = readers.find((r) => r.label === 'GET policy/route.ts')!
    const before = snapshot()
    const res = await call(h.handler, 'GET', h.file, id, 'discord', '&action=budget-check')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ exceeded: false })
    expect(snapshot()).toEqual(before)
  })

  it('the bare agent slug (what an agent container sends) is refused the same way', async () => {
    const slug = id.replace(/^h_/, '').replace(/_/g, '-')
    // Only ids a slug maps back to. The old agent ids keep a hyphen and have no slug form.
    if (`h_${slug.replace(/-/g, '_')}` !== id) return
    const invite = handlers.find((h) => h.label === 'POST surfaces/[platform]/groups/[groupId]/route.ts')!
    const before = snapshot()
    expect((await call(invite.handler, 'POST', invite.file, slug)).status).toBe(409)
    expect(snapshot()).toEqual(before)
  })

  it('DELETE forgets the row and leaves every agent file alone, even with deleteFiles', async () => {
    const del = handlers.find((h) => h.label === 'DELETE route.ts')!
    const before = snapshot()
    const res = await call(del.handler, 'DELETE', del.file, id)
    expect(res.status).toBe(200)
    const after = snapshot()
    const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f])
    expect(changed.filter((f) => !f.startsWith('data' + path.sep))).toEqual([])
    const rows = JSON.parse(fs.readFileSync(path.join(scratch.data, 'harnesses.json'), 'utf-8')) as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['h_iris'])
  })
})

// The other direction. The refusal is for rows Swarm Map does not manage and
// for nothing else: a Hermes agent must never be answered with it, whatever
// its stored row looks like and whatever unmanaged rows sit beside it.
describe('a Hermes agent is never refused as unmanaged', () => {
  // Every row shape a Hermes agent "old" can have in harnesses.json.
  const HERMES_SHAPES: Array<[string, Array<Record<string, unknown>>]> = [
    ['a tagged row', [{ id: 'h_old', name: 'old', runtime: 'hermes' }]],
    ['a row older than the tag', [{ id: 'h_old', name: 'old', tier: 'team' }]],
    ['a row with a null tag', [{ id: 'h_old', name: 'old', runtime: null }]],
    ['only the row the admins write made', [{ id: 'h_old', surfaceAdmins: { discord: [A] } }]],
    ['no stored row at all (discovered only)', []],
  ]
  // Unmanaged rows for OTHER agents, stored beside it. Their names share a
  // prefix or a suffix with "old" on purpose.
  const NEIGHBOURS = [
    { id: 'h_older', name: 'older', runtime: 'letta' },
    { id: 'h_ol', name: 'ol', runtime: 'letta' },
    { id: 'h_very_old', name: 'very-old', runtime: 'pi-from-the-future' },
    { id: 'h_letta_server', surfaceAdmins: { discord: [ROW_ADMIN] } },
    { id: LEFTOVER_AGENT, surfaceAdmins: { discord: [ROW_ADMIN] } },
  ]

  const refusedAsUnmanaged = async (h: (typeof handlers)[number], id: string): Promise<boolean> => {
    let res: Response
    try {
      res = await call(h.handler, h.method, h.file, id)
    } catch {
      return false // a route failing for its own reasons is not this refusal
    }
    const body = (await res.json().catch(() => null)) as { reason?: string } | null
    return res.status === 409 && (body?.reason === 'retired' || body?.reason === 'unknown')
  }

  it.each(HERMES_SHAPES)('%s: no per-agent route, read or write, by id or by slug', async (_label, rows) => {
    const refused: string[] = []
    for (const h of [...handlers, ...readers]) {
      if (h.label === 'DELETE route.ts') continue // would forget the row under test
      for (const id of ['h_old', 'old']) {
        seed([...rows, ...NEIGHBOURS])
        if (await refusedAsUnmanaged(h, id)) refused.push(`${h.label} as ${id}`)
      }
    }
    expect(refused).toEqual([])
  })

  it('an admins-only row under an ordinary id is Hermes even with no home on disk', async () => {
    // Only the two ids the old integration minted are judged by that shape.
    const refused: string[] = []
    for (const h of [...handlers, ...readers]) {
      if (h.label === 'DELETE route.ts') continue
      seed([{ id: 'h_ghost', surfaceAdmins: { discord: [A] } }, ...NEIGHBOURS])
      expect(fs.existsSync(path.join(scratch.home, '.hermes-ghost'))).toBe(false)
      if (await refusedAsUnmanaged(h, 'h_ghost')) refused.push(h.label)
    }
    expect(refused).toEqual([])
  })

  it('control: the same sweep does report a row that IS unmanaged', async () => {
    seed([{ id: 'h_old', name: 'old', runtime: 'letta' }])
    const h = handlers.find((x) => x.label === 'POST surfaces/disconnect/route.ts')!
    expect(await refusedAsUnmanaged(h, 'h_old')).toBe(true)
    expect(await refusedAsUnmanaged(h, 'old')).toBe(true)
  })
})

describe('control: the same GETs on a Hermes row are answered', () => {
  // Proves the GET sweep can fail, and that a self-read CAN serve a row's admins.
  beforeEach(() => seed([{ id: 'h_old', name: 'old', runtime: 'hermes', surfaceAdmins: { discord: [ROW_ADMIN] } }]))

  it.each(['GET settings/route.ts', 'GET pairing/route.ts', 'GET usage/route.ts'])('%s is not 409', async (label) => {
    const h = readers.find((x) => x.label === label)!
    expect((await call(h.handler, 'GET', h.file, 'h_old')).status).not.toBe(409)
  })

  it('GET admins serves the stored admins of a Hermes row', async () => {
    const h = readers.find((x) => x.label === 'GET surfaces/[platform]/admins/route.ts')!
    expect(await (await call(h.handler, 'GET', h.file, 'h_old')).text()).toContain(ROW_ADMIN)
  })
})

describe('control: the same calls on a Hermes row are not refused', () => {
  // Proves the sweep can fail: without the guard this is what a retired row got.
  beforeEach(() => seed([{ id: 'h_old', name: 'old', runtime: 'hermes', surfaceAdmins: { discord: [A] } }]))

  it.each([
    ['POST surfaces/disconnect/route.ts', '.env', 'discord'],
    ['PUT surfaces/[platform]/admins/route.ts', path.join('..', '..', 'data', 'harnesses.json'), 'discord'],
    ['POST surfaces/[platform]/groups/[groupId]/route.ts', '.env', 'telegram'],
  ])('%s writes %s', async (label, changedFile, platform) => {
    const h = handlers.find((x) => x.label === label)!
    const target = path.join(scratch.home, '.hermes-old', changedFile)
    const before = fs.readFileSync(target, 'utf-8')
    const res = await call(h.handler, h.method, h.file, 'h_old', platform)
    expect(res.status).not.toBe(409)
    expect(fs.readFileSync(target, 'utf-8')).not.toBe(before)
  })
})
