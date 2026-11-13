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
const CASES: Array<{ id: string; row: Record<string, unknown>; dir: string }> = [
  { id: 'h_old', row: { id: 'h_old', name: 'old', runtime: 'letta', surfaceAdmins: { discord: [A] } }, dir: '.hermes-old' },
  { id: 'h_odd', row: { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future' }, dir: '.hermes-odd' },
  { id: 'h_letta_server', row: { id: 'h_letta_server', surfaceAdmins: { discord: [A] } }, dir: '.hermes-letta-server' },
  { id: LEFTOVER_AGENT, row: { id: LEFTOVER_AGENT, surfaceAdmins: { discord: [A] } }, dir: '.hermes-' + LEFTOVER_AGENT.replace(/^h_/, '').replace(/_/g, '-') },
]

function seed(rows: Array<Record<string, unknown>>) {
  for (const d of [scratch.home, scratch.data]) {
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d)
  }
  fs.writeFileSync(path.join(scratch.data, 'harnesses.json'), JSON.stringify(rows))
  for (const c of CASES) {
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

function call(handler: Handler, method: string, file: string, id: string, platform = 'discord'): Promise<Response> {
  const rel = path.relative(ROUTES_DIR, path.dirname(file))
  const url = `http://localhost:3000/api/harnesses/${id}/${rel}?deleteFiles=true&platform=discord&userId=${A}`
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) }
  return handler(new Request(url, init), {
    params: Promise.resolve({ id, platform, groupId: '-1002', userId: A }),
  })
}

const files = routeFiles(ROUTES_DIR)
const handlers: Array<{ label: string; file: string; method: string; handler: Handler }> = []

beforeAll(async () => {
  vi.spyOn(os, 'homedir').mockReturnValue(scratch.home)
  for (const file of files) {
    const mod = (await import(file)) as Record<string, unknown>
    for (const method of MUTATING) {
      if (typeof mod[method] === 'function') {
        handlers.push({ label: `${method} ${path.relative(ROUTES_DIR, file)}`, file, method, handler: mod[method] as Handler })
      }
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
})

describe.each(CASES)('row $id, which Swarm Map does not manage', ({ id, row }) => {
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
