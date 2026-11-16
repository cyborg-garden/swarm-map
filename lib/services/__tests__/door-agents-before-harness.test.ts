// @vitest-environment node
/**
 * A door agent that was made, saved and started before the harness was a
 * setting. Its files are in fixtures/door-agent-before-harness, written by
 * the code as it was then: the record, the launcher's config, the start
 * script, the fleet file, the last dry run, and the run on record.
 *
 * Nothing is migrated. This shows that nothing needs to be: the files are
 * read as they are, the agent is listed and reported as it was, and what is
 * rendered from the old record is, byte for byte, what was rendered then.
 * So the running door's rules are still the rules in force.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DoorAgentService } from '../door-agents'
import type { DoorLauncher } from '../door-launcher'
import { doorAgentPaths, renderConfig, renderStartScript, type DoorRulesRecord } from '../door-record'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import { harnessOf, parseConfig, policyFor } from '@/lib/lab/pi-discord/config'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'door-agent-before-harness')
const ID = 'h_pi_one'
const OLD_PID = 4242

let tmp: string
let dataDir: string
let calls: string[]
let livePids: Set<number>
let svc: DoorAgentService

/** A fixture as it was written then, with the folder it was written under put back. */
const old = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('__TMP__').join(tmp)
const paths = () => doorAgentPaths(dataDir, ID)
const launcherCommand = { node: '/fake/node', cli: '/fake/repo/lib/lab/pi-discord/cli.ts' }

function stubLauncher(): DoorLauncher {
  return {
    command: () => launcherCommand,
    nodeProblem: () => undefined,
    async dryRun(o) { calls.push(`dryRun ${path.basename(o.configPath)}`); return { code: 0, output: 'RESULT: ready to start.\n' } },
    async start(o) {
      calls.push('start')
      const config = JSON.parse(fs.readFileSync(paths().config, 'utf8'))
      fs.writeFileSync(path.join(o.stateDir, 'run.json'), JSON.stringify({ pid: 5151, project: 'smlab-0badf00e', agentId: 'pi-one', policyHash: policyFor(parseConfig(config).config!).hash, startedAt: '2026-11-16T12:00:00.000Z' }))
      livePids = new Set([5151])
    },
    async stop(o) { calls.push('stop'); livePids.clear(); fs.rmSync(path.join(o.stateDir, 'run.json'), { force: true }); return { ok: true, output: 'stopped' } },
    alive: (pid) => livePids.has(pid),
    supervisor: () => undefined,
  }
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-old-record-')))
  dataDir = path.join(tmp, 'data')
  for (const dir of [paths().stateDir, path.join(tmp, 'repo'), path.join(tmp, 'keys')]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'keys', 'token'), 'FAKE-TOKEN-VALUE-1\n', { mode: 0o600 })
  fs.writeFileSync(path.join(tmp, 'keys', 'key'), 'FAKE-KEY-VALUE-22\n', { mode: 0o600 })
  // The data folder as that code left it, with its door running.
  fs.writeFileSync(path.join(dataDir, 'harnesses.json'), old('harnesses.json'))
  fs.writeFileSync(paths().record, old('record.json'))
  fs.writeFileSync(paths().config, old('config.json'))
  fs.writeFileSync(paths().startScript, old('start.sh'))
  fs.writeFileSync(paths().dryRun, old('dry-run.json'))
  fs.writeFileSync(path.join(paths().stateDir, 'run.json'), old('run.json'))
  calls = []
  livePids = new Set([OLD_PID])
  const storage = new Storage(dataDir)
  svc = new DoorAgentService({
    storage, audit: new AuditService(storage), dataDir, launcher: stubLauncher(),
    repoRoot: path.join(tmp, 'repo'), now: () => new Date('2026-11-16T12:00:00Z'), nameTaken: () => false,
  })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('a door agent from before the harness was a setting', () => {
  it('the fixtures are what that code wrote: schema 1, runtime pi, and no harness named anywhere', () => {
    const record = JSON.parse(old('record.json'))
    expect(record).toMatchObject({ schema: 1, id: ID, name: 'pi-one', runtime: 'pi', version: 2 })
    expect(old('record.json') + old('config.json') + old('start.sh')).not.toMatch(/harness/)
    expect(JSON.parse(old('run.json'))).toMatchObject({ pid: OLD_PID, policyHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('is listed and reported as it was: a running Pi agent, on the rules on record, with its seal checked', () => {
    expect(svc.list()).toEqual([expect.objectContaining({ id: ID, name: 'pi-one', runtime: 'pi', status: 'running', channel: '100000000000000001' })])
    const view = svc.view(ID)
    expect(view.record).toEqual(JSON.parse(old('record.json')))
    expect(view.status).toEqual({
      state: 'running', pid: OLD_PID, startedAt: '2026-11-01T12:00:00.000Z', cellSealed: true, sealCheckedAt: '2026-11-01T12:00:00.000Z',
      // The old door's rules are still the rules in force: the same rules still hash to what it was started with.
      rulesInForce: true,
      // That code kept no note of what it started, so this page cannot say it started this door.
      startedBy: 'elsewhere',
    })
    expect(view.problems).toEqual({ rules: [], secrets: [] })
    expect(view.harness).toMatchObject({ runtime: 'pi', label: 'Pi', oneRoomOnly: false })
  })

  it('the old config is read by the launcher as a Pi config, to the same policy the old door runs on', () => {
    const { config, errors } = parseConfig(JSON.parse(old('config.json')))
    expect(errors).toEqual([])
    expect(harnessOf(config!)).toBe('pi')
    expect(policyFor(config!).hash).toBe(JSON.parse(old('run.json')).policyHash)
  })

  it('what is rendered from the old record is byte for byte what was rendered then', () => {
    const record = JSON.parse(old('record.json')) as DoorRulesRecord
    expect(renderConfig(record)).toBe(old('config.json'))
    expect(renderStartScript(record, { ...launcherCommand, configPath: paths().config, stateDir: paths().stateDir })).toBe(old('start.sh'))
  })

  it('is stopped by the same launcher call, and started again from files that are the old ones unchanged', async () => {
    await svc.stop(ID)
    expect(calls).toEqual(['stop'])
    expect(svc.status(ID)).toMatchObject({ state: 'stopped', startedBy: null })
    await svc.start(ID)
    expect(calls).toEqual(['stop', 'dryRun config.json', 'start'])
    expect(fs.readFileSync(paths().config, 'utf8')).toBe(old('config.json'))
    expect(fs.readFileSync(paths().startScript, 'utf8')).toBe(old('start.sh'))
    // The record itself was not touched by the stop and the start.
    expect(fs.readFileSync(paths().record, 'utf8')).toBe(old('record.json'))
    expect(svc.status(ID)).toMatchObject({ state: 'running', rulesInForce: true, startedBy: 'page' })
  })

  it('a save of the same rules keeps the record\'s shape: the next version, the same keys, and still no harness', async () => {
    const before = JSON.parse(old('record.json')) as DoorRulesRecord
    const { record, applied } = await svc.saveRules(ID, { rules: before.rules, secrets: before.secrets, version: before.version })
    expect(applied).toBe('restarted')
    expect(record).toEqual({ ...before, version: before.version + 1, updatedAt: '2026-11-16T12:00:00.000Z' })
    expect(Object.keys(record)).toEqual(Object.keys(before))
    expect(fs.readFileSync(paths().config, 'utf8')).toBe(old('config.json'))
    expect(svc.status(ID).rulesInForce).toBe(true)
  })
})
