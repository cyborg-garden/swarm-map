// @vitest-environment node
/// <reference types="vite/client" />
/**
 * Route sweep: every API route that takes an agent id resolves it through the
 * shared step in lib/harness-ref.ts before it does anything else.
 *
 * The sweep enumerates every app/api route file. Each one must be classified:
 *
 *   - under harnesses/[id]/  → the id is a URL segment (found automatically);
 *   - BODY_ID                → the id arrives in the request body, under the
 *                              fields the entry names;
 *   - NEW_NAME               → the route creates an agent from a name (covered
 *                              by a dedicated test, which must exist);
 *   - NO_AGENT_ID            → the route takes no agent id.
 *
 * A route file in none of these fails the sweep, so a new route cannot be
 * added without deciding which it is.
 *
 * What is checked, with every service mocked and every fs write stubbed:
 *
 *   malformed id   → 400, no service call at all, no fs write        (every method)
 *   unknown id     → 404, nothing but harness.get, no fs write  (POST/PUT/PATCH/DELETE)
 *   unknown id     → no fs write                                (GET)
 *   unmanaged row  → 409, no service call at all, no fs write   (POST/PUT/PATCH/DELETE)
 *
 * An unmanaged row is a stored row whose runtime tag Swarm Map does not know
 * (the sweep stores one in a real harnesses.json for that check). It is
 * read-only on every route; the one exception is DELETE /api/harnesses/:id,
 * which forgets the row.
 *
 * Both checks run with an empty body, so the id check has to come before the
 * body is looked at.
 *
 * Which body fields carry an id is not taken on trust. The sweep reads every
 * handler's source for the fields it takes from a parsed JSON body or from
 * the query string, and each route's set must equal what is declared for it
 * here: its BODY_ID fields plus its OTHER_FIELDS. A handler that starts
 * reading a new field fails the sweep until the field is declared as an agent
 * id (and then checked like one) or as something else. Handlers that hand the
 * whole parsed body on are listed in WHOLE_BODY.
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
import { DATA_DIR } from '@/lib/services/data-dir'

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

// Routes that take an agent id in the request body. `fields` are the body
// fields that carry one (`list` marks those that carry an array of them);
// each is swept separately on top of `base`. `reads` are read-only lookups
// the handler may make before the id is resolved (with what the mock returns
// for them). `unknown` says what an id that names no agent means there:
// 'label' — the id is stored as a label and no agent file is touched;
// 'filter' — the ids only narrow a list the record already holds. For those
// two only the id's shape is checked. `optional` fields may be left out; an
// empty value counts as left out.
type BodyRoute = {
  method: 'POST' | 'PUT'
  params?: Record<string, string>
  fields: string[]
  list?: string[]
  base: Record<string, unknown>
  reads?: Record<string, unknown>
  unknown?: 'label' | 'filter'
  optional?: true
}
const STORED_KEY = { id: 'k1', provider: 'openai', name: 'k', assignedTo: [] }
const BODY_ID: Record<string, BodyRoute> = {
  './cascades/[name]/apply/route.ts': { method: 'POST', params: { name: 'c' }, fields: ['harnessId'], base: {} },
  './fleet/model-updates/apply/route.ts': { method: 'POST', fields: ['harnessId'], base: { from: 'a/b', to: 'a/c' } },
  './keys/route.ts': { method: 'POST', fields: ['assignedTo'], list: ['assignedTo'], base: { provider: 'openai', value: 'v' } },
  './keys/[id]/route.ts': {
    method: 'PUT',
    params: { id: 'k1' },
    fields: ['assignedTo'],
    list: ['assignedTo'],
    base: {},
    reads: { 'keys.list': [STORED_KEY] },
  },
  './keys/[id]/resync/route.ts': {
    method: 'POST',
    params: { id: 'k1' },
    fields: ['harnesses'],
    list: ['harnesses'],
    base: {},
    unknown: 'filter',
  },
  './surfaces/signal/pin/route.ts': {
    method: 'POST',
    fields: ['harnessId'],
    base: { phone: '+15550001111', pin: '123456' },
    unknown: 'label',
  },
  './surfaces/signal/verify/route.ts': {
    method: 'POST',
    fields: ['harnessId'],
    base: { phone: '+15550001111', code: '123456', pin: '123456' },
    unknown: 'label',
    optional: true,
  },
}

// Every other field a handler reads from a parsed JSON body or the query
// string ('?name'), per route. None of these carries an agent id. The reader
// is broad on purpose: it also picks up fields read from the JSON of an
// outgoing fetch (`result`, `ok`, …), which are listed here like the rest.
const OTHER_FIELDS: Record<string, string> = {
  './audit/route.ts': '?since ?what ?who',
  './auth/login/route.ts': 'token',
  './cascades/[name]/apply/route.ts': 'restart',
  './cascades/[name]/route.ts': 'chain entries name',
  './cascades/route.ts': 'chain entries name overwrite sourceHarness',
  './fleet/analytics/route.ts': '?days',
  './fleet/chat-updates/route.ts': 'level',
  './fleet/discord-thread-posture/route.ts': '?adapterDefault',
  './fleet/model-updates/apply/route.ts': 'from provider to',
  './fleet/model-updates/check/route.ts': 'apply',
  './harnesses/[id]/analytics/route.ts': '?days',
  './harnesses/[id]/artifacts/sync/route.ts': 'assignKeys dryRun force includeVision packs surface',
  './harnesses/[id]/cascade/save-as/route.ts': 'name overwrite',
  './harnesses/[id]/chat-updates/route.ts': 'level',
  './harnesses/[id]/duplicate/route.ts': 'name',
  './harnesses/[id]/image/route.ts': 'imageRef',
  './harnesses/[id]/logs/route.ts': '?lines ?source',
  './harnesses/[id]/models/route.ts': 'cascade chain expected_chain expected_fallback_providers fallback_providers model provider set_primary',
  './harnesses/[id]/pairing/route.ts': 'platform userId',
  './harnesses/[id]/policy/route.ts': '?action ?chatId ?platform action chatId chatName platform',
  './harnesses/[id]/restart/route.ts': 'mode',
  './harnesses/[id]/route.ts': '?deleteFiles',
  './harnesses/[id]/settings/route.ts': 'commandApprovalAdminOnly discordThreadMentionGating dmPolicy groupInvitePolicy memoryScope mentionGating observeUnmentioned resources sharedVpn surfaces version vpnEnabled',
  './harnesses/[id]/surfaces/[platform]/admins/route.ts': 'actor admins',
  './harnesses/[id]/surfaces/[platform]/groups/[groupId]/route.ts': 'addedByUserId',
  './harnesses/[id]/surfaces/connect/route.ts': 'config ids platform resolved',
  './harnesses/[id]/surfaces/disconnect/route.ts': 'platform',
  './harnesses/[id]/tier/route.ts': 'tier',
  './harnesses/[id]/tools/route.ts': 'tools',
  './harnesses/[id]/tuning/route.ts': 'expected values',
  './harnesses/[id]/usecase/reapply/route.ts': 'templateId',
  './harnesses/create/route.ts': 'action channel keyId models name packs platform provider surface tier',
  './harnesses/import/route.ts': 'action dataDir keyId name packs provider surface',
  './health/docker/route.ts': 'data ts',
  './keys/[id]/route.ts': 'metadata value',
  './keys/route.ts': 'envVar identifier name provider value',
  './models/live/route.ts': '?force ?provider',
  './settings/route.ts': 'discordAllowedBotRoles',
  './setup/deploy/route.ts': 'braveKey browserEnabled bundledOllama discordEnabled discordToken existingKeyId fallbackModel githubMcpEnabled githubToken googleClientId googleClientSecret googleEnabled googleIdentity image llmKey mattermostEnabled mattermostToken mattermostUrl name notionEnabled notionKey packs persona primaryModel provider runtime saveKeyToRegistry signalEnabled signalPhone slackAppToken slackBotToken slackEnabled surface telegramEnabled telegramToken template tier',
  './surfaces/discord/verify/route.ts': 'id token username',
  './surfaces/mattermost/channels/route.ts': '?token ?url id',
  './surfaces/mattermost/verify/route.ts': 'id token url username',
  './surfaces/signal/groups/route.ts': '?phone error result',
  './surfaces/signal/pin/bulk-set/route.ts': 'result',
  './surfaces/signal/pin/route.ts': '?phone phone pin result',
  './surfaces/signal/profile/route.ts': 'displayName phone',
  './surfaces/signal/register/route.ts': 'captcha phone',
  './surfaces/signal/route.ts': 'result',
  './surfaces/signal/verify/route.ts': 'code displayName phone pin result',
  './surfaces/slack/verify/route.ts': 'error ok team token user user_id',
}

// Handlers that pass the parsed body on whole, so their fields cannot be read
// off the source. Each says where the body goes and why no agent id can ride
// in it unchecked.
const WHOLE_BODY: Record<string, string> = {
  './harnesses/[id]/models/tracking/route.ts': 'iterated as { "provider/model": boolean }; every key is checked against that shape',
  './keys/route.ts': 'KeysService.add, which checks every assignedTo entry; the route resolves them first',
  './settings/model-auto-update/route.ts': 'ConfigService.updateModelAutoUpdate: fleet settings, no per-agent target',
  './settings/route.ts': 'ConfigService.updateSettings: fleet settings, no per-agent target',
  './tools/[id]/route.ts': 'ToolsService.update: a tool record, no per-agent target',
}

// Routes that make a new agent from a name. The name is checked against the
// existing agents before anything is written; each has its own test for that.
const NEW_NAME: Record<string, string> = {
  './harnesses/create/route.ts': 'lib/services/__tests__/harness-name-taken.test.ts',
  './harnesses/import/route.ts': 'lib/services/__tests__/harness-name-taken.test.ts',
  './setup/deploy/route.ts': 'lib/services/__tests__/deploy-route.integration.test.ts',
}

// Routes that take no agent id. `[id]` / `[name]` here is a key id, a tool id
// or a cascade name.
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
  './harnesses/retired/route.ts',
  './harnesses/route.ts',
  './health/docker/route.ts',
  './integrity/route.ts',
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

const MALFORMED = ['x/../.hermes-other', '..', '.', 'h_a.b', 'h_a b', '', 'h_' + 'a'.repeat(200), 'h_agent-x/../y']
const UNKNOWN = 'h_no_such_agent'
// A stored row whose runtime tag has no adapter, and the one route that may
// act on it.
const UNMANAGED = { id: 'h_old', name: 'old', runtime: 'some-other-runtime' }
const FORGET_ROUTE = './harnesses/[id]/route.ts'
// The sweep stubs fs writes; the stored rows are put in place with the real one.
const realWriteFileSync = fs.writeFileSync
const storeRows = (rows: unknown[]) => realWriteFileSync(path.join(DATA_DIR, 'harnesses.json'), JSON.stringify(rows))
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
  fs.rmSync(path.join(DATA_DIR, 'harnesses.json'), { force: true })
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
    const READS_ITS_OWN = new Set(['./integrity/route.ts', './surfaces/signal/pin/bulk-set/route.ts', './surfaces/signal/route.ts'])
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

  it.each(URL_ID_ROUTES)('%s changes nothing on a row with an unknown runtime tag', async (file) => {
    for (const [method, handler] of await handlers(file)) {
      if (method === 'GET') continue
      state.calls.length = 0
      state.canned = { 'harness.remove': { removed: true } }
      storeRows([UNMANAGED])
      const res = await handler(request(method), { params: Promise.resolve({ id: UNMANAGED.id }) })
      if (file === FORGET_ROUTE && method === 'DELETE') {
        // Forgetting the row is the one thing that works on it.
        expect(res.status, method).toBe(200)
        expect(state.calls, method).toEqual(['harness.remove'])
      } else {
        expect(res.status, method).toBe(409)
        expect(await res.json(), method).toMatchObject({ reason: 'unknown', runtime: UNMANAGED.runtime })
        expect(state.calls, method).toEqual([])
      }
      expect(fsWrites, method).toEqual([])
    }
  })

  it('the route that forgets a row is one of them', () => {
    expect(URL_ID_ROUTES).toContain(FORGET_ROUTE)
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

// The fields a handler reads from a parsed JSON body or the query string.
// Broad on purpose (see OTHER_FIELDS): a name it should not have picked up is
// a line in a table; a name it missed is an id nobody checked.
function bodyFields(src: string): string[] {
  const out = new Set<string>()
  const vars = new Set(['body'])
  for (const m of src.matchAll(/\b(\w+)\s*(?::[^=\n]+)?=\s*(?:\(\s*)?await\s+\w+\.json\(\)/g)) vars.add(m[1])
  const names = (list: string) => {
    for (const part of list.split(/[,;\n]/)) {
      const name = part.trim().replace(/^\.\.\./, '').split(/[:?=\s]/)[0]
      if (/^[A-Za-z_]\w*$/.test(name)) out.add(name)
    }
  }
  for (const v of vars) {
    for (const m of src.matchAll(new RegExp(`\\b${v}\\??\\.([A-Za-z_]\\w*)`, 'g'))) out.add(m[1])
    for (const m of src.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${v}\\b`, 'g'))) names(m[1])
    for (const m of src.matchAll(new RegExp(`['"](\\w+)['"]\\s+in\\s+${v}\\b`, 'g'))) out.add(m[1])
    for (const m of src.matchAll(new RegExp(`\\(${v} as \\{\\s*(\\w+)`, 'g'))) out.add(m[1])
    for (const m of src.matchAll(new RegExp(`\\(${v} as [^()]*\\)\\??\\.([A-Za-z_]\\w*)`, 'g'))) out.add(m[1])
    for (const m of src.matchAll(new RegExp(`\\b${v}\\??\\.?\\[\\s*['"](\\w+)['"]\\s*\\]`, 'g'))) out.add(m[1])
  }
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*(?:\(\s*)?await\s+\w+\.json\(\)/g)) names(m[1])
  for (const m of src.matchAll(/\.json\(\)\s*\)?\s*as\s*\{([^{}]*)\}/g)) names(m[1])
  for (const m of src.matchAll(/let\s+\w+\s*:\s*\{([^{}]*)\}/g)) names(m[1])
  for (const m of src.matchAll(/searchParams\.get\(\s*['"](\w+)['"]\s*\)/g)) out.add('?' + m[1])
  for (const skip of ['json', 'catch', 'then']) out.delete(skip)
  return [...out].sort()
}

// True when a handler passes the parsed body on whole instead of picking
// fields out of it.
function passesWholeBody(src: string): boolean {
  return /[(,]\s*body\s*[,)]|Object\.(entries|keys|values)\(\s*body\s*(\)|as\b)|\.\.\.body\b/.test(src)
}

// Ways of reading the request body that bodyFields() does not follow.
function otherBodyReads(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\.(?:clone|text|formData|arrayBuffer|blob|bytes)\(\)|\b_?req(?:uest)?\.body\b/g)) out.push(m[0])
  for (const m of src.matchAll(/(?:\b(\w+)\s*(?::[^=\n]+)?=\s*(?:\(\s*)?|(\}\s*=\s*(?:\(\s*)?))?await\s+_?req(?:uest)?\.json\(\)/g)) {
    if (m[1] !== 'body' && !m[2]) out.push(m[0].trim())
  }
  return out
}

const sourceOf = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf-8')

describe('the body fields each route reads are all declared', () => {
  it('the reader finds a field however the handler picks it out', () => {
    const cases: Array<[string, string[]]> = [
      ['const body = await request.json()\nuse(body.target)', ['target']],
      ['const body = await request.json().catch(() => ({}))\nuse(body?.agent)', ['agent']],
      ['const { who, other: renamed = 1, ...rest } = await request.json()', ['other', 'rest', 'who']],
      ['const payload = await req.json()\nconst { agentRef } = payload', ['agentRef']],
      ['const data = await request.json()\nuse(data["botName"])', ['botName']],
      ['body = (await request.json()) as { owner?: string; n?: number }', ['n', 'owner']],
      ['let body: { harnessRef?: string }\nbody = await request.json()', ['harnessRef']],
      ["const body = await request.json()\nif ('agents' in body) use((body as { agents: unknown }).agents)", ['agents']],
      ["const who = new URL(request.url).searchParams.get('harness')", ['?harness']],
      ['const body = await request.json() as Shape\nuse((body as any).hidden, (body as { x?: string }).x)', ['hidden', 'x']],
    ]
    for (const [src, want] of cases) expect(bodyFields(src), src).toEqual(want)
    expect(passesWholeBody('services.keys.add(body)')).toBe(true)
    expect(passesWholeBody('services.tools.update(id, body)')).toBe(true)
    expect(passesWholeBody('save({ ...body, id })')).toBe(true)
    expect(passesWholeBody('for (const [k, v] of Object.entries(body as object)) {}')).toBe(true)
    expect(passesWholeBody('const { a } = body\nuse(body.b)')).toBe(false)
    expect(passesWholeBody('for (const [k, v] of Object.entries(body.surfaces ?? {})) {}')).toBe(false)
  })

  it.each(ALL_ROUTES)('%s', (file) => {
    const src = sourceOf(file)
    const declared = [...(BODY_ID[file]?.fields ?? []), ...(OTHER_FIELDS[file] ?? '').split(' ').filter(Boolean)].sort()
    expect(bodyFields(src), `${file}: declare each field in BODY_ID (it carries an agent id) or OTHER_FIELDS (it does not)`).toEqual(declared)
    expect(passesWholeBody(src), `${file}: passes the parsed body on whole — list it in WHOLE_BODY, or pick the fields out`).toBe(file in WHOLE_BODY)
  })

  it('declares nothing for a route file that does not exist', () => {
    for (const file of [...Object.keys(OTHER_FIELDS), ...Object.keys(WHOLE_BODY)]) expect(ALL_ROUTES, file).toContain(file)
  })

  it('every handler takes its body the one way the reader follows', () => {
    // The reader follows `body = await request.json()` and a destructuring of
    // the same call. Any other way of getting at the request body is not
    // followed, so it is not allowed in a route file.
    expect(otherBodyReads('const body = await request.json()\nconst { a } = await request.json()')).toEqual([])
    expect(otherBodyReads('const { a } = await request.clone().json()')).toEqual(['.clone()'])
    expect(otherBodyReads('const raw = JSON.parse(await request.text())')).toEqual(['.text()'])
    expect(otherBodyReads('const form = await request.formData()')).toEqual(['.formData()'])
    expect(otherBodyReads('const reader = request.body')).toEqual(['request.body'])
    expect(otherBodyReads('const payload = await request.json()')).toEqual(['payload = await request.json()'])
    expect(otherBodyReads('use(await request.json())')).toEqual(['await request.json()'])
    for (const file of ALL_ROUTES) expect(otherBodyReads(sourceOf(file)), file).toEqual([])
  })

  it('names no id-like field as something else without saying why', () => {
    // A field whose name says "agent" or "harness" and is not swept as an id.
    // Each one is accounted for here.
    const EXPLAINED: Record<string, string> = {
      './cascades/route.ts sourceHarness': 'stored on the cascade record as a note of where it was saved from',
      './harnesses/[id]/artifacts/sync/route.ts assignKeys': 'a boolean: whether to assign the base-package keys',
    }
    const found: string[] = []
    for (const [file, fields] of Object.entries(OTHER_FIELDS)) {
      for (const field of fields.split(' ')) {
        if (/agent|harness|assign/i.test(field)) found.push(`${file} ${field}`)
      }
    }
    expect(found.sort()).toEqual(Object.keys(EXPLAINED).sort())
  })
})

const bodyWith = (spec: BodyRoute, field: string, id: unknown) => ({
  ...spec.base,
  [field]: spec.list?.includes(field) ? [id] : id,
})
const BODY_CASES = Object.entries(BODY_ID).flatMap(([file, spec]) =>
  spec.fields.map((field) => [file, field, spec] as [string, string, BodyRoute]),
)

describe('routes with the agent id in the body', () => {
  it.each(BODY_CASES)('%s refuses a malformed %s before any change', async (file, field, spec) => {
    const handler = (await modules[file]())[spec.method]!
    for (const id of MALFORMED) {
      if (spec.optional && id === '') continue
      state.calls.length = 0
      state.canned = spec.reads ?? {}
      const res = await handler(request(spec.method, bodyWith(spec, field, id)), { params: Promise.resolve(spec.params ?? {}) })
      const label = JSON.stringify(id)
      expect(res.status, label).toBe(400)
      expect(state.calls.filter((c) => !(c in (spec.reads ?? {}))), label).toEqual([])
      expect(fsWrites, label).toEqual([])
    }
  })

  it.each(BODY_CASES.filter(([, , s]) => !s.unknown))(
    '%s refuses an unknown %s before any change',
    async (file, field, spec) => {
      const handler = (await modules[file]())[spec.method]!
      state.canned = spec.reads ?? {}
      const res = await handler(request(spec.method, bodyWith(spec, field, UNKNOWN)), { params: Promise.resolve(spec.params ?? {}) })
      expect([400, 404]).toContain(res.status)
      expect(state.calls.filter((c) => !(c in (spec.reads ?? {})))).toEqual(['harness.get'])
      expect(fsWrites).toEqual([])
    },
  )

  it.each(BODY_CASES.filter(([, , s]) => !s.unknown))(
    '%s changes nothing when %s is a row with an unknown runtime tag',
    async (file, field, spec) => {
      const handler = (await modules[file]())[spec.method]!
      state.canned = spec.reads ?? {}
      storeRows([UNMANAGED])
      const res = await handler(request(spec.method, bodyWith(spec, field, UNMANAGED.id)), { params: Promise.resolve(spec.params ?? {}) })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ reason: 'unknown', runtime: UNMANAGED.runtime })
      expect(state.calls.filter((c) => !(c in (spec.reads ?? {})))).toEqual([])
      expect(fsWrites).toEqual([])
    },
  )
})
