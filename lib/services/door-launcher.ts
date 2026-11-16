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
}

const DRY_RUN_TIMEOUT_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 2 * 60_000
const START_WAIT_MS = 20_000
const MAX_OUTPUT = 200_000

/** The launcher is handed a short, named environment. Nothing else Swarm Map holds goes with it. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env as NodeJS.ProcessEnv
}

function run(node: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const finish = (code: number | null) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, output }) } }
    const child = spawn(node, args, { env: { ...baseEnv(), ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
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
    supervisor(pid) {
      // pm2 starts what it runs as a child of its own daemon, which names itself in its process title.
      const ps = (of: string, field: string): string => spawnSync('ps', ['-p', of, '-o', `${field}=`], { encoding: 'utf8' }).stdout.trim()
      const parent = ps(String(pid), 'ppid')
      return /^\d+$/.test(parent) && parent !== '1' && /\bPM2\b/.test(ps(parent, 'command')) ? 'pm2' : undefined
    },
  }
}
