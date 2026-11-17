/**
 * How Swarm Map reaches the launcher that runs a door agent.
 *
 * The launcher is the lab's command (lib/lab/pi-discord/cli.ts). Swarm Map
 * never loads it into its own process: it runs it as a child, hands it paths,
 * and reads the exit code and the lines it printed. So the dashboard never
 * holds the bot token or the model key, and a test swaps this whole
 * interface for a stub.
 */
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { chooseNode, nodeProblem, realProbe, type NodeProbe } from './door-node'

export interface DoorLauncher {
  /** The two paths the start script is rendered with. Worked out again on every call. */
  command(): { node: string; cli: string }
  /** Why the Node that `command()` names cannot run the launcher. Undefined when it can. */
  nodeProblem(): string | undefined
  /** Run the launcher's dry run on a config. `code` is null when it never finished. */
  dryRun(o: { configPath: string; env: Record<string, string> }): Promise<{ code: number | null; output: string }>
  /** Start the door from its start script, in the background, with its output appended to the log. */
  start(o: { startScript: string; logPath: string; stateDir: string }): Promise<void>
  /** Stop the door and remove its cell. */
  stop(o: { configPath: string; stateDir: string }): Promise<{ ok: boolean; output: string }>
  /** Whether `pid` is a running door. */
  alive(pid: number): boolean
  /** The process supervisor that `pid` runs under, when its parent is one. Undefined when it is not, or cannot be told. */
  supervisor?(pid: number): 'pm2' | undefined
  /**
   * The supervisor app that runs this start script, or the door now running as `pid`: null when there is
   * none. `unknown` when a supervisor is there but could not be asked, or its answer cannot be used. Then
   * nothing may be started or restarted around it, or there could be two doors, or a door it no longer watches.
   */
  supervisedBy?(o: { startScript: string; pid?: number }): SupervisedApp | null | { unknown: string }
  /**
   * Have the supervisor start the app again, which runs the start script as it is on disk now, and wait
   * until the door it started has written its run record. Throws when that does not happen.
   */
  restartSupervised?(app: SupervisedApp, o: { stateDir: string }): Promise<void>
}

/** A pm2 app that runs a door: its id, and the name pm2 shows. */
export interface SupervisedApp { supervisor: 'pm2'; id: number; name: string }

const DRY_RUN_TIMEOUT_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 2 * 60_000
const START_WAIT_MS = 20_000
const MAX_OUTPUT = 200_000
const PM2_TIMEOUT_MS = 60_000

/** The launcher is handed a short, named environment. Nothing else Swarm Map holds goes with it. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env as NodeJS.ProcessEnv
}

/** pm2 is handed the same short environment, and where its own folder is, so the daemon it talks to is the one that runs the door. */
function pm2Env(): NodeJS.ProcessEnv {
  return { ...baseEnv(), ...(process.env.PM2_HOME ? { PM2_HOME: process.env.PM2_HOME } : {}) }
}

/** Whether pm2's daemon is up. `pm2 jlist` with no daemon would start one, so it is not asked then. */
function pm2DaemonUp(): boolean {
  const home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2')
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 1) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

const realPath = (p: string): string => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

/**
 * Which pm2 app runs this start script, or the door `pid`, read from `pm2 jlist`. What pm2 lists holds
 * each app's environment: only the id, the name, the pid and the script path are read out of it, and
 * nothing of it is kept, returned or logged.
 */
export function pm2AppFor(jlist: string, o: { startScript: string; pid?: number }): SupervisedApp | null | { unknown: string } {
  let apps: unknown
  // pm2 can print a warning before the list, as when the daemon is older than the command.
  try { apps = JSON.parse(jlist.slice(Math.max(0, jlist.search(/^\[/m)))) } catch { return { unknown: 'pm2 runs on this machine, but its list of apps could not be read' } }
  if (!Array.isArray(apps)) return { unknown: 'pm2 runs on this machine, but its list of apps could not be read' }
  const script = realPath(o.startScript)
  const found = apps.filter((a) => {
    const execPath = a?.pm2_env?.pm_exec_path
    return (o.pid !== undefined && a?.pid === o.pid) || (typeof execPath === 'string' && realPath(execPath) === script)
  }).map((a) => ({ id: a?.pm_id, name: a?.name }))
  if (found.length === 0) return null
  if (found.length > 1) return { unknown: `pm2 has ${found.length} apps for this door (${found.map((a) => String(a.name)).join(', ')}). Remove all but one with \`pm2 delete\`` }
  const [app] = found
  if (!Number.isInteger(app.id) || typeof app.name !== 'string') return { unknown: 'pm2 lists an app for this door without an id or a name' }
  return { supervisor: 'pm2', id: app.id, name: app.name }
}

function run(node: string, args: string[], env: Record<string, string>, timeoutMs: number, base: NodeJS.ProcessEnv = baseEnv()): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, output }) } }
    const child = spawn(node, args, { env: { ...base, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const take = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString('utf8') }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null) }, timeoutMs)
  })
}

/**
 * The real launcher: the lab's command, run with the Node that door-node.ts
 * chooses (SWARM_MAP_NODE, else a path that survives a Node upgrade, else
 * this Node). The command is found in the checkout Swarm Map runs from, or
 * where SWARM_MAP_DOOR_LAUNCHER points.
 *
 * The Node is chosen again each time it is needed, never once at start-up:
 * a Node upgraded under a running Swarm Map is then seen at the next start.
 */
export function createCliLauncher(o: { execPath?: string; version?: string; probe?: NodeProbe } = {}): DoorLauncher {
  const probe = o.probe ?? realProbe
  const node = (): string => chooseNode({ execPath: o.execPath ?? process.execPath, version: o.version ?? process.version, env: process.env, probe }).path
  const cli = process.env.SWARM_MAP_DOOR_LAUNCHER || path.join(process.cwd(), 'lib', 'lab', 'pi-discord', 'cli.ts')
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0) } catch { return false }
    // A number on disk can outlive its process: it only counts if it is still the launcher.
    return spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.includes('pi-discord')
  }
  // pm2 starts what it runs as a child of its own daemon, which names itself in its process title.
  const supervisor = (pid: number): 'pm2' | undefined => {
    const ps = (of: string, field: string): string => spawnSync('ps', ['-p', of, '-o', `${field}=`], { encoding: 'utf8' }).stdout.trim()
    const parent = ps(String(pid), 'ppid')
    return /^\d+$/.test(parent) && parent !== '1' && /\bPM2\b/.test(ps(parent, 'command')) ? 'pm2' : undefined
  }
  return {
    command: () => ({ node: node(), cli }),
    nodeProblem: () => nodeProblem(node(), probe),
    dryRun: (o) => run(node(), [cli, 'dry-run', '--config', o.configPath], o.env, DRY_RUN_TIMEOUT_MS),
    async start(o) {
      const out = fs.openSync(o.logPath, 'a', 0o600)
      let exited = false
      try {
        const child = spawn('/bin/sh', [o.startScript], { detached: true, stdio: ['ignore', out, out], env: baseEnv(), cwd: path.dirname(o.startScript) })
        child.on('exit', () => { exited = true })
        child.on('error', () => { exited = true })
        child.unref()
        // The launcher writes its run record before it brings the cell up. Wait for that, or for it to give up.
        const runFile = path.join(o.stateDir, 'run.json')
        for (const until = Date.now() + START_WAIT_MS; Date.now() < until;) {
          if (exited) throw new Error('The door stopped as soon as it was started. The Logs tab says why.')
          try { if ((JSON.parse(fs.readFileSync(runFile, 'utf8')) as { pid?: number }).pid === child.pid) return } catch { /* not written yet */ }
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      } finally {
        fs.closeSync(out)
      }
    },
    async stop(o) {
      const { code, output } = await run(node(), [cli, 'stop', '--config', o.configPath], { SMLAB_STATE_DIR: o.stateDir }, STOP_TIMEOUT_MS)
      return { ok: code === 0, output }
    },
    alive,
    supervisor,
    supervisedBy(o) {
      if (!pm2DaemonUp()) return null
      const r = spawnSync('pm2', ['jlist'], { env: pm2Env(), encoding: 'utf8', timeout: PM2_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.error || r.status !== 0) return { unknown: 'pm2 runs on this machine, but Swarm Map could not ask it which apps it runs (`pm2 jlist` failed). Is pm2 on the PATH Swarm Map runs with?' }
      return pm2AppFor(r.stdout, o)
    },
    async restartSupervised(app, o) {
      const runFile = path.join(o.stateDir, 'run.json')
      const r = await run('pm2', ['restart', String(app.id)], {}, PM2_TIMEOUT_MS, pm2Env())
      if (r.code !== 0) throw new Error(`pm2 did not restart ${app.name}`)
      // The door writes its run record before it brings the cell up. One that pm2 started has pm2 as its parent.
      for (const until = Date.now() + START_WAIT_MS; Date.now() < until;) {
        try {
          const pid = (JSON.parse(fs.readFileSync(runFile, 'utf8')) as { pid?: unknown }).pid
          if (typeof pid === 'number' && alive(pid) && supervisor(pid) === 'pm2') return
        } catch { /* not written yet */ }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error(`pm2 started ${app.name} again, but the door did not come up within ${START_WAIT_MS / 1000} seconds. pm2 starts it again if it exits with an error, and the Logs tab says why`)
    },
  }
}
