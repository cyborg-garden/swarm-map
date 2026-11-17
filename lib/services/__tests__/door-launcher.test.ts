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
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createCliLauncher, pm2AppFor, type DoorLauncher } from '../door-launcher'

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

  it('says a door runs under a supervisor only when its parent process is one', async () => {
    // A stand-in for pm2's daemon: a process that names itself as pm2's does, with one child.
    const daemon = path.join(tmp, 'daemon.js')
    fs.writeFileSync(daemon, `
      const { spawn } = require('child_process')
      process.title = 'PM2 v0.0.0: God Daemon (stand-in)'
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log(child.pid)
      process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0) })
      setInterval(() => {}, 1000)
    `)
    const parent = spawn(process.execPath, [daemon], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      const childPid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (d) => resolve(String(d).trim()))))
      expect(childPid).toBeGreaterThan(1)
      expect(launcher.supervisor!(childPid)).toBe('pm2')
      // The stand-in daemon itself, this test's own process and a pid nobody has are under no supervisor.
      expect(launcher.supervisor!(parent.pid!)).toBeUndefined()
      expect(launcher.supervisor!(process.pid)).toBeUndefined()
      expect(launcher.supervisor!(2 ** 22 + 12345)).toBeUndefined()
    } finally {
      parent.kill('SIGTERM')
    }
  })
})

// A stand-in for the pm2 command. `jlist` prints the list the test wrote; `restart` starts the start
// script as the child of a process that names itself as pm2's daemon does, as pm2 does. Each call's
// arguments are written down, one JSON array a line.
const FAKE_PM2 = (node: string) => `#!${node}
const fs = require('fs')
const { spawn } = require('child_process')
const home = process.env.PM2_HOME
fs.appendFileSync(home + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n')
const [cmd] = process.argv.slice(2)
if (fs.existsSync(home + '/fails') || !fs.existsSync(home + '/list.json')) process.exit(1)
if (cmd === 'jlist') { process.stdout.write(fs.readFileSync(home + '/list.json', 'utf8')); process.exit(0) }
if (cmd === 'restart') {
  const daemon = spawn(process.execPath, ['-e', \`
    process.title = 'PM2 v0.0.0: God Daemon (stand-in)'
    const child = require('child_process').spawn('/bin/sh', [\${JSON.stringify(fs.readFileSync(home + '/script', 'utf8'))}], { stdio: 'ignore' })
    process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0) })
    setInterval(() => {}, 1000)
  \`], { detached: true, stdio: 'ignore' })
  fs.writeFileSync(home + '/daemon.pid', String(daemon.pid))
  daemon.unref()
  process.exit(0)
}
process.exit(2)
`

describe('the launcher adapter and pm2', () => {
  let home: string
  let savedPath: string | undefined
  let savedHome: string | undefined
  const pm2Calls = (): string[][] => (fs.existsSync(path.join(home, 'calls')) ? fs.readFileSync(path.join(home, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const list = (apps: unknown[]) => fs.writeFileSync(path.join(home, 'list.json'), JSON.stringify(apps))
  // pm2's own record of its daemon: a live pid. This test's process stands in for it.
  const daemonUp = () => fs.writeFileSync(path.join(home, 'pm2.pid'), String(process.pid))
  const app = (id: number, name: string, script: string, pid: number) => ({ pm_id: id, name, pid, pm2_env: { pm_exec_path: script, status: 'online', SOME_SECRET: 'must-not-travel' } })

  beforeEach(() => {
    home = path.join(tmp, 'pm2home')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'pm2'), FAKE_PM2(process.execPath), { mode: 0o755 })
    fs.writeFileSync(path.join(home, 'script'), startScript)
    savedPath = process.env.PATH
    savedHome = process.env.PM2_HOME
    process.env.PATH = `${path.join(home, 'bin')}:${savedPath}`
    process.env.PM2_HOME = home
  })
  afterEach(() => {
    try { process.kill(Number(fs.readFileSync(path.join(home, 'daemon.pid'), 'utf8')), 'SIGTERM') } catch { /* none was started */ }
    process.env.PATH = savedPath
    if (savedHome === undefined) delete process.env.PM2_HOME
    else process.env.PM2_HOME = savedHome
  })

  it('does not ask pm2 at all while its daemon is not running, since asking would start one', () => {
    list([app(7, 'door-pi-one', startScript, 1234)])
    expect(launcher.supervisedBy!({ startScript })).toBeNull()
    expect(pm2Calls()).toEqual([])
  })

  it('finds the app that runs this start script, by its path or by the door\'s pid, and hands back only its id and name', () => {
    daemonUp()
    const link = path.join(tmp, 'start-link.sh')
    fs.symlinkSync(startScript, link)
    list([app(3, 'other', path.join(tmp, 'other.sh'), 99), app(7, 'door-pi-one', link, 1234)])
    expect(launcher.supervisedBy!({ startScript })).toEqual({ supervisor: 'pm2', id: 7, name: 'door-pi-one' })
    list([app(7, 'renamed-by-hand', path.join(tmp, 'elsewhere.sh'), 1234)])
    expect(launcher.supervisedBy!({ startScript, pid: 1234 })).toEqual({ supervisor: 'pm2', id: 7, name: 'renamed-by-hand' })
    expect(launcher.supervisedBy!({ startScript, pid: 4321 })).toBeNull()
    expect(pm2Calls().every((c) => JSON.stringify(c) === '["jlist"]')).toBe(true)
  })

  it('will not pick one of two apps that run the same door', () => {
    daemonUp()
    list([app(7, 'door-a', startScript, 1), app(8, 'door-b', startScript, 2)])
    expect(launcher.supervisedBy!({ startScript })).toEqual({ unknown: expect.stringMatching(/2 apps for this door \(door-a, door-b\)/) })
  })

  it('says pm2 could not be asked when it fails, or is not on the PATH', () => {
    daemonUp()
    list([])
    fs.writeFileSync(path.join(home, 'fails'), '')
    expect(launcher.supervisedBy!({ startScript })).toEqual({ unknown: expect.stringMatching(/could not ask it/) })
    expect(pm2Calls()).toEqual([['jlist']])
    process.env.PATH = '/nonexistent'
    expect(launcher.supervisedBy!({ startScript })).toEqual({ unknown: expect.stringMatching(/could not ask it/) })
  })

  it('reads the list after a warning pm2 prints first, and refuses a list it cannot read', () => {
    const one = JSON.stringify([app(7, 'door-pi-one', startScript, 1)])
    expect(pm2AppFor(`>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\n${one}`, { startScript })).toEqual({ supervisor: 'pm2', id: 7, name: 'door-pi-one' })
    expect(pm2AppFor('not a list', { startScript })).toEqual({ unknown: expect.any(String) })
    expect(pm2AppFor('{"a":1}', { startScript })).toEqual({ unknown: expect.any(String) })
  })

  it('restarts the app by its id, as an argument and not through a shell, and waits for the door it started', async () => {
    daemonUp()
    list([app(7, 'door-pi-one', startScript, 1)])
    await launcher.restartSupervised!({ supervisor: 'pm2', id: 7, name: 'door-pi-one' }, { stateDir })
    started = runPid()
    expect(pm2Calls()).toEqual([['restart', '7']])
    expect(launcher.alive(started)).toBe(true)
    expect(launcher.supervisor!(started)).toBe('pm2')
  })

  it('says so when pm2 does not restart the app', async () => {
    daemonUp()
    list([])
    fs.writeFileSync(path.join(home, 'fails'), '')
    await expect(launcher.restartSupervised!({ supervisor: 'pm2', id: 7, name: 'door-pi-one' }, { stateDir })).rejects.toThrow(/pm2 did not restart door-pi-one/)
    expect(fs.existsSync(path.join(stateDir, 'run.json'))).toBe(false)
  })
})
