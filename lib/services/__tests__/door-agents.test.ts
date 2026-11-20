// @vitest-environment node
/**
 * DoorAgentService: one door agent as a fleet row, driven through a launcher.
 *
 * Everything here is fake. The data folder is a scratch folder, the door's
 * state folder is written by the test, and the launcher is a stub that
 * records what it was asked. No Docker, no chat platform, no model, no secret.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DoorAgentService, DoorError } from '../door-agents'
import type { DoorLauncher } from '../door-launcher'
import { doorAgentPaths } from '../door-record'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import { parseConfig, policyFor } from '@/lib/lab/pi-discord/config'

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
const READY = { code: 0, output: 'containment\n  pass  S0   sealed\n\nRESULT: ready to start.\n' }
const NOT_SEALED = { code: 1, output: 'containment\n  FAIL  S1   only the door answers\n          the sink was reached\n\nRESULT: not ready. The cell is not shown to be sealed.\n' }
const NO_SECRETS = { code: 3, output: 'secrets\n  FAIL  SMLAB_DISCORD_TOKEN_FILE is not set\n\nRESULT: the cell is sealed, but the secret files are not in place yet.\n' }
const NOW = new Date('2026-11-16T12:00:00Z')

let tmp: string
let dataDir: string
let storage: Storage
let calls: string[]
let dryRunEnvs: Record<string, string | undefined>[]
let dryRunResult: { code: number | null; output: string }
let startFails: string | undefined
let stopFails: boolean
let livePids: Set<number>
let nodeProblem: string | undefined
let supervisorOf: (pid: number) => 'pm2' | undefined
// A stand-in for pm2: the apps it lists, whether it can be asked at all, and whether a restart works.
let pm2Apps: { id: number; name: string; script: string; pid: number | null }[]
let pm2Unknown: string | undefined
let pm2Asked: (number | null)[]
let pm2RestartFails: string | undefined
// A stop that ends the door but leaves something behind, as when the door was killed before it cleaned up.
let stopKillsButFails: boolean
let svc: DoorAgentService
let secrets: { discordTokenFile: string; modelKeyFile: string }

const paths = (id = 'h_pi_one') => doorAgentPaths(dataDir, id)
const writeState = (file: string, content: string) => {
  fs.mkdirSync(paths().stateDir, { recursive: true })
  fs.writeFileSync(path.join(paths().stateDir, file), content)
}
const policyHashOf = (rules: unknown) => policyFor(parseConfig(rules).config!).hash

function stubLauncher(): DoorLauncher {
  return {
    command: () => ({ node: '/fake/node', cli: '/fake/repo/lib/lab/pi-discord/cli.ts' }),
    nodeProblem: () => nodeProblem,
    async dryRun(o) {
      calls.push(`dryRun ${path.basename(o.configPath)}`)
      // The stub proves what the real launcher would be handed: paths, never a secret.
      dryRunEnvs.push(o.env)
      expect(Object.keys(o.env).filter((k) => k !== 'SMLAB_SEARCH_KEY_FILE').sort()).toEqual(['SMLAB_DISCORD_TOKEN_FILE', 'SMLAB_MODEL_KEY_FILE', 'SMLAB_STATE_DIR'])
      return dryRunResult
    },
    async start(o) {
      calls.push(`start ${path.basename(o.startScript)}`)
      if (startFails) throw new Error(startFails)
      const config = JSON.parse(fs.readFileSync(paths().config, 'utf8'))
      fs.mkdirSync(o.stateDir, { recursive: true })
      fs.writeFileSync(path.join(o.stateDir, 'run.json'), JSON.stringify({ pid: 4242, project: 'smlab-fake0000', agentId: 'pi-one', policyHash: policyHashOf(config), startedAt: NOW.toISOString() }))
      livePids.add(4242)
    },
    async stop(o) {
      calls.push('stop')
      if (stopFails) return { ok: false, output: 'these containers are still there' }
      livePids.clear()
      fs.rmSync(path.join(o.stateDir, 'run.json'), { force: true })
      // pm2 keeps a door that exited 0 stopped: the stop exit code it is started with.
      for (const app of pm2Apps) app.pid = null
      return stopKillsButFails ? { ok: false, output: 'these containers are still there' } : { ok: true, output: 'stopped' }
    },
    alive: (pid) => livePids.has(pid),
    supervisor: (pid) => supervisorOf(pid),
    supervisedBy(o) {
      pm2Asked.push(o.pid ?? null)
      if (pm2Unknown) return { unknown: pm2Unknown }
      const found = pm2Apps.filter((a) => a.script === o.startScript || (o.pid !== undefined && a.pid === o.pid))
      return found.length === 0 ? null : { supervisor: 'pm2', id: found[0].id, name: found[0].name }
    },
    async restartSupervised(app, o) {
      calls.push(`pm2 restart ${app.name}`)
      if (pm2RestartFails) throw new Error(pm2RestartFails)
      // pm2 runs the start script as it is on disk now, so the door comes up on the config written last.
      const config = JSON.parse(fs.readFileSync(paths().config, 'utf8'))
      fs.mkdirSync(o.stateDir, { recursive: true })
      for (const pid of livePids) if (supervisorOf(pid) === 'pm2') livePids.delete(pid)
      fs.writeFileSync(path.join(o.stateDir, 'run.json'), JSON.stringify({ pid: 6262, project: 'smlab-fake6262', agentId: 'pi-one', policyHash: policyHashOf(config), startedAt: NOW.toISOString() }))
      livePids.add(6262)
      pm2Apps.find((a) => a.id === app.id)!.pid = 6262
    },
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-agents-')))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(path.join(tmp, 'repo'))
  fs.mkdirSync(path.join(tmp, 'keys'))
  secrets = { discordTokenFile: path.join(tmp, 'keys', 'token'), modelKeyFile: path.join(tmp, 'keys', 'key') }
  fs.writeFileSync(secrets.discordTokenFile, 'FAKE-TOKEN-VALUE-1\n', { mode: 0o600 })
  fs.writeFileSync(secrets.modelKeyFile, 'FAKE-KEY-VALUE-22\n', { mode: 0o600 })
  storage = new Storage(dataDir)
  calls = []; dryRunEnvs = []
  dryRunResult = READY
  startFails = undefined
  stopFails = false
  livePids = new Set()
  nodeProblem = undefined
  pm2Apps = []
  pm2Unknown = undefined
  pm2Asked = []
  pm2RestartFails = undefined
  stopKillsButFails = false
  supervisorOf = (pid) => (pm2Apps.some((a) => a.pid === pid) ? 'pm2' : undefined)
  svc = new DoorAgentService({
    storage, audit: new AuditService(storage), dataDir, launcher: stubLauncher(),
    repoRoot: path.join(tmp, 'repo'), now: () => NOW,
    nameTaken: (name) => storage.read<Array<{ name?: string }>>('harnesses.json', []).some((h) => h.name === name),
  })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const filled = async () => {
  svc.create('pi-one')
  return svc.saveRules('h_pi_one', { rules: RULES, secrets, version: 1 })
}
const refusal = async (work: () => unknown): Promise<DoorError> => {
  try { await work() } catch (err) { if (err instanceof DoorError) return err; throw err }
  throw new Error('expected a refusal')
}

describe('creating a door agent', () => {
  it('stores a draft record and reserves the name in the fleet file', () => {
    const record = svc.create('Pi One')
    expect(record).toMatchObject({ id: 'h_pi_one', name: 'pi-one', runtime: 'pi', version: 1 })
    expect(JSON.parse(fs.readFileSync(paths().record, 'utf8'))).toEqual(record)
    expect(storage.read('harnesses.json', [])).toEqual([{ id: 'h_pi_one', name: 'pi-one', runtime: 'pi' }])
  })

  it('keeps the record and its folder to the owner', () => {
    svc.create('pi-one')
    expect(fs.statSync(paths().dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(paths().record).mode & 0o777).toBe(0o600)
  })

  it('refuses a name another agent has, and leaves that agent alone', async () => {
    storage.write('harnesses.json', [{ id: 'h_pi_one', name: 'pi-one' }])
    expect((await refusal(() => svc.create('pi-one'))).status).toBe(409)
    expect(storage.read('harnesses.json', [])).toEqual([{ id: 'h_pi_one', name: 'pi-one' }])
    expect(fs.existsSync(paths().dir)).toBe(false)
  })

  it.each(['', 'x', '../up', 'a'.repeat(40)])('refuses the name %j', async (name) => {
    expect((await refusal(() => svc.create(name))).status).toBe(400)
    expect(storage.read('harnesses.json', [])).toEqual([])
  })

  it('refuses a runtime the launcher does not have', async () => {
    for (const runtime of ['hermes', 'openclaw', 'claude-sdk', '', null, 7]) {
      expect((await refusal(() => svc.create('x-one', runtime))).status, String(runtime)).toBe(400)
    }
    expect(storage.read('harnesses.json', [])).toEqual([])
  })

  it('makes a Letta Code agent: the row and the record carry the harness, and the config the launcher reads names it', async () => {
    const record = svc.create('lc-one', 'letta-code')
    expect(record).toMatchObject({ id: 'h_lc_one', name: 'lc-one', runtime: 'letta-code' })
    expect(storage.read('harnesses.json', [])).toEqual([{ id: 'h_lc_one', name: 'lc-one', runtime: 'letta-code' }])
    expect(svc.row('h_lc_one')).toMatchObject({ runtime: 'letta-code', status: 'stopped' })
    await svc.saveRules('h_lc_one', { rules: { ...RULES, agentId: 'lc-one' }, secrets, version: 1 })
    const config = JSON.parse(fs.readFileSync(paths('h_lc_one').config, 'utf8'))
    expect(config).toMatchObject({ agentId: 'lc-one', harness: 'letta-code' })
    expect(parseConfig(config).errors).toEqual([])
    expect(svc.view('h_lc_one').problems.rules).toEqual([])
  })

  it('a Pi agent\'s config is written exactly as it was before the harness was a setting: no harness key', async () => {
    await filled()
    const config = JSON.parse(fs.readFileSync(paths().config, 'utf8'))
    expect(Object.keys(config)).toEqual(['$generated', 'agentId', 'persona', 'discord', 'budget', 'model'])
    expect('harness' in svc.view('h_pi_one').record.rules).toBe(false)
  })

  it('the harness is fixed when the agent is made: an edit that names another is not taken', async () => {
    svc.create('lc-one', 'letta-code')
    await svc.saveRules('h_lc_one', { rules: { ...RULES, agentId: 'lc-one', harness: 'pi' }, secrets, version: 1 })
    expect(JSON.parse(fs.readFileSync(paths('h_lc_one').config, 'utf8')).harness).toBe('letta-code')
    await filled()
    await svc.saveRules('h_pi_one', { rules: { ...RULES, harness: 'letta-code' }, secrets, version: 2 })
    expect('harness' in JSON.parse(fs.readFileSync(paths().config, 'utf8'))).toBe(false)
    expect((await refusal(() => svc.saveRules('h_pi_one', { rules: { ...RULES, harness: 'hermes' }, secrets, version: 3 }))).status).not.toBe(200)
  })

  it('takes one line about what the agent is for, and refuses anything that is not one line', async () => {
    expect(svc.create('pi-one', 'pi', '  Answers questions about the garden.  ').rules.persona).toMatchObject({ name: 'pi-one', description: 'Answers questions about the garden.' })
    for (const bad of ['line one\nline two', 'x'.repeat(601), 7, ['a']]) {
      expect((await refusal(() => svc.create('pi-two', 'pi', bad))).status, String(bad).slice(0, 12)).toBe(400)
    }
    expect(storage.read<unknown[]>('harnesses.json', [])).toHaveLength(1)
    // Left out, it is empty, as before.
    expect(svc.create('pi-three').rules.persona.description).toBe('')
  })
})

describe('what the page is told about the harness and who started the door', () => {
  it('names the harness and the one version that is pinned, and its limits', async () => {
    await filled()
    expect(svc.view('h_pi_one').harness).toMatchObject({ runtime: 'pi', label: 'Pi', version: '1.5.2', oneRoomOnly: false })
    svc.create('lc-one', 'letta-code')
    const lc = svc.view('h_lc_one').harness
    expect(lc).toMatchObject({ runtime: 'letta-code', label: 'Letta Code', version: '0.34.60', oneRoomOnly: true })
    expect(lc.limits.join('\n')).toMatch(/One room only/)
  })

  it('says nothing about who started a door that is stopped', async () => {
    await filled()
    expect(svc.status('h_pi_one').startedBy).toBeNull()
  })

  it('a door started from Swarm Map is said to be started from this page', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'page' })
  })

  it('forgets which process it started once that door is stopped, so a later door under the same pid is not taken for it', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(fs.existsSync(paths().startedByPage)).toBe(true)
    await svc.stop('h_pi_one')
    expect(fs.existsSync(paths().startedByPage)).toBe(false)
    // The same pid, started by something else.
    livePids = new Set([4242])
    writeState('run.json', JSON.stringify({ pid: 4242, project: 'smlab-fake0002', agentId: 'pi-one', policyHash: policyHashOf(RULES), startedAt: NOW.toISOString() }))
    expect(svc.status('h_pi_one').startedBy).toBe('elsewhere')
  })

  it('a door that is running under a process Swarm Map did not start is said to be under a supervisor, or started elsewhere', async () => {
    await filled()
    await svc.start('h_pi_one')
    // The door exits and something else starts it again, under another pid: Swarm Map did not start this one.
    livePids = new Set([5151])
    writeState('run.json', JSON.stringify({ pid: 5151, project: 'smlab-fake0001', agentId: 'pi-one', policyHash: policyHashOf(RULES), startedAt: NOW.toISOString() }))
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', pid: 5151, startedBy: 'elsewhere' })
    supervisorOf = (pid) => (pid === 5151 ? 'pm2' : undefined)
    expect(svc.status('h_pi_one').startedBy).toBe('supervisor')
    // A supervisor that restarts the very door the page started is still a supervisor.
    supervisorOf = () => 'pm2'
    livePids = new Set([4242])
    writeState('run.json', JSON.stringify({ pid: 4242, project: 'smlab-fake0000', agentId: 'pi-one', policyHash: policyHashOf(RULES), startedAt: NOW.toISOString() }))
    expect(svc.status('h_pi_one').startedBy).toBe('supervisor')
  })
})

describe('the fleet row', () => {
  it('is a real row with the runtime tag and the door\'s own status', async () => {
    await filled()
    expect(svc.list()).toEqual([expect.objectContaining({
      id: 'h_pi_one', name: 'pi-one', runtime: 'pi', status: 'stopped', platform: 'discord',
      models: ['provider/model-a'], health: { errors: 0 },
    })])
    await svc.start('h_pi_one')
    expect(svc.row('h_pi_one')?.status).toBe('running')
  })

  it('shows cost and invocations as unknown, never as zero', async () => {
    await filled()
    writeState('spend.json', JSON.stringify({ schema: 1, months: { '2026-11': 0 } }))
    const row = svc.row('h_pi_one')!
    expect(row.costToday).toBeNull()
    expect(row.invocations).toBeNull()
  })

  it('is not made from a row of any other runtime', () => {
    storage.write('harnesses.json', [{ id: 'h_a', name: 'a' }, { id: 'h_b', name: 'b', runtime: 'hermes' }, { id: 'h_c', name: 'c', runtime: 'some-other-runtime' }])
    expect(svc.list()).toEqual([])
    expect(svc.row('h_a')).toBeUndefined()
    expect(svc.row('h_c')).toBeUndefined()
  })

  it.each(['not json', '{}', '{"schema":1,"id":"h_pi_one"}', '{"schema":1,"id":"h_pi_one","name":"pi-one","rules":{"persona":null}}'])(
    'still lists a door row whose record is damaged (%s), and refuses to act on it',
    async (content) => {
      svc.create('pi-one')
      fs.writeFileSync(paths().record, content)
      expect(svc.list()).toEqual([expect.objectContaining({ id: 'h_pi_one', name: 'pi-one', runtime: 'pi', status: 'stopped' })])
      expect((await refusal(() => svc.view('h_pi_one'))).status).toBe(404)
      expect((await refusal(() => svc.start('h_pi_one'))).status).toBe(404)
      expect(calls).toEqual([])
    },
  )

  it('still lists a door row whose record is missing, as stopped', () => {
    storage.write('harnesses.json', [{ id: 'h_lost', name: 'lost', runtime: 'pi' }])
    expect(svc.list()).toEqual([expect.objectContaining({ id: 'h_lost', runtime: 'pi', status: 'stopped', costToday: null })])
  })
})

describe('status', () => {
  it('is stopped, with the seal not yet checked, before anything has run', async () => {
    await filled()
    expect(svc.status('h_pi_one')).toEqual({ state: 'stopped', cellSealed: null, rulesInForce: null, startedBy: null })
  })

  it('says when a second cell, with no shell or file tools, holds the channels with fewer tools; with one channel there is none', async () => {
    await filled()
    expect(svc.status('h_pi_one').secondCell).toBeUndefined()
    const other = '100000000000000009'
    const rules = {
      ...RULES, tools: { enabled: ['shell', 'file_read'], approvalSeconds: 60 },
      discord: { ...RULES.discord, channelIds: [RULES.discord.channelId, other], perChannel: { [other]: { anyoneInChannel: false, tools: 'web-only' } } },
    }
    await svc.saveRules('h_pi_one', { rules, secrets, version: 2 })
    // Stopped: what the rules on record would start.
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'stopped', secondCell: { channels: 1 } })
    // Running: what the run has.
    livePids = new Set([4242])
    writeState('run.json', JSON.stringify({ pid: 4242, project: 'smlab-fake0000', reducedProject: 'smlab-fake0001', agentId: 'pi-one', policyHash: policyHashOf(rules), startedAt: NOW.toISOString() }))
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', secondCell: { channels: 1 } })
    writeState('run.json', JSON.stringify({ pid: 4242, project: 'smlab-fake0000', agentId: 'pi-one', policyHash: policyHashOf(rules), startedAt: NOW.toISOString() }))
    expect(svc.status('h_pi_one').secondCell).toBeUndefined()
  })

  it('is running only while the door\'s own process is alive', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', pid: 4242, startedAt: NOW.toISOString(), cellSealed: true, rulesInForce: true })
    livePids.clear() // the door died without cleaning up: run.json is still there
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'stopped', rulesInForce: null })
  })

  it('says when the running door was started from other rules than the ones on record', async () => {
    await filled()
    await svc.start('h_pi_one')
    const runFile = path.join(paths().stateDir, 'run.json')
    fs.writeFileSync(runFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(runFile, 'utf8')), policyHash: 'the-hash-of-older-rules' }))
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', rulesInForce: false })
  })

  it('says the cell is not sealed after a dry run that failed', async () => {
    await filled()
    dryRunResult = NOT_SEALED
    await refusal(() => svc.start('h_pi_one'))
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'stopped', cellSealed: false, sealCheckedAt: NOW.toISOString() })
  })

  it('says the cell is sealed when only the secret files were missing', async () => {
    await filled()
    dryRunResult = NO_SECRETS
    await refusal(() => svc.start('h_pi_one'))
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'stopped', cellSealed: true })
  })
})

describe('start', () => {
  it('is refused before any dry run when a secret file is somewhere it must not be', async () => {
    await filled()
    fs.chmodSync(secrets.discordTokenFile, 0o644)
    calls.length = 0
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.status).toBe(422)
    expect(err.details?.join('\n')).toMatch(/bot token file points at a file others can read/)
    expect(calls).toEqual([])
    expect(svc.status('h_pi_one').state).toBe('stopped')
  })

  it('runs the dry run first, and starts the door only after it', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(calls).toEqual(['dryRun config.json', 'start start.sh'])
  })

  it.each([
    ['the cell is not sealed', NOT_SEALED],
    ['the secret files are missing', NO_SECRETS],
    ['the dry run never finished', { code: null, output: '' }],
    ['the exit code is 0 but the result line is missing', { code: 0, output: 'something else\n' }],
  ])('refuses when %s, and starts nothing', async (_what, result) => {
    await filled()
    dryRunResult = result
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.status).toBe(422)
    expect(calls).toEqual(['dryRun config.json'])
    expect(svc.status('h_pi_one').state).toBe('stopped')
  })

  it('is refused before any dry run when the Node the start script names cannot be used, and the page is told why', async () => {
    await filled()
    nodeProblem = 'Node was not found at /fake/node, or it cannot be run.'
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.status).toBe(422)
    expect(err.message).toBe('Not started. Node cannot be used to run the door')
    expect(err.details).toEqual([nodeProblem])
    expect(calls).toEqual([])
    const view = svc.view('h_pi_one')
    expect(view.dryRun).toEqual({ at: NOW.toISOString(), result: 'node-unusable', lines: [`FAIL  ${nodeProblem}`] })
    // Nothing was learned about the cell, so the seal is not reported either way.
    expect(view.status).toEqual({ state: 'stopped', cellSealed: null, rulesInForce: null, startedBy: null })
  })

  it('starts again once that Node is back, on a start script written with the path it names now', async () => {
    await filled()
    nodeProblem = 'gone'
    await refusal(() => svc.start('h_pi_one'))
    nodeProblem = undefined
    await svc.start('h_pi_one')
    expect(calls).toEqual(['dryRun config.json', 'start start.sh'])
    expect(fs.readFileSync(paths().startScript, 'utf8')).toContain("exec '/fake/node' ")
    expect(svc.view('h_pi_one').dryRun?.result).toBe('ready')
  })

  it('on a running door: a save is refused, and the door keeps running, when Node cannot be used', async () => {
    await filled()
    await svc.start('h_pi_one')
    calls = []
    nodeProblem = 'gone'
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: { ...RULES, budget: { monthlyUsd: 9 } }, secrets, version: 2 }))
    expect(err.status).toBe(422)
    expect(err.details).toEqual(['gone'])
    expect(calls).toEqual([])
    expect(svc.status('h_pi_one').state).toBe('running')
    expect(svc.view('h_pi_one').record.version).toBe(2)
  })

  it('says which checks failed', async () => {
    await filled()
    dryRunResult = NOT_SEALED
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.details).toEqual(['FAIL  S1   only the door answers', 'RESULT: not ready. The cell is not shown to be sealed.'])
  })

  it('refuses a draft without running anything', async () => {
    svc.create('pi-one')
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.status).toBe(422)
    expect(calls).toEqual([])
  })

  it('refuses an agent that is already running', async () => {
    await filled()
    await svc.start('h_pi_one')
    calls.length = 0
    expect((await refusal(() => svc.start('h_pi_one'))).status).toBe(409)
    expect(calls).toEqual([])
  })

  it('refuses a second start while the first is still checking', async () => {
    await filled()
    const first = svc.start('h_pi_one')
    expect((await refusal(() => svc.start('h_pi_one'))).status).toBe(409)
    await first
    expect(calls).toEqual(['dryRun config.json', 'start start.sh'])
  })

  it('writes the config and the start script again from the record, over anything edited by hand', async () => {
    await filled()
    fs.writeFileSync(paths().config, '{"agentId":"edited-by-hand"}')
    fs.writeFileSync(paths().startScript, 'echo edited by hand')
    await svc.start('h_pi_one')
    expect(parseConfig(JSON.parse(fs.readFileSync(paths().config, 'utf8'))).config).toEqual(parseConfig(RULES).config)
    const script = fs.readFileSync(paths().startScript, 'utf8')
    expect(script).toContain(`exec '/fake/node' '/fake/repo/lib/lab/pi-discord/cli.ts' start --config '${paths().config}'`)
    expect(script).toContain(`export SMLAB_STATE_DIR='${paths().stateDir}'`)
    expect(fs.statSync(paths().startScript).mode & 0o777).toBe(0o700)
  })

  it('keeps the script it needs under the data folder', async () => {
    await filled()
    expect(paths().startScript.startsWith(dataDir + path.sep)).toBe(true)
    expect(svc.view('h_pi_one').supervisor.command).toContain(`pm2 start '${paths().startScript}'`)
  })
})

describe('stop', () => {
  it('asks the launcher to stop the door', async () => {
    await filled()
    await svc.start('h_pi_one')
    await svc.stop('h_pi_one')
    expect(calls.at(-1)).toBe('stop')
    expect(svc.status('h_pi_one').state).toBe('stopped')
  })

  it('asks even when the door looks stopped, so a cell left behind is removed', async () => {
    await filled()
    await svc.stop('h_pi_one')
    expect(calls).toEqual(['stop'])
  })
})

describe('saving the rules', () => {
  const edited = { ...RULES, discord: { ...RULES.discord, botLoopLimit: 2 } }

  it('stores the record and renders the config when the door is stopped, with no dry run', async () => {
    const { record, applied } = await filled()
    expect(applied).toBe('stored')
    expect(record.version).toBe(2)
    expect(calls).toEqual([])
    expect(parseConfig(JSON.parse(fs.readFileSync(paths().config, 'utf8'))).config).toEqual(parseConfig(RULES).config)
  })

  it('refuses rules the launcher refuses, and stores nothing', async () => {
    await filled()
    const before = fs.readFileSync(paths().record, 'utf8')
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: { ...RULES, budget: { monthlyUsd: -1 } }, secrets, version: 2 }))
    expect(err.status).toBe(422)
    expect(err.details?.join('\n')).toMatch(/budget\.monthlyUsd/)
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
  })

  it('refuses an edit made from an older version', async () => {
    await filled()
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 1 }))
    expect(err.status).toBe(409)
    expect(svc.view('h_pi_one').record.rules.discord.botLoopLimit).toBe(4)
  })

  it('with search on, every dry run is handed the search key file, as the start script is: on start and on a save to a running door', async () => {
    const searchKeyFile = path.join(tmp, 'keys', 'search')
    fs.writeFileSync(searchKeyFile, 'FAKE-SEARCH-KEY-3\n', { mode: 0o600 })
    const withSearch = { ...secrets, searchKeyFile }
    const tools = { enabled: [], mode: {}, approvalSeconds: 120, web: { allow: ['en.wikipedia.org'], search: true } }
    svc.create('pi-one')
    await svc.saveRules('h_pi_one', { rules: { ...RULES, tools }, secrets: withSearch, version: 1 })
    await svc.start('h_pi_one')
    await svc.saveRules('h_pi_one', { rules: { ...RULES, tools, discord: { ...RULES.discord, botLoopLimit: 2 } }, secrets: withSearch, version: 2 })
    expect(calls.filter((c) => c.startsWith('dryRun'))).toEqual(['dryRun config.json', 'dryRun config.next.json'])
    for (const env of dryRunEnvs) expect(env.SMLAB_SEARCH_KEY_FILE).toBe(searchKeyFile)
  })

  it('with no search key file, the dry run is handed none', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(dryRunEnvs.map((e) => 'SMLAB_SEARCH_KEY_FILE' in e)).toEqual([false])
  })

  it('on a running door: dry-runs the new rules, then stops and starts it on them', async () => {
    await filled()
    await svc.start('h_pi_one')
    calls.length = 0
    const { applied } = await svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 })
    expect(applied).toBe('restarted')
    expect(calls).toEqual(['dryRun config.next.json', 'stop', 'start start.sh'])
    expect(JSON.parse(fs.readFileSync(paths().config, 'utf8')).discord.botLoopLimit).toBe(2)
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', rulesInForce: true })
    expect(fs.existsSync(paths().candidateConfig)).toBe(false)
  })

  it('on a running door: a failed dry run changes nothing and leaves it running on the old rules', async () => {
    await filled()
    await svc.start('h_pi_one')
    calls.length = 0
    const before = fs.readFileSync(paths().record, 'utf8')
    const configBefore = fs.readFileSync(paths().config, 'utf8')
    dryRunResult = NOT_SEALED
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(422)
    expect(calls).toEqual(['dryRun config.next.json'])
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
    expect(fs.readFileSync(paths().config, 'utf8')).toBe(configBefore)
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', rulesInForce: true })
    expect(fs.existsSync(paths().candidateConfig)).toBe(false)
  })

  it('on a running door: new secret paths that must not be used change nothing, with no dry run', async () => {
    await filled()
    await svc.start('h_pi_one')
    calls.length = 0
    const before = fs.readFileSync(paths().record, 'utf8')
    const link = path.join(tmp, 'keys', 'link')
    fs.symlinkSync(secrets.modelKeyFile, link)
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets: { ...secrets, modelKeyFile: link }, version: 2 }))
    expect(err.status).toBe(422)
    expect(err.details?.join('\n')).toMatch(/model key file points at a link/)
    expect(calls).toEqual([])
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
    expect(svc.status('h_pi_one').state).toBe('running')
  })

  it('on a running door that cannot be stopped: stores nothing, so the record and the running door stay in step', async () => {
    await filled()
    await svc.start('h_pi_one')
    const before = fs.readFileSync(paths().record, 'utf8')
    const configBefore = fs.readFileSync(paths().config, 'utf8')
    stopFails = true
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(500)
    expect(err.message).toMatch(/^Not saved/)
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
    expect(fs.readFileSync(paths().config, 'utf8')).toBe(configBefore)
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', rulesInForce: true })
  })

  it('says so when the rules were saved but the door did not come back', async () => {
    await filled()
    await svc.start('h_pi_one')
    startFails = 'the cell did not reach the door in time'
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(500)
    expect(err.message).toMatch(/saved/)
    expect(svc.view('h_pi_one').record.version).toBe(3)
  })
})

describe('a door under a supervisor', () => {
  const edited = { ...RULES, discord: { ...RULES.discord, botLoopLimit: 2 } }
  // The door as pm2 runs it: an app for this agent's start script, and the door it started.
  const underPm2 = async () => {
    await filled()
    pm2Apps = [{ id: 7, name: 'door-pi-one', script: paths().startScript, pid: 6262 }]
    livePids = new Set([6262])
    writeState('run.json', JSON.stringify({ pid: 6262, project: 'smlab-fake6262', agentId: 'pi-one', policyHash: policyHashOf(RULES), startedAt: NOW.toISOString() }))
    calls.length = 0
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'supervisor' })
  }
  // How many doors are up: every live pid is one door process.
  const doors = () => livePids.size

  it('a save restarts it through pm2, on the new rules, and starts nothing beside it', async () => {
    await underPm2()
    const result = await svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 })
    expect(result).toMatchObject({ applied: 'restarted', by: 'supervisor', supervisor: 'door-pi-one' })
    expect(calls).toEqual(['dryRun config.next.json', 'stop', 'pm2 restart door-pi-one'])
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'supervisor', rulesInForce: true })
    expect(doors()).toBe(1)
    // pm2 is asked about the door that is running now, by its pid.
    expect(pm2Asked).toContain(6262)
    expect(fs.existsSync(paths().startedByPage)).toBe(false)
  })

  it('a save is refused before anything is stopped when pm2 cannot be asked', async () => {
    await underPm2()
    const before = fs.readFileSync(paths().record, 'utf8')
    pm2Unknown = 'pm2 runs on this machine, but did not answer'
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/^Not saved/)
    expect(err.message).toContain('did not answer')
    expect(calls).toEqual([])
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'supervisor' })
  })

  it('a save is refused when the door runs under pm2 but pm2 lists no app for it', async () => {
    await underPm2()
    pm2Apps = []
    supervisorOf = (pid) => (pid === 6262 ? 'pm2' : undefined)
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(409)
    expect(calls).toEqual([])
    expect(doors()).toBe(1)
  })

  it('says so when the rules were saved but pm2 did not bring the door back', async () => {
    await underPm2()
    pm2RestartFails = 'pm2 did not restart door-pi-one'
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(500)
    expect(err.message).toMatch(/rules were saved/)
    expect(err.message).toContain('pm2 restart door-pi-one')
    expect(calls).toEqual(['dryRun config.next.json', 'stop', 'pm2 restart door-pi-one'])
    expect(calls).not.toContain('start start.sh')
  })

  it('start is handed to pm2 when pm2 has an app for this agent, even a stopped one, so no second door is started beside it', async () => {
    await underPm2()
    await svc.stop('h_pi_one')
    expect(doors()).toBe(0)
    calls.length = 0
    const result = await svc.start('h_pi_one')
    expect(result).toEqual({ by: 'supervisor', supervisor: 'door-pi-one' })
    expect(calls).toEqual(['dryRun config.json', 'pm2 restart door-pi-one'])
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'supervisor' })
    expect(doors()).toBe(1)
  })

  it('start is refused before the dry run when pm2 cannot be asked', async () => {
    await filled()
    pm2Unknown = 'pm2 runs on this machine, but did not answer'
    const err = await refusal(() => svc.start('h_pi_one'))
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/^Not started/)
    expect(calls).toEqual([])
    expect(doors()).toBe(0)
  })

  it('start with no pm2 app is the page\'s own background process, as before', async () => {
    await filled()
    expect(await svc.start('h_pi_one')).toEqual({ by: 'page' })
    expect(calls).toEqual(['dryRun config.json', 'start start.sh'])
  })

  it('stop goes through the launcher, and pm2 leaves the door stopped', async () => {
    await underPm2()
    await svc.stop('h_pi_one')
    expect(calls).toEqual(['stop'])
    expect(svc.status('h_pi_one').state).toBe('stopped')
    expect(pm2Apps[0].pid).toBeNull()
  })
})

describe('a save whose stop ended the door but reported a failure', () => {
  const edited = { ...RULES, discord: { ...RULES.discord, botLoopLimit: 2 } }

  it('starts the door again on the rules it had, and stores nothing', async () => {
    await filled()
    await svc.start('h_pi_one')
    const before = fs.readFileSync(paths().record, 'utf8')
    calls.length = 0
    stopKillsButFails = true
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(500)
    expect(err.message).toMatch(/^Not saved/)
    expect(err.message).toMatch(/started again on the rules it had/)
    expect(calls).toEqual(['dryRun config.next.json', 'stop', 'start start.sh'])
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(before)
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', rulesInForce: true })
  })

  it('under pm2, has pm2 start it again on the rules it had', async () => {
    await filled()
    pm2Apps = [{ id: 7, name: 'door-pi-one', script: paths().startScript, pid: 6262 }]
    livePids = new Set([6262])
    writeState('run.json', JSON.stringify({ pid: 6262, project: 'smlab-fake6262', agentId: 'pi-one', policyHash: policyHashOf(RULES), startedAt: NOW.toISOString() }))
    calls.length = 0
    stopKillsButFails = true
    const err = await refusal(() => svc.saveRules('h_pi_one', { rules: edited, secrets, version: 2 }))
    expect(err.status).toBe(500)
    expect(calls).toEqual(['dryRun config.next.json', 'stop', 'pm2 restart door-pi-one'])
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', startedBy: 'supervisor', rulesInForce: true })
    expect(livePids.size).toBe(1)
  })
})

describe('receipts', () => {
  const receipt = (n: number, verdict: string, rule: string, why: string) =>
    JSON.stringify({ ts: `2026-11-16T10:00:0${n}.000Z`, agentId: 'pi-one', policyHash: 'h', event: { kind: 'inbound', room: '100000000000000001' }, verdict, rule, why })

  it('are the door\'s decisions, newest first, each with its plain reason', async () => {
    await filled()
    writeState('receipts.jsonl', [
      receipt(1, 'deliver', 'addr.mention', 'A listed person mentioned the bot.'),
      receipt(2, 'drop', 'adm.users', 'The sender is not on the list.'),
      receipt(3, 'deny', 'budget.cap', 'The month\'s budget is spent.'),
    ].join('\n') + '\n')
    const got = svc.receipts('h_pi_one', 2)
    expect(got.map((r) => r.rule)).toEqual(['budget.cap', 'adm.users'])
    expect(got[0].why).toBe('The month\'s budget is spent.')
  })

  it('skip a line that is not a receipt, and are empty before the first decision', async () => {
    await filled()
    expect(svc.receipts('h_pi_one', 20)).toEqual([])
    writeState('receipts.jsonl', `not json\n${receipt(1, 'drop', 'adm.rooms', 'Not the allowed channel.')}\n{"half":`)
    expect(svc.receipts('h_pi_one', 20).map((r) => r.rule)).toEqual(['adm.rooms'])
  })
})

describe('receipts that are not what the door writes', () => {
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({ ts: '2026-11-16T10:00:01.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'inbound' }, verdict: 'drop', rule: 'adm.users', why: 'The sender is not on the list.', ...over })

  it('hand a page only text and numbers, whatever a line holds', async () => {
    await filled()
    writeState('receipts.jsonl', [
      line({ note: { html: '<img src=x onerror=alert(1)>' } }),
      line({ event: { kind: { nested: true }, room: ['x'], bytes: 'many' } }),
      line({ event: { kind: 'inbound', bytes: 12 }, note: 'count 3', extra: { anything: true } }),
    ].join('\n') + '\n')
    const got = svc.receipts('h_pi_one', 20)
    for (const r of got) {
      for (const v of [r.ts, r.verdict, r.rule, r.why, r.event.kind]) expect(typeof v).toBe('string')
      for (const v of [r.note, r.event.room, r.event.sender, r.event.messageId]) expect(['string', 'undefined']).toContain(typeof v)
      expect(['number', 'undefined']).toContain(typeof r.event.bytes)
      expect(Object.keys(r)).not.toContain('extra')
    }
    expect(got[0]).toMatchObject({ note: 'count 3', event: { kind: 'inbound', bytes: 12 } })
  })

  it('are read from the end of a large file, not the whole of it', async () => {
    await filled()
    const old = line({ rule: 'old.rule' }) + '\n'
    writeState('receipts.jsonl', old.repeat(Math.ceil((5 * 1024 * 1024) / old.length)) + line({ rule: 'new.rule' }) + '\n')
    const read = vi.spyOn(fs, 'readFileSync')
    const got = svc.receipts('h_pi_one', 500)
    expect(read.mock.calls.some(([file]) => String(file).endsWith('receipts.jsonl'))).toBe(false)
    read.mockRestore()
    expect(got).toHaveLength(500)
    expect(got[0].rule).toBe('new.rule')
  })

  it('and the log is read from its end too', async () => {
    await filled()
    fs.writeFileSync(paths().log, 'old line\n'.repeat(600_000) + 'the last line\n')
    const read = vi.spyOn(fs, 'readFileSync')
    const got = svc.logs('h_pi_one', 2)
    expect(read.mock.calls.some(([file]) => String(file).endsWith('door.log'))).toBe(false)
    read.mockRestore()
    expect(got).toBe('old line\nthe last line')
  })
})

describe('usage', () => {
  it('reads the month\'s spend from the door\'s ledger, against the budget', async () => {
    await filled()
    writeState('spend.json', JSON.stringify({ schema: 1, months: { '2026-10': 4, '2026-11': 1.25 } }))
    expect(svc.usage('h_pi_one')).toEqual({ month: '2026-11', spentThisMonthUsd: 1.25, budgetMonthlyUsd: 5, costToday: null, invocations: null })
  })

  it('is unknown, not zero, when there is no ledger yet', async () => {
    await filled()
    expect(svc.usage('h_pi_one').spentThisMonthUsd).toBeNull()
  })

  it.each(['not json', '{"schema":2,"months":{}}', '{"schema":1,"months":{"2026-11":"lots"}}'])('is unknown when the ledger cannot be read: %s', async (content) => {
    await filled()
    writeState('spend.json', content)
    expect(svc.usage('h_pi_one').spentThisMonthUsd).toBeNull()
  })

  it('is a real zero when the ledger has other months but nothing this month', async () => {
    await filled()
    writeState('spend.json', JSON.stringify({ schema: 1, months: { '2026-10': 4 } }))
    expect(svc.usage('h_pi_one').spentThisMonthUsd).toBe(0)
  })
})

describe('logs', () => {
  it('are the tail of the door\'s own log', async () => {
    await filled()
    fs.writeFileSync(paths().log, 'one\ntwo\nthree\n')
    expect(svc.logs('h_pi_one', 2)).toBe('two\nthree')
    expect(svc.logs('h_pi_one', 0)).toBe('one\ntwo\nthree')
  })
})

describe('what a page is given', () => {
  it('has the record with the two paths, and never what the files hold', async () => {
    await filled()
    await svc.start('h_pi_one')
    const text = JSON.stringify([svc.view('h_pi_one'), svc.list(), svc.receipts('h_pi_one', 50), svc.logs('h_pi_one', 500)])
    expect(text).toContain(secrets.discordTokenFile)
    expect(text).not.toMatch(/FAKE-TOKEN-VALUE-1|FAKE-KEY-VALUE-22/)
    for (const file of fs.readdirSync(paths().dir, { recursive: true }) as string[]) {
      const full = path.join(paths().dir, file)
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8'), file).not.toMatch(/FAKE-TOKEN-VALUE-1|FAKE-KEY-VALUE-22/)
    }
    expect(fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8')).not.toMatch(/FAKE-|keys\//)
  })

  it('lists what still stands between a draft and a start', () => {
    svc.create('pi-one')
    const view = svc.view('h_pi_one')
    expect(view.problems.rules.length).toBeGreaterThan(0)
    expect(view.problems.secrets).toHaveLength(2)
  })
})

describe('removing', () => {
  it('stops the door, then forgets the record and the row, and leaves the secret files', async () => {
    storage.write('harnesses.json', [{ id: 'h_other', name: 'other' }])
    await filled()
    await svc.start('h_pi_one')
    calls.length = 0
    await svc.remove('h_pi_one')
    expect(calls).toEqual(['stop'])
    expect(fs.existsSync(paths().dir)).toBe(false)
    expect(storage.read('harnesses.json', [])).toEqual([{ id: 'h_other', name: 'other' }])
    expect(fs.existsSync(secrets.discordTokenFile)).toBe(true)
  })

  it('keeps everything when the door could not be stopped', async () => {
    await filled()
    await svc.start('h_pi_one')
    const launcher = (svc as unknown as { launcher: DoorLauncher }).launcher
    launcher.stop = async () => ({ ok: false, output: 'these containers are still there' })
    expect((await refusal(() => svc.remove('h_pi_one'))).status).toBe(500)
    expect(fs.existsSync(paths().record)).toBe(true)
    expect(svc.row('h_pi_one')).toBeDefined()
  })
})

describe('an id that is not a door agent', () => {
  it.each(['start', 'stop', 'status', 'usage', 'view', 'remove'] as const)('%s refuses it', async (verb) => {
    storage.write('harnesses.json', [{ id: 'h_alpha', name: 'alpha' }])
    const err = await refusal(() => (svc[verb] as (id: string) => unknown)('h_alpha'))
    expect(err.status).toBe(404)
    expect(calls).toEqual([])
  })
})
