// @vitest-environment node
/**
 * The door agent routes, end to end over a real DoorAgentService.
 *
 * The launcher is a stub and the data folder is this test file's scratch
 * folder. Nothing here starts a container, opens a chat connection, calls a
 * model or reads a real secret: the two "secret" files hold made-up text, and
 * the tests check that text never comes back.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { DATA_DIR } from '@/lib/services/data-dir'
import { Storage } from '@/lib/services/storage'
import { AuditService } from '@/lib/services/audit'
import { DoorAgentService } from '@/lib/services/door-agents'
import { doorAgentPaths } from '@/lib/services/door-record'
import type { DoorLauncher } from '@/lib/services/door-launcher'
import { proxy } from '@/proxy'

const state = vi.hoisted(() => ({ services: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: new Proxy({}, { get: (_t, name) => state.services[String(name)] }) }))

const HERMES = [
  { id: 'h_alpha', name: 'alpha', runtime: 'hermes', status: 'running', costToday: 1.5, invocations: 7 },
  { id: 'h_beta', name: 'beta', runtime: 'hermes', status: 'stopped', costToday: null, invocations: null },
]
const RULES = {
  agentId: 'pi-one',
  persona: { name: 'Pi', description: 'Answers questions.' },
  discord: {
    guildId: '100000000000000000', channelId: '100000000000000001', adminUserIds: ['100000000000000002'],
    allowedUserIds: [], allowedRoleIds: [], anyoneInChannel: false, mentionRequired: true,
    bots: 'none', allowedBotIds: [], botLoopLimit: 4, readAllMessages: false,
  },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'provider/model-a', usdPerMTokIn: 1, usdPerMTokOut: 5 },
}
const READY = { code: 0, output: 'RESULT: ready to start.\n' }
const NOT_SEALED = { code: 1, output: '  FAIL  S1   only the door answers\nRESULT: not ready. The cell is not shown to be sealed.\n' }
const SECRET = /FAKE-TOKEN-VALUE-1|FAKE-KEY-VALUE-22/

const keysDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-routes-keys-')))
const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-routes-repo-')))
const secrets = { discordTokenFile: path.join(keysDir, 'token'), modelKeyFile: path.join(keysDir, 'key') }
fs.writeFileSync(secrets.discordTokenFile, 'FAKE-TOKEN-VALUE-1\n', { mode: 0o600 })
fs.writeFileSync(secrets.modelKeyFile, 'FAKE-KEY-VALUE-22\n', { mode: 0o600 })
afterAll(() => { for (const dir of [keysDir, repoDir]) fs.rmSync(dir, { recursive: true, force: true }) })

let calls: string[]
let dryRunResult: { code: number | null; output: string }
let live: boolean
let responses: string[]
const paths = doorAgentPaths(DATA_DIR, 'h_pi_one')

const launcher: DoorLauncher = {
  command: () => ({ node: '/fake/node', cli: '/fake/cli.ts' }),
  dryRun: async () => { calls.push('dryRun'); return dryRunResult },
  start: async (o) => {
    calls.push('start')
    live = true
    fs.mkdirSync(o.stateDir, { recursive: true })
    fs.writeFileSync(path.join(o.stateDir, 'run.json'), JSON.stringify({ pid: 4242, project: 'smlab-fake0000', policyHash: 'x', startedAt: '2026-11-16T12:00:00.000Z' }))
  },
  stop: async () => { calls.push('stop'); live = false; return { ok: true, output: '' } },
  alive: () => live,
}

beforeEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const storage = new Storage(DATA_DIR)
  calls = []
  responses = []
  dryRunResult = READY
  live = false
  const harness = {
    list: () => HERMES,
    get: (id: string) => HERMES.find((h) => h.id === id),
    nameTaken: (name: string) => HERMES.some((h) => h.name === name),
    remove: () => { calls.push('harness.remove'); return { removed: true } },
    start: () => { calls.push('harness.start') },
    stop: () => { calls.push('harness.stop') },
  }
  state.services = {
    harness,
    doorAgents: new DoorAgentService({
      storage, audit: new AuditService(storage), dataDir: DATA_DIR, launcher, repoRoot: repoDir,
      nameTaken: harness.nameTaken, now: () => new Date('2026-11-16T12:00:00Z'),
    }),
  }
})

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
// A response body is read loosely here: each test says what it expects of it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any
async function call(file: string, method: string, id: string | undefined, body?: unknown, query = ''): Promise<{ status: number; json: Body }> {
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, Handler>
  const init = method === 'GET' ? undefined : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
  const res = await mod[method](new Request(`http://localhost/api/x${query}`, init), { params: Promise.resolve((id ? { id } : {}) as Record<string, string>) })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}
const create = (name = 'pi-one', runtime?: string) => call('./door/route.ts', 'POST', undefined, { name, ...(runtime ? { runtime } : {}) })
const save = (version: number, rules: unknown = RULES) => call('./[id]/door/rules/route.ts', 'PUT', 'h_pi_one', { rules, secrets, version })
const filled = async () => { await create(); await save(1) }

describe('creating a door agent', () => {
  it('makes a draft and lists it after the Hermes agents', async () => {
    expect(await create()).toMatchObject({ status: 201, json: { id: 'h_pi_one', name: 'pi-one', runtime: 'pi' } })
    const list = (await call('./route.ts', 'GET', undefined)).json
    expect(list.slice(0, 2)).toEqual(HERMES)
    expect(list.slice(2)).toEqual([expect.objectContaining({ id: 'h_pi_one', runtime: 'pi', status: 'stopped', costToday: null, invocations: null })])
  })

  it('refuses a name a Hermes agent has, and writes nothing', async () => {
    expect((await create('alpha')).status).toBe(409)
    expect(fs.existsSync(path.join(DATA_DIR, 'harnesses.json'))).toBe(false)
    expect(fs.existsSync(path.join(DATA_DIR, 'door-agents'))).toBe(false)
  })

  it('refuses a name a door agent has', async () => {
    await create()
    expect((await create('Pi One')).status).toBe(409)
  })

  it.each([undefined, '', '../x', 7])('refuses the name %j', async (name) => {
    expect((await call('./door/route.ts', 'POST', undefined, { name })).status).toBe(400)
    expect(fs.existsSync(path.join(DATA_DIR, 'harnesses.json'))).toBe(false)
  })

  it('refuses a runtime with no launcher, and one it has never heard of', async () => {
    expect((await create('lc-one', 'letta-code')).status).toBe(400)
    expect((await create('x-one', 'hermes')).status).toBe(400)
  })
})

describe('with no door agent', () => {
  it('the fleet list is exactly what HarnessService lists', async () => {
    expect((await call('./route.ts', 'GET', undefined)).json).toEqual(HERMES)
  })

  it('a Hermes agent is still started, stopped and removed by HarnessService', async () => {
    fs.writeFileSync(path.join(DATA_DIR, 'harnesses.json'), JSON.stringify([{ id: 'h_alpha', name: 'alpha' }]))
    expect((await call('./[id]/start/route.ts', 'POST', 'h_alpha')).status).toBe(200)
    expect((await call('./[id]/stop/route.ts', 'POST', 'h_alpha')).status).toBe(200)
    expect((await call('./[id]/route.ts', 'DELETE', 'h_alpha')).status).toBe(200)
    expect((await call('./[id]/route.ts', 'GET', 'h_alpha')).json).toEqual(HERMES[0])
    expect(calls).toEqual(['harness.start', 'harness.stop', 'harness.remove'])
  })

  it('a door route refuses a Hermes agent', async () => {
    expect((await call('./[id]/door/route.ts', 'GET', 'h_alpha')).status).toBe(409)
    expect((await call('./[id]/door/rules/route.ts', 'PUT', 'h_alpha', { rules: RULES, secrets, version: 1 })).status).toBe(409)
    expect((await call('./[id]/door/receipts/route.ts', 'GET', 'h_alpha')).status).toBe(409)
    expect(fs.existsSync(path.join(DATA_DIR, 'door-agents'))).toBe(false)
  })
})

describe('the rules', () => {
  it('are saved, versioned and given back with the two paths', async () => {
    await create()
    const saved = await save(1)
    expect(saved).toMatchObject({ status: 200, json: { applied: 'stored', record: { version: 2 } } })
    const view = (await call('./[id]/door/route.ts', 'GET', 'h_pi_one')).json
    expect(view.record.rules.discord.channelId).toBe('100000000000000001')
    expect(view.record.secrets).toEqual(secrets)
    expect(view.problems).toEqual({ rules: [], secrets: [] })
    expect(view.status).toEqual({ state: 'stopped', cellSealed: null, rulesInForce: null })
  })

  it('are refused with every reason when the launcher would refuse them', async () => {
    await create()
    const res = await save(1, { ...RULES, discord: { ...RULES.discord, adminUserIds: [] } })
    expect(res.status).toBe(422)
    expect(res.json.details.join('\n')).toMatch(/adminUserIds/)
    expect((await call('./[id]/door/route.ts', 'GET', 'h_pi_one')).json.record.version).toBe(1)
  })

  it('are refused when the page edited an older version', async () => {
    await filled()
    expect((await save(1)).status).toBe(409)
  })

  it('are refused, with nothing stored, when the body is empty', async () => {
    await create()
    expect((await call('./[id]/door/rules/route.ts', 'PUT', 'h_pi_one', {})).status).toBe(422)
  })
})

describe('start and stop', () => {
  it('start runs the dry run first', async () => {
    await filled()
    expect((await call('./[id]/start/route.ts', 'POST', 'h_pi_one')).status).toBe(200)
    expect(calls).toEqual(['dryRun', 'start'])
    expect((await call('./[id]/route.ts', 'GET', 'h_pi_one')).json.status).toBe('running')
    expect((await call('./[id]/door/route.ts', 'GET', 'h_pi_one')).json.status).toMatchObject({ state: 'running', cellSealed: true })
  })

  it('start is refused, with the failed checks, when the cell is not sealed', async () => {
    await filled()
    dryRunResult = NOT_SEALED
    const res = await call('./[id]/start/route.ts', 'POST', 'h_pi_one')
    expect(res.status).toBe(422)
    expect(res.json.details).toEqual(['FAIL  S1   only the door answers', 'RESULT: not ready. The cell is not shown to be sealed.'])
    expect(calls).toEqual(['dryRun'])
    expect((await call('./[id]/door/route.ts', 'GET', 'h_pi_one')).json.status).toMatchObject({ state: 'stopped', cellSealed: false })
  })

  it('stop goes to the launcher, never to HarnessService', async () => {
    await filled()
    await call('./[id]/start/route.ts', 'POST', 'h_pi_one')
    expect((await call('./[id]/stop/route.ts', 'POST', 'h_pi_one')).status).toBe(200)
    expect(calls).toEqual(['dryRun', 'start', 'stop'])
  })
})

describe('usage, receipts and logs', () => {
  it('usage is unknown until the door has a ledger, and never a made-up zero', async () => {
    await filled()
    const before = (await call('./[id]/usage/route.ts', 'GET', 'h_pi_one')).json
    expect(before).toMatchObject({ costToday: null, costWeek: null, costMonth: null, costStatus: 'unknown' })
    fs.mkdirSync(paths.stateDir, { recursive: true })
    fs.writeFileSync(path.join(paths.stateDir, 'spend.json'), JSON.stringify({ schema: 1, months: { '2026-11': 1.25 } }))
    expect((await call('./[id]/usage/route.ts', 'GET', 'h_pi_one')).json).toMatchObject({ costToday: null, costMonth: 1.25 })
    expect((await call('./[id]/door/route.ts', 'GET', 'h_pi_one')).json.usage).toMatchObject({ spentThisMonthUsd: 1.25, budgetMonthlyUsd: 5 })
  })

  it('receipts come newest first, as many as asked for', async () => {
    await filled()
    fs.mkdirSync(paths.stateDir, { recursive: true })
    const line = (n: number, rule: string) => JSON.stringify({ ts: `2026-11-16T10:00:0${n}.000Z`, agentId: 'pi-one', policyHash: 'h', event: { kind: 'inbound' }, verdict: 'drop', rule, why: `because ${rule}` })
    fs.writeFileSync(path.join(paths.stateDir, 'receipts.jsonl'), [line(1, 'adm.rooms'), line(2, 'adm.users'), line(3, 'addr.mention')].join('\n') + '\n')
    const all = (await call('./[id]/door/receipts/route.ts', 'GET', 'h_pi_one')).json.receipts
    expect(all.map((r: { rule: string }) => r.rule)).toEqual(['addr.mention', 'adm.users', 'adm.rooms'])
    expect(all[0].why).toBe('because addr.mention')
    const two = (await call('./[id]/door/receipts/route.ts', 'GET', 'h_pi_one', undefined, '?last=2')).json.receipts
    expect(two).toHaveLength(2)
    const junk = (await call('./[id]/door/receipts/route.ts', 'GET', 'h_pi_one', undefined, '?last=-5')).json.receipts
    expect(junk).toHaveLength(3)
  })

  it('logs are the door\'s own log', async () => {
    await filled()
    fs.writeFileSync(paths.log, 'cell up and sealed\nlive: agent pi-one\n')
    expect((await call('./[id]/logs/route.ts', 'GET', 'h_pi_one', undefined, '?lines=1')).json).toEqual({ logs: 'live: agent pi-one', lines: 1, source: 'door' })
  })
})

describe('removing', () => {
  it('stops the door and forgets the agent, without HarnessService', async () => {
    await filled()
    await call('./[id]/start/route.ts', 'POST', 'h_pi_one')
    calls.length = 0
    expect((await call('./[id]/route.ts', 'DELETE', 'h_pi_one', undefined, '?deleteFiles=true')).status).toBe(200)
    expect(calls).toEqual(['stop'])
    expect((await call('./route.ts', 'GET', undefined)).json).toEqual(HERMES)
    expect(fs.existsSync(secrets.discordTokenFile)).toBe(true)
  })
})

describe('secrets', () => {
  it('no response, stored file or audit line ever holds what the two files hold', async () => {
    await filled()
    await call('./[id]/start/route.ts', 'POST', 'h_pi_one')
    for (const [file, method] of [
      ['./route.ts', 'GET'], ['./[id]/route.ts', 'GET'], ['./[id]/door/route.ts', 'GET'], ['./[id]/door/receipts/route.ts', 'GET'],
      ['./[id]/logs/route.ts', 'GET'], ['./[id]/usage/route.ts', 'GET'], ['./[id]/stop/route.ts', 'POST'],
    ]) await call(file, method, 'h_pi_one')
    // A secret pasted where a path belongs is refused, and is not echoed back.
    const pasted = await call('./[id]/door/rules/route.ts', 'PUT', 'h_pi_one', { rules: RULES, secrets: { discordTokenFile: 'FAKE-TOKEN-VALUE-1', modelKeyFile: '' }, version: 2 })
    expect(pasted.status).toBe(422)
    expect(responses.length).toBeGreaterThan(9)
    for (const text of responses) expect(text).not.toMatch(SECRET)
    for (const file of fs.readdirSync(DATA_DIR, { recursive: true }) as string[]) {
      const full = path.join(DATA_DIR, file)
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8'), file).not.toMatch(SECRET)
    }
  })
})

describe('authorisation comes before any of it', () => {
  const TOKEN = 'operator-token-for-this-test'
  const req = (p: string, method: string) => new NextRequest(new URL(`http://localhost:3000${p}`), { method })

  it.each([
    ['POST', '/api/harnesses/door'],
    ['GET', '/api/harnesses/h_pi_one/door'],
    ['PUT', '/api/harnesses/h_pi_one/door/rules'],
    ['GET', '/api/harnesses/h_pi_one/door/receipts'],
    ['POST', '/api/harnesses/h_pi_one/start'],
    ['POST', '/api/harnesses/h_pi_one/stop'],
    ['GET', '/api/harnesses/h_pi_one/logs'],
    ['DELETE', '/api/harnesses/h_pi_one'],
  ])('%s %s needs the operator session', async (method, p) => {
    process.env.HSM_OPERATOR_TOKEN = TOKEN
    try { expect((await proxy(req(p, method))).status).toBe(401) } finally { delete process.env.HSM_OPERATOR_TOKEN }
    expect((await proxy(req(p, method))).status).toBe(503)
  })
})
