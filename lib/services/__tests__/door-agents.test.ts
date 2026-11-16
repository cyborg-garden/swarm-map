// @vitest-environment node
/**
 * DoorAgentService: one door agent as a fleet row, driven through a launcher.
 *
 * Everything here is fake. The data folder is a scratch folder, the door's
 * state folder is written by the test, and the launcher is a stub that
 * records what it was asked. No Docker, no chat platform, no model, no secret.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
let dryRunResult: { code: number | null; output: string }
let startFails: string | undefined
let livePids: Set<number>
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
    async dryRun(o) {
      calls.push(`dryRun ${path.basename(o.configPath)}`)
      // The stub proves what the real launcher would be handed: paths, never a secret.
      expect(Object.keys(o.env).sort()).toEqual(['SMLAB_DISCORD_TOKEN_FILE', 'SMLAB_MODEL_KEY_FILE', 'SMLAB_STATE_DIR'])
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
      livePids.clear()
      fs.rmSync(path.join(o.stateDir, 'run.json'), { force: true })
      return { ok: true, output: 'stopped' }
    },
    alive: (pid) => livePids.has(pid),
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
  calls = []
  dryRunResult = READY
  startFails = undefined
  livePids = new Set()
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

  it('refuses a runtime that has no launcher yet', async () => {
    expect((await refusal(() => svc.create('lc-one', 'letta-code'))).status).toBe(400)
    expect(storage.read('harnesses.json', [])).toEqual([])
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

  it('still lists a door row whose record is missing, as stopped', () => {
    storage.write('harnesses.json', [{ id: 'h_lost', name: 'lost', runtime: 'pi' }])
    expect(svc.list()).toEqual([expect.objectContaining({ id: 'h_lost', runtime: 'pi', status: 'stopped', costToday: null })])
  })
})

describe('status', () => {
  it('is stopped, with the seal not yet checked, before anything has run', async () => {
    await filled()
    expect(svc.status('h_pi_one')).toEqual({ state: 'stopped', cellSealed: null, rulesInForce: null })
  })

  it('is running only while the door\'s own process is alive', async () => {
    await filled()
    await svc.start('h_pi_one')
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'running', pid: 4242, startedAt: NOW.toISOString(), cellSealed: true, rulesInForce: true })
    livePids.clear() // the door died without cleaning up: run.json is still there
    expect(svc.status('h_pi_one')).toMatchObject({ state: 'stopped', rulesInForce: null })
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
