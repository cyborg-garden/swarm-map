// @vitest-environment node
/**
 * The launcher adapter, run for real against a stand-in command.
 *
 * The stand-in is a small script written by this test. It answers `dry-run`,
 * `start` and `stop` the way the lab's command does (exit codes, a run
 * record, a clean exit on stop) and touches no Docker, no chat platform and
 * no model. What is checked is the plumbing around it: what the child is
 * handed, where its output goes, and how a running door is recognised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createCliLauncher, type DoorLauncher } from '../door-launcher'

const STAND_IN = `
import fs from 'node:fs'
import path from 'node:path'
const [cmd] = process.argv.slice(2)
const dir = process.env.SMLAB_STATE_DIR ?? ''
const run = path.join(dir, 'run.json')
if (cmd === 'dry-run') {
  console.log('ENV ' + Object.keys(process.env).sort().join(','))
  console.error('  FAIL  S1   a line on stderr')
  console.log('RESULT: the cell is sealed, but the secret files are not in place yet.')
  process.exit(3)
} else if (cmd === 'start') {
  if (process.env.STAND_IN_FAILS) { console.log('start: refused'); process.exit(1) }
  fs.writeFileSync(run, JSON.stringify({ pid: process.pid }))
  console.log('cell up and sealed')
  process.on('SIGTERM', () => { fs.rmSync(run, { force: true }); process.exit(0) })
  setInterval(() => {}, 1000)
} else if (cmd === 'stop') {
  try { process.kill(JSON.parse(fs.readFileSync(run, 'utf8')).pid, 'SIGTERM') } catch { process.exit(1) }
  await new Promise((r) => setTimeout(r, 300))
  process.exit(0)
}
`

let tmp: string
let launcher: DoorLauncher
let stateDir: string
let startScript: string
let logPath: string
let started: number | undefined
const saved = { launcher: process.env.SWARM_MAP_DOOR_LAUNCHER, token: process.env.HSM_OPERATOR_TOKEN, node: process.env.SWARM_MAP_NODE }

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-launcher-')))
  // The adapter recognises a door by its command line, as the lab's own stop does.
  const cli = path.join(tmp, 'pi-discord', 'cli.ts')
  fs.mkdirSync(path.dirname(cli))
  fs.writeFileSync(cli, STAND_IN)
  stateDir = path.join(tmp, 'state')
  fs.mkdirSync(stateDir)
  logPath = path.join(tmp, 'door.log')
  startScript = path.join(tmp, 'start.sh')
  process.env.SWARM_MAP_DOOR_LAUNCHER = cli
  process.env.HSM_OPERATOR_TOKEN = 'operator-token-that-must-not-travel'
  delete process.env.SWARM_MAP_NODE
  launcher = createCliLauncher()
  fs.writeFileSync(startScript, `#!/bin/sh\nexport SMLAB_STATE_DIR='${stateDir}'\nexec '${launcher.command().node}' '${cli}' start --config x\n`, { mode: 0o700 })
  started = undefined
})

afterEach(() => {
  if (started) { try { process.kill(started, 'SIGKILL') } catch { /* already gone */ } }
  for (const [name, value] of [['SWARM_MAP_DOOR_LAUNCHER', saved.launcher], ['HSM_OPERATOR_TOKEN', saved.token], ['SWARM_MAP_NODE', saved.node]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const runPid = (): number => (JSON.parse(fs.readFileSync(path.join(stateDir, 'run.json'), 'utf8')) as { pid: number }).pid

describe('the launcher adapter', () => {
  it('runs the command it was pointed at, with the Node that was chosen', () => {
    process.env.SWARM_MAP_NODE = process.execPath
    expect(launcher.command()).toEqual({ node: process.execPath, cli: path.join(tmp, 'pi-discord', 'cli.ts') })
    expect(launcher.nodeProblem()).toBeUndefined()
  })

  it('names the stable Homebrew path, not the versioned one this Node runs from', () => {
    const cellar = path.join(tmp, 'Cellar', 'node@99', '99.1.0_1', 'bin', 'node')
    const opt = path.join(tmp, 'opt', 'node@99', 'bin', 'node')
    for (const p of [cellar, opt]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.symlinkSync(process.execPath, p) }
    const brewed = createCliLauncher({ execPath: cellar })
    expect(brewed.command().node).toBe(opt)
    // The keg is replaced by an upgrade: the path already written still runs.
    fs.rmSync(path.join(tmp, 'Cellar', 'node@99', '99.1.0_1'), { recursive: true })
    expect(brewed.nodeProblem()).toBeUndefined()
  })

  it('says so when the Node it would use is gone', () => {
    process.env.SWARM_MAP_NODE = path.join(tmp, 'gone', 'node')
    expect(launcher.command().node).toBe(path.join(tmp, 'gone', 'node'))
    expect(launcher.nodeProblem()).toMatch(/Node was not found at .*gone\/node/)
  })

  it('gives back the dry run\'s exit code and everything it printed', async () => {
    const { code, output } = await launcher.dryRun({ configPath: '/nowhere/config.json', env: { SMLAB_STATE_DIR: stateDir } })
    expect(code).toBe(3)
    expect(output).toContain('RESULT: the cell is sealed, but the secret files are not in place yet.')
    expect(output).toContain('FAIL  S1   a line on stderr')
  })

  it('hands the child a short, named environment, and nothing else Swarm Map holds', async () => {
    const { output } = await launcher.dryRun({ configPath: '/nowhere/config.json', env: { SMLAB_STATE_DIR: stateDir, SMLAB_DISCORD_TOKEN_FILE: '/keys/token' } })
    const names = output.split('\n').find((l) => l.startsWith('ENV '))!.slice(4).split(',')
    expect(names).toEqual(expect.arrayContaining(['PATH', 'SMLAB_DISCORD_TOKEN_FILE', 'SMLAB_STATE_DIR']))
    expect(names).not.toContain('HSM_OPERATOR_TOKEN')
    expect(names).not.toContain('SWARM_MAP_DOOR_LAUNCHER')
    const allowed = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'SMLAB_STATE_DIR', 'SMLAB_DISCORD_TOKEN_FILE']
    // Node and the dynamic loader add a few names of their own on some machines.
    expect(names.filter((n) => !allowed.includes(n) && !n.startsWith('__') && !n.startsWith('NODE_'))).toEqual([])
  })

  it('starts the door in the background, sends its output to a log only the owner can read, and knows it is running', async () => {
    await launcher.start({ startScript, logPath, stateDir })
    started = runPid()
    expect(launcher.alive(started)).toBe(true)
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
    await expect.poll(() => fs.readFileSync(logPath, 'utf8')).toContain('cell up and sealed')
  })

  it('says so when the door stops as soon as it is started', async () => {
    fs.writeFileSync(startScript, `#!/bin/sh\nexport STAND_IN_FAILS=1\nexec '${launcher.command().node}' '${launcher.command().cli}' start --config x\n`)
    await expect(launcher.start({ startScript, logPath, stateDir })).rejects.toThrow(/stopped as soon as it was started/)
    expect(fs.readFileSync(logPath, 'utf8')).toContain('start: refused')
  })

  it('stops the door through the command, and then it is no longer running', async () => {
    await launcher.start({ startScript, logPath, stateDir })
    started = runPid()
    expect(await launcher.stop({ configPath: '/nowhere/config.json', stateDir })).toMatchObject({ ok: true })
    await expect.poll(() => launcher.alive(started!)).toBe(false)
  })

  it('reports a stop that failed', async () => {
    expect(await launcher.stop({ configPath: '/nowhere/config.json', stateDir })).toMatchObject({ ok: false })
  })

  it('does not take some other live process for a door', () => {
    expect(launcher.alive(process.ppid)).toBe(false)
    expect(launcher.alive(2 ** 22 + 12345)).toBe(false)
  })
})
