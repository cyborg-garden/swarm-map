// @vitest-environment node
/**
 * A stored row whose `runtime` tag Swarm Map does not know is read-only:
 * every write and lifecycle request for its id is refused, and the one thing
 * that works is forgetting the row.
 *
 * The rule lives in one place, the request gate in proxy.ts, which every
 * `/api` request passes through before it reaches a route. This test does
 * not list the routes by hand. It walks app/api/harnesses/[id]/, finds every
 * exported POST, PUT, PATCH and DELETE handler, and sends a request for each
 * through the gate. A route added later is covered the day it lands.
 *
 * Only the tag decides. A row with no tag, or a null one, is Hermes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'

const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path')
  const data = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'swarm-unknown-runtime-'))
  // lib/services/data-dir reads DATA_DIR once, at import.
  process.env.DATA_DIR = data
  return { data }
})

import { proxy, config } from '@/proxy'
import { SESSION_COOKIE, computeSessionValue } from '@/lib/auth/session'

const TOKEN = 'operator-token-for-this-test'
const ROUTES_DIR = path.resolve(__dirname, '../[id]')
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
let cookie = ''

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return routeFiles(full)
    return e.name === 'route.ts' ? [full] : []
  })
}

/** Every (method, path under the agent) a route file under [id]/ answers. */
const endpoints: Array<{ method: string; rel: string }> = []

const urlFor = (id: string, rel: string) =>
  `/api/harnesses/${id}${rel ? `/${rel}` : ''}`
    .replace('[platform]', 'discord')
    .replace('[groupId]', '-1002')
    .replace('[userId]', '123456789012345678')

function send(method: string, id: string, rel: string, withCookie = true): Promise<Response> {
  const headers = new Headers()
  if (withCookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`)
  return proxy(new NextRequest(new URL(`http://localhost:3000${urlFor(id, rel)}`), { method, headers }))
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1'
const store = (rows: unknown) => fs.writeFileSync(path.join(scratch.data, 'harnesses.json'), JSON.stringify(rows))

beforeAll(async () => {
  process.env.HSM_OPERATOR_TOKEN = TOKEN
  cookie = await computeSessionValue(TOKEN)
  for (const file of routeFiles(ROUTES_DIR)) {
    const src = fs.readFileSync(file, 'utf-8')
    const rel = path.relative(ROUTES_DIR, path.dirname(file))
    for (const method of [...MUTATING, 'GET']) {
      if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(src)) endpoints.push({ method, rel })
    }
  }
})

afterAll(() => {
  delete process.env.HSM_OPERATOR_TOKEN
  fs.rmSync(scratch.data, { recursive: true, force: true })
})

const writes = () => endpoints.filter((e) => e.method !== 'GET')
const label = (e: { method: string; rel: string }) => `${e.method} ${e.rel || '(the agent itself)'}`

describe('the sweep can see the routes (a sweep over nothing passes everything)', () => {
  it('finds the per-agent write routes', () => {
    const labels = writes().map(label)
    expect(labels.length).toBeGreaterThanOrEqual(25)
    for (const must of [
      'POST start',
      'POST stop',
      'POST restart',
      'POST duplicate',
      'PUT settings',
      'PATCH tier',
      'POST surfaces/connect',
      'POST surfaces/disconnect',
      'POST policy',
      'DELETE pairing',
      'PUT surfaces/[platform]/admins',
      'POST surfaces/[platform]/groups/[groupId]',
      'DELETE (the agent itself)',
    ]) {
      expect(labels, must).toContain(must)
    }
  })

  it('every /api request goes through the gate', () => {
    expect(config.matcher).toBe('/api/:path*')
  })
})

describe.each([
  ['a retired tag', { id: 'h_old', name: 'old', runtime: 'letta' }],
  ['an unknown tag', { id: 'h_old', name: 'old', runtime: 'pi-from-the-future' }],
])('a row with %s', (_label, row) => {
  beforeEach(() => store([row, { id: 'h_iris', name: 'iris', runtime: 'hermes' }]))

  it('every write and lifecycle route is refused with 409, by id and by bare slug', async () => {
    const wrong: string[] = []
    for (const e of writes()) {
      if (e.method === 'DELETE' && e.rel === '') continue // forgetting the row is the one thing that works
      for (const id of ['h_old', 'old']) {
        const res = await send(e.method, id, e.rel)
        const body = (await res.json().catch(() => null)) as { reason?: string; runtime?: string } | null
        if (res.status !== 409 || body?.runtime !== row.runtime || !['retired', 'unknown'].includes(body?.reason ?? '')) {
          wrong.push(`${label(e)} as ${id}: ${res.status} ${JSON.stringify(body)}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('forgetting the row is let through', async () => {
    expect(passed(await send('DELETE', 'h_old', ''))).toBe(true)
  })

  it('reads are let through: the row is shown, not hidden behind an error', async () => {
    for (const e of endpoints.filter((x) => x.method === 'GET')) {
      expect(passed(await send('GET', 'h_old', e.rel)), label(e)).toBe(true)
    }
  })

  it('the one write an agent may send without the operator cookie is refused too', async () => {
    const res = await send('POST', 'old', 'surfaces/[platform]/groups/[groupId]', false)
    expect(res.status).toBe(409)
  })

  it('a request with no session still gets 401, not a hint about the row', async () => {
    expect((await send('POST', 'h_old', 'start', false)).status).toBe(401)
  })

  it('the other agent in the file is not affected', async () => {
    for (const e of writes()) expect(passed(await send(e.method, 'h_iris', e.rel)), label(e)).toBe(true)
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
    ['a row holding only surface admins', [{ id: 'h_old', surfaceAdmins: { discord: ['1'] } }]],
    ["a row whose id looks like the removed integration's", [{ id: 'h_letta_server', surfaceAdmins: { discord: ['1'] } }]],
    ['no stored row at all', []],
  ] as Array<[string, Array<Record<string, unknown>>]>)('%s', async (_label, rows) => {
    store([...rows, ...NEIGHBOURS])
    const id = (rows[0]?.id as string | undefined) ?? 'h_old'
    for (const e of endpoints) {
      for (const spelled of [id, id.replace(/^h_/, '').replace(/_/g, '-')]) {
        const res = await send(e.method, spelled, e.rel)
        expect(res.status, `${label(e)} as ${spelled}`).not.toBe(409)
        expect(passed(res), `${label(e)} as ${spelled}`).toBe(true)
      }
    }
  })

  it('the fleet-wide routes beside [id]/ are not mistaken for an agent', async () => {
    // /api/harnesses/create is not "the agent called create". Each sibling of
    // [id]/ is read from the directory, so a new one is covered when it lands.
    const siblings = fs
      .readdirSync(path.resolve(ROUTES_DIR, '..'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '[id]' && e.name !== '__tests__')
      .map((e) => e.name)
    expect(siblings).toEqual(expect.arrayContaining(['create', 'import', 'restart-running', 'retired']))
    store(siblings.map((name) => ({ id: `h_${name.replace(/-/g, '_')}`, name, runtime: 'letta' })))
    for (const name of siblings) {
      expect(passed(await send('POST', name, '')), `POST /api/harnesses/${name}`).toBe(true)
    }
    // An agent that really has such a name is still reachable by its id.
    expect((await send('POST', 'h_create', 'start')).status).toBe(409)
  })

  it('a harnesses.json that is missing or not a list refuses nothing', async () => {
    fs.rmSync(path.join(scratch.data, 'harnesses.json'), { force: true })
    expect(passed(await send('POST', 'h_old', 'start'))).toBe(true)
    store({ not: 'a list' })
    expect(passed(await send('POST', 'h_old', 'start'))).toBe(true)
  })
})
