/**
 * Decides whether an agent's compose file gets the state-volume layout (the
 * named volume at /state plus the one-shot state-init service, #204 PR2).
 *
 * The layout exists for one reason: when the Docker engine runs inside a VM,
 * the agent's bind-mounted data dir crosses a file-sharing layer (VirtioFS on
 * Docker Desktop for macOS), and SQLite writes through that layer can tear. A
 * named volume lives inside the VM and never crosses it. Where the engine runs
 * on the host's own kernel (native Linux) a bind mount is an ordinary local
 * directory and the layout is unnecessary, so it is left off there (#273).
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
 *      the /state mount would leave them pointing at nothing. The layout is
 *      also kept when the data dir cannot be read, and when the compose file
 *      being replaced mounts the volume while the data dir holds no regular
 *      state.db (an interrupted state-init run).
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
  /** The active docker context's name, e.g. "default", "colima", "rancher-desktop". */
  contextName?: string
  /**
   * True when this Node process itself runs inside a container. The engine it
   * reaches through a mounted socket then belongs to a host this process
   * cannot see, so nothing `docker info` says proves that host is native Linux.
   */
  containerised?: boolean
}

export type StateVolumeReason =
  /** The agent's databases are already on the volume. */
  | 'existing-layout'
  /** The agent's data dir could not be read; the layout is kept on to be safe. */
  | 'layout-unknown'
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
// field or the other.
const VM_ENGINE = /docker desktop|orbstack|rancher desktop|linuxkit|microsoft|wsl/i

// Engines that run in a VM but report the GUEST distro as their operating
// system (Colima, Lima, Rancher Desktop's Lima backend, a Podman machine), so
// the fields above look native. A Linux process only meets them through a
// forwarded socket; their host is unknown, so the layout stays on.
//
// They are recognised from the docker CONTEXT name and the SOCKET PATH, which
// those tools set themselves ("colima", "lima-default", "rancher-desktop",
// ".../.colima/default/docker.sock", ".../podman/podman.sock"). The engine's
// host name (`docker info` .Name) is deliberately not consulted: it is the
// machine's own hostname on a native install, and a server called
// "rancher-node1" or "podman-host" is not a VM. The tool name must stand as a
// whole word, bounded by a non-alphanumeric character or the string's end, so
// "lima01", "limassol" and "ranchero" do not match.
const VM_ENGINE_NAME = /(^|[^a-z0-9])(colima|lima|rancher|podman)($|[^a-z0-9])/i

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
  // This process is in a container: the engine belongs to a host it cannot see.
  if (info.containerised) return { use: true, reason: 'unknown-engine' }
  if ([info.contextName, info.endpoint].some((v) => !!v && VM_ENGINE_NAME.test(v))) {
    return { use: true, reason: 'unknown-engine' }
  }
  if (VM_ENGINE.test(info.operatingSystem) || VM_ENGINE.test(info.kernelVersion)) return { use: true, reason: 'vm-engine' }
  return { use: false, reason: 'native-linux' }
}

/** Where an agent's data dir says its databases are. */
export type StateVolumeLayout =
  /** A DB path is a symlink into /state: the live databases are on the volume. */
  | 'on-volume'
  /** No DB path is such a symlink. */
  | 'not-on-volume'
  /** The data dir could not be read, so neither can be said. */
  | 'unreadable'

/**
 * Reads where the agent's live databases are from its data dir: on the named
 * volume when one of the DB paths is a symlink into /state. state-init leaves
 * exactly that behind every time it runs, and the rollback in the migration
 * runbook replaces the symlinks with real files, so this is an exact reading.
 * lstat, not existsSync: from the host the link dangles.
 *
 * Only "not there" (ENOENT, ENOTDIR) counts as absent. Any other failure, such
 * as a data dir this process may not read, is reported as 'unreadable'.
 */
export function stateVolumeLayout(dataDir: string): StateVolumeLayout {
  let unreadable = false
  for (const db of MIGRATED_DB_FILES) {
    try {
      const p = path.join(dataDir, db)
      if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith('/state/')) return 'on-volume'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable = true
    }
  }
  return unreadable ? 'unreadable' : 'not-on-volume'
}

/**
 * True unless the data dir positively shows the databases are NOT on the
 * volume: an unreadable data dir counts as "has it", because dropping the
 * /state mount from an agent whose databases are on the volume is the outcome
 * to avoid.
 */
export function agentHasStateVolumeLayout(dataDir: string): boolean {
  return stateVolumeLayout(dataDir) !== 'not-on-volume'
}

/**
 * True when a compose file already mounts a state volume at /state. This is a
 * line match on what the generators and the migrate-db transformer write
 * (`      - hermes-state-<name>:/state`), not a YAML parse: a hand-reshaped
 * file (flow sequences, long-form mounts) is not recognised.
 */
export function composeMountsStateVolume(compose: string): boolean {
  return /^\s*- hermes-state-[^\s:]+:\/state\s*$/m.test(compose)
}

/** True when `<dataDir>/state.db` is a regular file (not a symlink, not absent). */
function hasRegularStateDb(dataDir: string): boolean {
  try {
    return fs.lstatSync(path.join(dataDir, 'state.db')).isFile()
  } catch {
    return false
  }
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
  /** The compose file about to be replaced, when there is one (regeneration). */
  existingCompose?: string | null
  hostInfo: () => DockerHostInfo | null | undefined
  /** Defaults to process.platform; a parameter so tests can cover every host. */
  platform?: NodeJS.Platform
}): StateVolumeDecision {
  const layout = stateVolumeLayout(opts.dataDir)
  if (layout === 'unreadable') {
    console.warn(`[state-volume] ${opts.dataDir}: could not read this agent's data dir to see where its databases are; keeping the state-volume layout on to be safe.`)
    return { use: true, reason: 'layout-unknown' }
  }
  // The compose file being replaced mounting the volume is evidence too, but
  // only when the data dir holds no regular state.db.
  //
  // Why state.db: STATE_INIT_SCRIPT (harness-compose.ts) walks MIGRATED_DB_FILES
  // in order, state.db first, and for each one copies to the volume, removes
  // the data-dir copy, then writes the symlink (`ln -sfn`, also on a fresh
  // agent with no database yet). So once it has finished state.db there is a
  // symlink (read above), and a run interrupted between the remove and the
  // link leaves state.db ABSENT. A regular state.db therefore means the live
  // database is in the data dir: either state-init never got that far, or the
  // symlinks were replaced by hand and the agent has since been writing real
  // files. In both cases the old compose file's mount says nothing about where
  // the data is, and the layout follows the setting and the engine.
  const interrupted = layout === 'not-on-volume'
    && !!opts.existingCompose && composeMountsStateVolume(opts.existingCompose)
    && !hasRegularStateDb(opts.dataDir)
  if (layout === 'on-volume' || interrupted) {
    if (opts.setting === false) {
      console.warn(interrupted
        ? `[state-volume] ${opts.dataDir}: useStateVolume is off, but this agent's compose file mounts its named volume and its data dir holds no state.db, so its databases may be on the volume; keeping the layout. See docs/runbooks/db-named-volume-migration.md, "Rollback".`
        : `[state-volume] ${opts.dataDir}: useStateVolume is off, but this agent's databases are on its named volume; keeping the layout. Move them back first (docs/runbooks/db-named-volume-migration.md, "Rollback").`)
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
