/**
 * Which Node a door's start script names.
 *
 * The start script is a file that outlives this process: a supervisor runs
 * it again after a crash or a reboot. So the Node path written into it has
 * to keep working after the package manager upgrades Node.
 *
 * Under Homebrew, the Node that Swarm Map runs from resolves to a versioned
 * folder (`<prefix>/Cellar/<formula>/<version>/bin/node`). An upgrade removes
 * that folder. Homebrew keeps a stable link beside it
 * (`<prefix>/opt/<formula>/bin/node`) that always points at the installed
 * version, so that is the path to write down.
 *
 * The order: SWARM_MAP_NODE when it is set, else the stable Homebrew path
 * when there is one and it is the same major version, else this Node as it is.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

/** Set this to the full path of a Node binary to use it for every door, whatever Swarm Map itself runs on. */
export const NODE_OVERRIDE_ENV = 'SWARM_MAP_NODE'

/** What is asked of the machine. A test answers from a table. */
export interface NodeProbe {
  /** Whether `file` is there and may be executed. */
  executable(file: string): boolean
  /** What `file --version` prints, such as `v24.22.1`. Undefined when it could not be run. */
  version(file: string): string | undefined
}

export const realProbe: NodeProbe = {
  executable(file) {
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return fs.statSync(file).isFile()
    } catch { return false }
  },
  version(file) {
    const out = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, env: {} as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.status === 0 ? out.stdout.trim() || undefined : undefined
  },
}

const parse = (version: string | undefined): [number, number] | undefined => {
  const m = /^v?(\d+)\.(\d+)\.\d+/.exec(version ?? '')
  return m ? [Number(m[1]), Number(m[2])] : undefined
}

/**
 * Whether this version of Node runs a `.ts` file with no flag and no build
 * step, which is how the launcher is run: 22.18 and up, 23.6 and up, 24 and up.
 */
export function runsTypeScript(version: string): boolean {
  const v = parse(version)
  if (!v) return false
  const [major, minor] = v
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
}

const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/

export interface ChosenNode {
  path: string
  source: 'override' | 'homebrew-opt' | 'this-node'
}

/** The Node path to write into a start script. Does not judge it: `nodeProblem` does. */
export function chooseNode(o: {
  /** The Node this process runs on (process.execPath). */
  execPath: string
  /** Its version (process.version). */
  version: string
  env: Record<string, string | undefined>
  probe: NodeProbe
}): ChosenNode {
  const override = o.env[NODE_OVERRIDE_ENV]?.trim()
  if (override) return { path: override, source: 'override' }
  const cellar = CELLAR_NODE.exec(o.execPath)
  if (cellar) {
    const stable = `${cellar[1]}/opt/${cellar[2]}/bin/node`
    const major = parse(o.version)?.[0]
    if (major !== undefined && o.probe.executable(stable) && parse(o.probe.version(stable))?.[0] === major) {
      return { path: stable, source: 'homebrew-opt' }
    }
  }
  return { path: o.execPath, source: 'this-node' }
}

/** Why the Node at `file` cannot run the launcher, in plain words. Undefined when it can. */
export function nodeProblem(file: string, probe: NodeProbe): string | undefined {
  if (!path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) {
    return `${NODE_OVERRIDE_ENV} must be a full path to a Node binary, on one line. Set it again and restart Swarm Map.`
  }
  if (!probe.executable(file)) {
    return `Node was not found at ${file}, or it cannot be run. Reinstall Node, or set ${NODE_OVERRIDE_ENV} to the full path of a Node that can be run, and restart Swarm Map.`
  }
  const version = probe.version(file)
  if (version === undefined || !parse(version)) {
    return `The Node at ${file} did not answer with a version, so it cannot be trusted to run the launcher. Reinstall Node, or set ${NODE_OVERRIDE_ENV} to the full path of one that works, and restart Swarm Map.`
  }
  if (!runsTypeScript(version)) {
    return `The Node at ${file} is ${version}, which is too old to run the launcher. It needs Node 22.18 or newer. Upgrade Node, or set ${NODE_OVERRIDE_ENV} to the full path of a newer one, and restart Swarm Map.`
  }
  return undefined
}
