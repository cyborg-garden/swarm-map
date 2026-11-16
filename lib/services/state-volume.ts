/**
 * Decides whether an agent's compose file gets the state-volume layout (the
 * named volume at /state plus the one-shot state-init service, #204 PR2).
 *
 * The layout exists for one reason: when the Docker engine runs inside a VM,
 * the agent's bind-mounted data dir crosses a file-sharing layer (VirtioFS on
 * Docker Desktop for macOS), and SQLite writes through that layer can tear. A
 * named volume lives inside the VM and never crosses it. Where the engine runs
 * on the host's own kernel (native Linux) a bind mount is an ordinary local
 * directory, the layout protects nothing, and its symlinked DB paths get in
 * the way (#273).
 *
 * So the question is about the DOCKER ENGINE, not about where this Node
 * process runs. Swarm Map always drives the engine through the local `docker`
 * CLI and writes each agent's data dir on its own filesystem, so the two are
 * usually the same machine, but not always the same kernel: the process may
 * run inside a container or WSL on a Docker Desktop host, or the CLI may point
 * at another engine (DOCKER_HOST, a docker context). `process.platform` alone
 * would call all of those "linux". The decision therefore asks the engine
 * (DockerService.hostInfo) and treats anything it cannot prove native as
 * needing the layout, because that is the side that cannot damage a database.
 *
 * Order of precedence (resolveUseStateVolume):
 *   1. An agent whose databases already live on the volume keeps the layout.
 *      Its data dir holds only symlinks into /state; a compose file without
 *      the /state mount would leave them pointing at nothing.
 *   2. settings.useStateVolume, when it is true or false.
 *   3. The engine: on for a VM-backed or unknown engine, off for native Linux.
 */
import fs from 'fs'
import path from 'path'
import { MIGRATED_DB_FILES } from './harness-compose'

/** What `docker info` and the active context say about the engine. */
export type DockerHostInfo = {
  /** `docker info` .OperatingSystem, e.g. "Docker Desktop", "Ubuntu 24.04.1 LTS". */
  operatingSystem: string
  /** `docker info` .KernelVersion, e.g. "6.10.14-linuxkit". */
  kernelVersion: string
  /** `docker info` .OSType, e.g. "linux". */
  osType: string
  /** DOCKER_HOST, else the active context's endpoint, else '' when the CLI has no contexts. */
  endpoint: string
}

export type StateVolumeReason =
  /** The agent's databases are already on the volume. */
  | 'existing-layout'
  /** settings.useStateVolume is set. */
  | 'setting'
  /** The engine runs in a VM; bind mounts cross a file-sharing layer. */
  | 'vm-engine'
  /** The engine runs on this host's own Linux kernel. */
  | 'native-linux'
  /** The engine could not be identified; the layout is kept on to be safe. */
  | 'unknown-engine'

export type StateVolumeDecision = { use: boolean; reason: StateVolumeReason }

// Engines that run Linux in a VM and share host directories into it. Matched
// against OperatingSystem and KernelVersion: Docker Desktop reports itself as
// the operating system on every host (macOS, Windows and Linux alike) and runs
// a linuxkit kernel; OrbStack, Rancher Desktop and WSL name themselves in one
// field or the other. Colima and Lima report the guest distro and are only
// recognisable from the macOS side, which the platform check below covers.
const VM_ENGINE = /docker desktop|orbstack|rancher desktop|linuxkit|microsoft|wsl/i

/**
 * Whether bind mounts on this engine need the state-volume layout.
 *
 * `platform` is where the Node process runs; `info` is the engine, or null
 * when it did not answer.
 */
export function engineNeedsStateVolume(
  platform: NodeJS.Platform,
  info: DockerHostInfo | null | undefined,
): StateVolumeDecision {
  // Not Linux: the engine cannot be on this kernel. On macOS and Windows every
  // Docker engine runs Linux in a VM (Docker Desktop, OrbStack, Colima, ...),
  // and a remote engine is one we know nothing about. Either way: on.
  if (platform !== 'linux') return { use: true, reason: platform === 'darwin' || platform === 'win32' ? 'vm-engine' : 'unknown-engine' }

  if (!info || typeof info !== 'object') return { use: true, reason: 'unknown-engine' }
  // An endpoint that is not a local unix socket is another machine's engine.
  // An empty endpoint means the CLI has no contexts and DOCKER_HOST is unset,
  // which leaves only its built-in default, the local socket.
  if (info.endpoint && !info.endpoint.startsWith('unix://')) return { use: true, reason: 'unknown-engine' }
  if (!info.osType || info.osType.toLowerCase() !== 'linux') return { use: true, reason: 'unknown-engine' }
  if (!info.operatingSystem && !info.kernelVersion) return { use: true, reason: 'unknown-engine' }
  if (VM_ENGINE.test(info.operatingSystem) || VM_ENGINE.test(info.kernelVersion)) return { use: true, reason: 'vm-engine' }
  return { use: false, reason: 'native-linux' }
}

/**
 * True when the agent's live databases are on the named volume: one of the DB
 * paths in its data dir is a symlink into /state. state-init leaves exactly
 * that behind every time it runs, and the rollback in the migration runbook
 * replaces the symlinks with real files, so this is an exact reading of where
 * the databases are. lstat, not existsSync: from the host the link dangles.
 */
export function agentHasStateVolumeLayout(dataDir: string): boolean {
  for (const db of MIGRATED_DB_FILES) {
    try {
      const p = path.join(dataDir, db)
      if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith('/state/')) return true
    } catch {
      // absent or unreadable: not a migrated path
    }
  }
  return false
}

/**
 * The state-volume choice for one agent's compose file. Call this at every
 * place that generates a compose file and pass the result as
 * `useStateVolume`.
 *
 * `hostInfo` is called only when the engine actually has to be asked (no
 * existing layout, no explicit setting, Node on Linux). If it throws, the
 * engine is unknown and the layout stays on.
 */
export function resolveUseStateVolume(opts: {
  /** settings.useStateVolume: true/false to force, undefined/null for automatic. */
  setting?: boolean | null
  /** The agent's host data dir (the one bind-mounted at /opt/data). */
  dataDir: string
  hostInfo: () => DockerHostInfo | null | undefined
  /** Defaults to process.platform; a parameter so tests can cover every host. */
  platform?: NodeJS.Platform
}): StateVolumeDecision {
  if (agentHasStateVolumeLayout(opts.dataDir)) {
    if (opts.setting === false) {
      console.warn(`[state-volume] ${opts.dataDir}: useStateVolume is off, but this agent's databases are on its named volume; keeping the layout. Move them back first (docs/runbooks/db-named-volume-migration.md, "Rollback").`)
    }
    return { use: true, reason: 'existing-layout' }
  }
  if (typeof opts.setting === 'boolean') return { use: opts.setting, reason: 'setting' }
  const platform = opts.platform ?? process.platform
  if (platform !== 'linux') return engineNeedsStateVolume(platform, null)
  let info: DockerHostInfo | null | undefined
  try {
    info = opts.hostInfo()
  } catch {
    info = null
  }
  return engineNeedsStateVolume(platform, info)
}
