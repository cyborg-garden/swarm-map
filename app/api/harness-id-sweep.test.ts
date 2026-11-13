// @vitest-environment node
/// <reference types="vite/client" />
/**
 * Route sweep: every API route that takes an agent id resolves it through the
 * shared step in lib/harness-ref.ts before it does anything else.
 *
 * The sweep enumerates every app/api route file. Each one must be classified:
 *
 *   - under harnesses/[id]/  → the id is a URL segment (found automatically);
 *   - BODY_ID                → the id arrives in the request body;
 *   - NEW_NAME               → the route creates an agent from a name (covered
 *                              by a dedicated test, which must exist);
 *   - NO_AGENT_ID            → the route takes no agent id.
 *
 * A route file in none of these fails the sweep, so a new route cannot be
 * added without deciding which it is.
 *
 * What is checked, with every service mocked and every fs write stubbed:
 *
 *   malformed id  → 400, no service call at all, no fs write   (every method)
 *   unknown id    → 404, nothing but harness.get, no fs write  (POST/PUT/PATCH/DELETE)
 *   unknown id    → no fs write                                (GET)
 *
 * Both checks run with an empty body, so the id check has to come before the
 * body is looked at.
 *
 * The three surfaces/[platform] route files are the exception: the policy
 * plugin calls them with a bare slug on the per-message path, so they hand the
 * id to SurfaceAdminService, which does its own resolution over the stored
 * rows (lib/services/surface-admins.ts; tested in surfaces/[platform]/
 * id-matching.test.ts). For those the sweep checks that the id goes to that
 * service and nowhere else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { syncBuiltinESMExports } from 'module'

const state = vi.hoisted(() => ({
  calls: [] as string[],
  canned: {} as Record<string, unknown>,
}))

vi.mock('@/lib/services', () => {
  const service = (name: string) =>
    new Proxy({}, {
      get: (_t, method) => () => {
        const key = `${name}.${String(method)}`
        state.calls.push(key)
        return state.canned[key]
      },
    })
  const cache: Record<string, unknown> = {}
  return {
    services: new Proxy({}, {
      get: (_t, name) => (cache[String(name)] ??= service(String(name))),
    }),
  }
})
vi.mock('child_process')

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
type RouteModule = Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', Handler>>

const modules = import.meta.glob<RouteModule>('./**/route.ts')
const ALL_ROUTES = Object.keys(modules).sort()

const URL_ID_PREFIX = './harnesses/[id]/'
const SERVICE_RESOLVED_PREFIX = './harnesses/[id]/surfaces/[platform]/'

// Routes that take an agent id in the request body. `body(id)` builds a
// request that carries the id; `reads` are read-only lookups the handler may
// make before the id is resolved (with what the mock returns for them).
// `unknown: 'label'` marks a route that stores the id as a label and touches
// no agent file, so only the id's shape is checked there.
type BodyRoute = {
  method: 'POST' | 'PUT'
  params?: Record<string, string>
  body: (id: string) => unknown
  reads?: Record<string, unknown>
  unknown?: 'label'
  // The id may be left out; an empty one counts as left out.
  optional?: true
}
const STORED_KEY = { id: 'k1', provider: 'openai', name: 'k', assignedTo: [] }
const BODY_ID: Record<string, BodyRoute> = {
  './cascades/[name]/apply/route.ts': { method: 'POST', params: { name: 'c' }, body: (id) => ({ harnessId: id }) },
  './fleet/model-updates/apply/route.ts': { method: 'POST', body: (id) => ({ harnessId: id, from: 'a/b', to: 'a/c' }) },
  './keys/route.ts': { method: 'POST', body: (id) => ({ provider: 'openai', value: 'v', assignedTo: [id] }) },
  './keys/[id]/route.ts': {
    method: 'PUT',
    params: { id: 'k1' },
    body: (id) => ({ assignedTo: [id] }),
    reads: { 'keys.list': [STORED_KEY] },
  },
  './surfaces/signal/pin/route.ts': {
    method: 'POST',
    body: (id) => ({ phone: '+15550001111', pin: '123456', harnessId: id }),
    unknown: 'label',
  },
  './surfaces/signal/verify/route.ts': {
    method: 'POST',
    body: (id) => ({ phone: '+15550001111', code: '123456', pin: '123456', harnessId: id }),
    unknown: 'label',
    optional: true,
  },
}

// Routes that make a new agent from a name. The name is checked against the
// existing agents before anything is written; each has its own test for that.
const NEW_NAME: Record<string, string> = {
  './harnesses/create/route.ts': 'lib/services/__tests__/harness-name-taken.test.ts',
  './harnesses/import/route.ts': 'lib/services/__tests__/harness-name-taken.test.ts',
  './setup/deploy/route.ts': 'lib/services/__tests__/deploy-route.integration.test.ts',
}

// Routes that take no agent id. `[id]` / `[name]` here is a key id, a tool id,
// a cascade name or a Letta agent id (passed to the Letta API URL-encoded).
const NO_AGENT_ID = new Set([
  './audit/route.ts',
  './auth/login/route.ts',
  './auth/logout/route.ts',
  './cascades/[name]/route.ts',
  './cascades/route.ts',
  './fleet/analytics/route.ts',
  './fleet/chat-updates/route.ts',
  './fleet/discord-allowed-bot-roles/route.ts',
  './fleet/discord-approver-roles/route.ts',
  './fleet/discord-thread-posture/route.ts',
  './fleet/drift/route.ts',
  './fleet/model-updates/check/route.ts',
  './fleet/model-updates/route.ts',
  './harnesses/restart-running/route.ts',
  './harnesses/route.ts',
  './health/docker/route.ts',
  './integrity/route.ts',
  // Narrows a resync to agents already assigned to the key; the service drops
  // every id that is not in the key's stored assignment.
  './keys/[id]/resync/route.ts',
  './letta/agents/[id]/blocks/route.ts',
  './letta/agents/[id]/files/route.ts',
  './letta/agents/[id]/messages/route.ts',
  './letta/agents/route.ts',
  './letta/harnesses/route.ts',
  './memory-scopes/route.ts',
  './models/live/route.ts',
  './models/route.ts',
  './people/route.ts',
  './settings/model-auto-update/route.ts',
  './settings/route.ts',
  './setup/complete/route.ts',
  './setup/detect/route.ts',
  './surfaces/discord/verify/route.ts',
  './surfaces/mattermost/channels/route.ts',
  './surfaces/mattermost/verify/route.ts',
  './surfaces/route.ts',
  './surfaces/signal/deploy/route.ts',
  './surfaces/signal/groups/route.ts',
  './surfaces/signal/pin/bulk-set/route.ts',
  './surfaces/signal/profile/route.ts',
  './surfaces/signal/register/route.ts',
  './surfaces/signal/route.ts',
  './surfaces/slack/verify/route.ts',
  './tools/[id]/route.ts',
  './tools/route.ts',
  './usecase-templates/route.ts',
])

const MALFORMED = ['x/../.hermes-other', '..', '.', 'h_a.b', 'h_a b', '', 'h_' + 'a'.repeat(200), 'h_letta_agent-x/../y']
const UNKNOWN = 'h_no_such_agent'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const FS_WRITES = [
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync',
  'renameSync', 'cpSync', 'copyFileSync', 'chmodSync', 'symlinkSync', 'mkdtempSync',
] as const

let home: string
let fsWrites: string[]

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'id-sweep-'))
  state.calls.length = 0
  state.canned = {}
  fsWrites = []
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  for (const fn of FS_WRITES) {
    vi.spyOn(fs, fn as 'writeFileSync').mockImplementation(((...args: unknown[]) => {
      fsWrites.push(`${fn}(${String(args[0])})`)
    }) as never)
  }
  syncBuiltinESMExports()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is off in the sweep') }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  syncBuiltinESMExports()
  fs.rmSync(home, { recursive: true, force: true })
})

function request(method: string, body: unknown = {}): Request {
  const url = 'http://localhost/api/sweep?deleteFiles=true&platform=signal&userId=u&chatId=c'
  if (method === 'GET') return new Request(url)
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function handlers(file: string): Promise<Array<[string, Handler]>> {
  const mod = await modules[file]()
  return METHODS.flatMap((m) => (mod[m] ? [[m, mod[m]] as [string, Handler]] : []))
}

describe('every API route file is classified', () => {
  it('finds the route files', () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(70)
    expect(ALL_ROUTES.filter((f) => f.startsWith(URL_ID_PREFIX)).length).toBeGreaterThan(25)
  })

  it.each(ALL_ROUTES)('%s', (file) => {
    const kinds = [
      file.startsWith(URL_ID_PREFIX),
      file in BODY_ID,
      file in NEW_NAME,
      NO_AGENT_ID.has(file),
    ].filter(Boolean)
    expect(kinds.length, `${file} must be in exactly one group — see the header of this file`).toBe(1)
  })

  it('lists no route file that does not exist', () => {
    for (const file of [...Object.keys(BODY_ID), ...Object.keys(NEW_NAME), ...NO_AGENT_ID]) {
      expect(ALL_ROUTES, file).toContain(file)
    }
    for (const test of Object.values(NEW_NAME)) {
      expect(fs.existsSync(path.resolve(__dirname, '../..', test)), test).toBe(true)
    }
  })

  it('a route listed as taking no agent id does not read one', async () => {
    // integrity and the bulk PIN route list the fleet themselves and use each
    // agent's own id from that listing.
    const READS_ITS_OWN = new Set(['./keys/[id]/resync/route.ts', './integrity/route.ts', './surfaces/signal/pin/bulk-set/route.ts', './surfaces/signal/route.ts'])
    for (const file of NO_AGENT_ID) {
      if (READS_ITS_OWN.has(file)) continue
      const src = fs.readFileSync(path.resolve(__dirname, file), 'utf-8')
      expect(/\bharnessId\b|\bassignedTo\b|requireHarness|agentDataDir/.test(src), file).toBe(false)
    }
  })
})

const URL_ID_ROUTES = ALL_ROUTES.filter((f) => f.startsWith(URL_ID_PREFIX) && !f.startsWith(SERVICE_RESOLVED_PREFIX))
const SERVICE_RESOLVED_ROUTES = ALL_ROUTES.filter((f) => f.startsWith(SERVICE_RESOLVED_PREFIX))

describe('routes with the agent id in the URL', () => {
  it.each(URL_ID_ROUTES)('%s refuses a malformed id before doing anything', async (file) => {
    for (const [method, handler] of await handlers(file)) {
      for (const id of MALFORMED) {
        state.calls.length = 0
        const res = await handler(request(method), { params: Promise.resolve({ id }) })
        const label = `${method} ${JSON.stringify(id)}`
        expect(res.status, label).toBe(400)
        expect(state.calls, label).toEqual([])
        expect(fsWrites, label).toEqual([])
      }
    }
  })

  it.each(URL_ID_ROUTES)('%s refuses an unknown id before any change', async (file) => {
    for (const [method, handler] of await handlers(file)) {
      state.calls.length = 0
      if (method === 'GET') {
        // A read may answer however it likes for an id that names no agent
        // (some report zeros); it must not write.
        await handler(request(method), { params: Promise.resolve({ id: UNKNOWN }) }).catch(() => undefined)
        expect(fsWrites, method).toEqual([])
        continue
      }
      const res = await handler(request(method), { params: Promise.resolve({ id: UNKNOWN }) })
      expect(res.status, method).toBe(404)
      expect(state.calls, method).toEqual(['harness.get'])
      expect(fsWrites, method).toEqual([])
    }
  })
})

describe('surface policy routes hand the id to SurfaceAdminService only', () => {
  const refused = { ok: false, status: 404, error: 'Unknown agent' }
  const canned = {
    'surfaceAdmins.listAdmins': { platform: 'signal', admins: [], source: 'allowlist', allowAllDm: false },
    'surfaceAdmins.isAdmin': false,
    'surfaceAdmins.isGroupAllowed': false,
    'surfaceAdmins.setAdmins': refused,
    'surfaceAdmins.approveGroupInvite': refused,
  }

  it('covers the three route files', () => {
    expect(SERVICE_RESOLVED_ROUTES).toEqual([
      './harnesses/[id]/surfaces/[platform]/admins/[userId]/route.ts',
      './harnesses/[id]/surfaces/[platform]/admins/route.ts',
      './harnesses/[id]/surfaces/[platform]/groups/[groupId]/route.ts',
    ])
  })

  it.each(SERVICE_RESOLVED_ROUTES)('%s', async (file) => {
    for (const [method, handler] of await handlers(file)) {
      for (const id of [...MALFORMED, UNKNOWN]) {
        state.calls.length = 0
        state.canned = canned
        const params = { id, platform: 'signal', userId: 'u', groupId: 'g' }
        const res = await handler(request(method, { admins: [], actor: 'a', addedByUserId: 'a' }), { params: Promise.resolve(params) })
        const label = `${method} ${JSON.stringify(id)}`
        expect(state.calls.length, label).toBe(1)
        expect(state.calls[0], label).toMatch(/^surfaceAdmins\./)
        expect(fsWrites, label).toEqual([])
        if (method !== 'GET') expect(res.status, label).toBe(404)
      }
    }
  })
})

describe('routes with the agent id in the body', () => {
  it.each(Object.entries(BODY_ID))('%s refuses a malformed id before any change', async (file, spec) => {
    const handler = (await modules[file]())[spec.method]!
    for (const id of MALFORMED) {
      if (spec.optional && id === '') continue
      state.calls.length = 0
      state.canned = spec.reads ?? {}
      const res = await handler(request(spec.method, spec.body(id)), { params: Promise.resolve(spec.params ?? {}) })
      const label = JSON.stringify(id)
      expect(res.status, label).toBe(400)
      expect(state.calls.filter((c) => !(c in (spec.reads ?? {}))), label).toEqual([])
      expect(fsWrites, label).toEqual([])
    }
  })

  it.each(Object.entries(BODY_ID).filter(([, s]) => s.unknown !== 'label'))(
    '%s refuses an unknown id before any change',
    async (file, spec) => {
      const handler = (await modules[file]())[spec.method]!
      state.canned = spec.reads ?? {}
      const res = await handler(request(spec.method, spec.body(UNKNOWN)), { params: Promise.resolve(spec.params ?? {}) })
      expect([400, 404]).toContain(res.status)
      expect(state.calls.filter((c) => !(c in (spec.reads ?? {})))).toEqual(['harness.get'])
      expect(fsWrites).toEqual([])
    },
  )
})
