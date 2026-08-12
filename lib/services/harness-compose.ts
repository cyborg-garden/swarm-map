/**
 * Standalone Docker Compose generation for Hermes agents.
 * Extracted from harness.ts to support VPN (WireGuard + Camofox) sidecar configuration.
 *
 * NOTE: s6-overlay handles privilege dropping internally — never set `user:` in compose.
 * Required caps: CHOWN, DAC_OVERRIDE, SETGID, SETUID (for s6), NET_BIND_SERVICE (for gateway).
 * Do NOT set read_only, no-new-privileges, or noexec tmpfs — s6 writes executables to /run.
 */

import os from 'os'
import { assertNoNewline } from '@/lib/env-helpers'
import { ALL_SURFACE_VARS } from '@/lib/surfaces/derive'
import type { ExtraMount } from '@/lib/types'

/**
 * Expand a leading `~` in a HOST path to this user's home directory.
 *
 * `~/.iris/nimbleco/intake` is the spelling every other host path in this
 * codebase accepts (harness.ts's `expandPath`), and it is what an operator
 * hand-editing `harnesses.json` will type. Docker Compose does NOT expand `~` —
 * it would bind-mount a literal relative directory named `~` — so the expansion
 * has to happen here, before the absolute-path check, and the EXPANDED value is
 * what gets rendered.
 *
 * Only a bare `~` or a leading `~/` expands. `~someone/x` is deliberately left
 * alone so it fails the absolute-path check loudly instead of turning into a
 * silently wrong `/Users/mesomeone/x`. Container paths are never expanded — the
 * home directory here is the HOST's.
 */
export function expandHostPath(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return os.homedir() + p.slice(1)
  return p
}

/**
 * Environment variable names an agent's `extraEnv` may NOT set.
 *
 * Two distinct silent-override hazards, both of which end with the container
 * running an environment that disagrees with the configuration the console
 * displays:
 *
 *   1. extraEnv is emitted AFTER the generated `environment:` block, and the
 *      later entry of a duplicate name wins. So `HOME`/`HERMES_HOME` are
 *      overridable — which re-creates exactly the EACCES "Provider
 *      authentication failed" failure the pinned values exist to prevent.
 *   2. A compose `environment:` entry outranks `env_file`. The agent's .env is
 *      where every surface credential and every admission allowlist lives (who
 *      may command this agent), so an extraEnv entry naming one of those vars
 *      silently overrides security policy that the settings page still renders
 *      from the .env.
 *
 * Refused rather than dropped: quietly ignoring a key someone wrote is its own
 * false audit trail — the config would claim something the container never did.
 */
export const RESERVED_EXTRA_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  // Set by the generated `environment:` block that extraEnv is appended to.
  'HOME',
  'HERMES_HOME',
  // The agent's identity to HSM policy (swarm_map_policy allowlist + admin
  // lookups) and to lifecycle notifications. Overriding it lets one agent
  // impersonate another — the same hazard the duplicate path resets it for.
  'HERMES_AGENT_NAME',
  // Process-level code-execution levers: each one turns a "non-secret env var"
  // into arbitrary code running inside the agent container.
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  // Every surface credential, admission allowlist and behavior gate the surface
  // registry knows about — all delivered via env_file, all outrankable here.
  ...ALL_SURFACE_VARS,
])

type ResolvedMount = {
  hostPath: string
  containerPath: string
  mode: 'ro' | 'rw'
  note: string
}

/**
 * Validate + resolve every mount, or throw on the first bad one.
 *
 * Every value here is interpolated into a generated YAML file, so this
 * validates rather than trusts. A path containing a newline could append
 * arbitrary compose keys (another mount, a `user: root`, a `privileged: true`);
 * a path containing a colon could forge the mode field of the short syntax
 * (`/host:/container:rw` smuggled through what looks like one path). Both are
 * refused loudly — a malformed mount must fail generation, never render into
 * something that silently means more than it says.
 */
function checkMounts(mounts?: ExtraMount[]): ResolvedMount[] {
  if (mounts === undefined || mounts === null) return []
  if (!Array.isArray(mounts)) {
    throw new Error('extraMounts must be an array of { hostPath, containerPath } entries')
  }
  return mounts.map((mount, index) => {
    const where = `extraMounts[${index}]`
    if (!mount || typeof mount !== 'object') {
      throw new Error(`${where}: must be an object with hostPath and containerPath`)
    }
    // Newline check happens on the RAW value so the error names what was typed;
    // the tilde expansion follows, and everything after it sees the real path.
    const hostPath = expandHostPath(
      assertNoNewline(String(mount.hostPath ?? ''), `${where}.hostPath`))
    const containerPath = assertNoNewline(
      String(mount.containerPath ?? ''), `${where}.containerPath`)
    const mode = mount.mode ?? 'ro'
    if (!hostPath || !containerPath) {
      throw new Error(`${where}: hostPath and containerPath are both required`)
    }
    if (!hostPath.startsWith('/') || !containerPath.startsWith('/')) {
      throw new Error(
        `${where}: both paths must be absolute, got '${hostPath}' -> '${containerPath}'`)
    }
    if (hostPath.includes(':') || containerPath.includes(':')) {
      throw new Error(
        `${where}: a ':' in a path would forge the mount mode; refusing`)
    }
    if (mode !== 'ro' && mode !== 'rw') {
      throw new Error(`${where}: mode must be 'ro' or 'rw', got '${mode}'`)
    }
    const note = mount.note ? assertNoNewline(mount.note, `${where}.note`) : ''
    return { hostPath, containerPath, mode, note }
  })
}

/** Validate + resolve every env entry, or throw on the first bad one. */
function checkEnv(env?: Record<string, string>): Array<[string, string]> {
  if (env === undefined || env === null) return []
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('extraEnv must be an object of NAME: value pairs')
  }
  return Object.entries(env).map(([key, value]) => {
    assertNoNewline(key, `extraEnv key '${key}'`)
    assertNoNewline(String(value), `extraEnv['${key}']`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`extraEnv key '${key}' is not a valid environment variable name`)
    }
    if (RESERVED_EXTRA_ENV_NAMES.has(key)) {
      throw new Error(
        `extraEnv key '${key}' is reserved — it is set by the generated compose block ` +
        `or delivered through the agent's .env (env_file), and a compose 'environment:' ` +
        `entry silently outranks both. Refusing rather than shipping a container whose ` +
        `environment disagrees with its configuration.`)
    }
    return [key, String(value)] as [string, string]
  })
}

/**
 * Check an agent's `extraMounts` WITHOUT rendering. Returns the first problem
 * as a human-readable string, or null when they are renderable.
 *
 * This exists so a caller that is about to write something can refuse BEFORE
 * writing. `renderExtraMounts` throws, and the settings PUT renders the compose
 * only after the .env and the resources overlay have already landed — a throw
 * there is a 500 on top of partial state. Same rules, same messages, one
 * implementation, so the pre-check and the render can never drift.
 */
export function validateExtraMounts(mounts?: ExtraMount[]): string | null {
  try {
    checkMounts(mounts)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** `validateExtraMounts` for `extraEnv`. See its doc for why this exists. */
export function validateExtraEnv(env?: Record<string, string>): string | null {
  try {
    checkEnv(env)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Render an agent's extra bind mounts as compose `volumes:` entries.
 *
 * Returns lines already indented to 6 spaces, ready to append inside a service
 * `volumes:` block, or '' when there are none. Throws on anything malformed —
 * see `checkMounts` for what "malformed" means and why it fails loudly.
 */
export function renderExtraMounts(mounts?: ExtraMount[]): string {
  return checkMounts(mounts)
    .map(({ hostPath, containerPath, mode, note }) =>
      `${note ? `      # ${note}\n` : ''}      - ${hostPath}:${containerPath}:${mode}\n`)
    .join('')
}

/**
 * Render extra environment variables as compose `environment:` list entries,
 * indented to 6 spaces. Same injection posture as the mounts: a newline in a
 * key or value could append arbitrary compose keys. Reserved names are refused
 * — see RESERVED_EXTRA_ENV_NAMES.
 */
export function renderExtraEnv(env?: Record<string, string>): string {
  return checkEnv(env)
    .map(([key, value]) => `      - ${key}=${value}\n`)
    .join('')
}

export interface ComposeOptions {
  imageOrBuild?: { image: string } | { build: string }
  defaultImage?: string
  vpnEnabled?: boolean
  camofoxImage?: string
  /**
   * Host interface to bind the human-facing VNC port to. The VNC port (noVNC,
   * container 6080) is used ONLY by a human during CAPTCHA escalation — the
   * agent never connects to it — so binding it to loopback by default keeps it
   * off the LAN/tailnet/internet. Set to a Tailscale IP/hostname to allow remote
   * human escalation. Defaults to '127.0.0.1'.
   */
  vncBindHost?: string
  /**
   * Host interface to bind the Camofox control port (container 9377,
   * `port + 1000`) to. This port is UNAUTHENTICATED remote browser control — a
   * bigger exposure than VNC — and the agent reaches Camofox in-namespace
   * (localhost) rather than via this host publish, so binding it to loopback by
   * default keeps it off the LAN/tailnet/internet while host-local tooling still
   * works. Set to a Tailscale IP/hostname only if remote control is needed.
   * Defaults to '127.0.0.1'.
   */
  controlBindHost?: string
  /**
   * Bundle an optional ollama sidecar that runs a tiny model on CPU, so a
   * brand-new agent can use a local model with zero host setup. OFF by default —
   * host-GPU ollama via host.docker.internal:11434 stays the default and is
   * unaffected. When enabled, an `ollama-<name>` service is emitted that pulls
   * and serves `qwen2.5:0.5b` on boot, and the hermes service waits for it to be
   * healthy. CPU-only (no GPU device reservations).
   *
   * NOTE: reachability differs by variant. Plain: http://ollama-<name>:11434.
   * VPN: http://localhost:11434 (shares the wireguard namespace). Whatever writes
   * OLLAMA_BASE_URL must match the variant.
   */
  bundledOllama?: boolean
  /** Image for the bundled ollama sidecar. Defaults to 'ollama/ollama'. */
  ollamaImage?: string
  /**
   * Per-harness memory limit rendered into the hermes service's
   * `deploy.resources.limits.memory`. Docker-compose memory string (e.g. '2G',
   * '6G', '512M'). Defaults to '2G' when omitted. Memory-heavy harnesses (e.g.
   * Matilde MEG runs) OOM-kill under the default — raise this to fit the job.
   */
  memory?: string
  /**
   * Per-harness CPU limit rendered into the hermes service's
   * `deploy.resources.limits.cpus`. Docker-compose cpu string (e.g. '2.0',
   * '4.0'). Defaults to '2.0' when omitted.
   */
  cpus?: string
  /**
   * Extra host→container bind mounts for the hermes service, beyond the data
   * dir and state volume. Persisted on the harness so they survive every
   * regeneration — the whole point (see Harness.extraMounts). Defaults to 'ro'
   * per mount; 'rw' has to be asked for.
   */
  extraMounts?: ExtraMount[]
  /**
   * Extra env vars rendered into the hermes service's `environment:` block.
   * Non-secret only — secrets belong in the agent's .env (env_file).
   */
  extraEnv?: Record<string, string>
}

/** Model the bundled ollama sidecar pulls and serves on boot (tiny, CPU-friendly). */
export const BUNDLED_OLLAMA_MODEL = 'qwen2.5:0.5b'

/**
 * SQLite DB files migrated off the VirtioFS bind mount onto a named Docker
 * volume (#204 PR2). Each has -wal/-shm siblings handled alongside it.
 */
export const MIGRATED_DB_FILES = ['state.db', 'response_store.db', 'kanban.db'] as const

/** Named Docker volume holding an agent's migrated SQLite DBs. */
export function stateVolumeName(agentName: string): string {
  return `hermes-state-${agentName}`
}

/**
 * Top-level `volumes:` trailer declaring the state volume. The explicit `name:`
 * pins the real volume name — without it compose prefixes the project name
 * (the compose file's parent dir), so the same agent would get different
 * volume names depending on where its compose lives, breaking rollback/exec
 * tooling that addresses `hermes-state-<name>`.
 */
export function stateVolumeBlock(agentName: string): string {
  return `
volumes:
  ${stateVolumeName(agentName)}:
    name: ${stateVolumeName(agentName)}
`
}

/**
 * The migration/self-heal shell script the state-init service runs, as plain
 * POSIX sh (unescaped — `stateInitService` compose-escapes `$` on embed).
 * STATE_INIT_DATA / STATE_INIT_STATE env overrides exist ONLY so tests can run
 * the real script against temp dirs; in-container neither is set and the
 * defaults (/opt/data, /state) apply.
 *
 * Script properties (see stateInitService for the service-level contract):
 *   - Regular file at a DB path WINS (first migration, or a `hermes import`
 *     replaced the symlink): copied to the volume over any volume copy, then
 *     re-symlinked.
 *   - Crash-safe ordering: copy all siblings to *.tmp on the volume → rename
 *     (atomic within the volume) → only then delete bind copies, db FIRST so an
 *     interrupted run re-migrates from the intact source instead of stranding
 *     a db without its WAL.
 *   - Fresh harness: symlink is created dangling — SQLite's open(O_CREAT)
 *     follows it and creates the DB on the volume. No empty files are
 *     pre-created (that would defeat the regular-file-wins test forever after).
 *   - Only the .db names are symlinked: SQLite derives -wal/-shm paths from the
 *     RESOLVED path (symlinks followed since SQLite 3.20), so siblings land on
 *     the volume automatically; stale bind-mount siblings are removed.
 */
export const STATE_INIT_SCRIPT = `set -eu
DATA="\${STATE_INIT_DATA:-/opt/data}"
STATE="\${STATE_INIT_STATE:-/state}"
# Volume dir must be writable by whatever uid s6 drops the gateway to; match
# the data dir's ownership (a root-owned fresh volume would break WAL creation
# for a non-root writer).
chown "$(stat -c '%u:%g' "$DATA" 2>/dev/null || echo 0:0)" "$STATE" || true
for db in ${MIGRATED_DB_FILES.join(' ')}; do
  src="$DATA/$db"; dst="$STATE/$db"
  if [ -f "$src" ] && [ ! -L "$src" ]; then
    # Regular file on the bind mount = authoritative (first migration, or a
    # hermes import un-migrated us). It WINS over volume copies.
    for suf in "" -wal -shm; do
      if [ -f "$src$suf" ] && [ ! -L "$src$suf" ]; then
        cp -p "$src$suf" "$dst$suf.tmp"
      else
        rm -f "$dst$suf.tmp"
      fi
    done
    sync
    for suf in "" -wal -shm; do
      if [ -f "$dst$suf.tmp" ]; then mv -f "$dst$suf.tmp" "$dst$suf"; else rm -f "$dst$suf"; fi
    done
    # Delete bind copies: db FIRST so an interrupted run re-migrates from
    # source instead of stranding a db without its WAL.
    rm -f "$src"
    rm -f "$src-wal" "$src-shm"
  fi
  # Idempotent repoint. Dangling on a fresh harness is correct: SQLite O_CREAT
  # follows the link and creates the file on the volume.
  ln -sfn "$dst" "$src"
  # GUARD: a NON-EMPTY regular -wal next to an already-migrated (symlinked) db
  # should be impossible — SQLite >= 3.20 derives -wal from the RESOLVED path,
  # so siblings land on the volume. If one exists anyway (symlink-derivation
  # assumption violated, or a partial restore), it may hold committed
  # transactions: deleting it would be silent data loss. Fail loudly instead —
  # the depends_on gate keeps the agent down until a human looks.
  if [ -f "$src-wal" ] && [ ! -L "$src-wal" ] && [ -s "$src-wal" ]; then
    echo "state-init: REFUSING to delete non-empty $src-wal beside migrated $db (possible un-checkpointed WAL) — manual intervention required" >&2
    exit 1
  fi
  # Orphan siblings on the bind mount are never read (SQLite resolves the
  # symlink and keeps aux files next to the real db) — remove them. (-shm is a
  # shared-memory index, never authoritative data; empty -wal carries nothing.)
  for suf in -wal -shm; do
    if [ -e "$src$suf" ] || [ -L "$src$suf" ]; then rm -f "$src$suf"; fi
  done
done
echo "state-init: migration/symlinks OK"
`

/**
 * One-shot init service that migrates the agent's SQLite DBs from the VirtioFS
 * bind mount (/opt/data) onto the named volume (/state) and leaves symlinks
 * behind (#204 PR2). The hermes service depends_on it with
 * `service_completed_successfully`, so the DBs are always off VirtioFS before
 * the writer starts.
 *
 * Runs STATE_INIT_SCRIPT (see its doc for migration semantics).
 *
 * Reuses the hermes service's own image/build source (`sourceBlock`) — by
 * construction already pulled/built, and guaranteed to carry /bin/sh. The
 * entrypoint override bypasses s6 (`/init` never runs), so the script runs as
 * root, which the chown/moves need. NOTE the service/container name must NOT
 * start with `hermes-`/`seraph-` — discovery (pickContainerAdapter) would claim
 * it as a phantom agent.
 *
 * All shell `$` are escaped as `$$` on embed — docker compose interpolates `$`
 * in compose files, and an unescaped shell variable would be substituted (as
 * empty, with a warning) at compose parse time, not at run time.
 */
export function stateInitService(
  agentName: string,
  agentDataDir: string,
  sourceBlock: string,
): string {
  const vol = stateVolumeName(agentName)
  const embedded = STATE_INIT_SCRIPT
    .replace(/\$/g, '$$$$') // '$' → '$$' (compose interpolation escape)
    .split('\n')
    .map((l) => (l ? '        ' + l : l)) // 8-space indent under the `- |` scalar
    .join('\n')
    .trimEnd()
  return `  state-init-${agentName}:
${sourceBlock}
    container_name: state-init-${agentName}
    restart: "no"
    entrypoint:
      - /bin/sh
      - -c
      - |
${embedded}
    volumes:
      - ${agentDataDir}:/opt/data
      - ${vol}:/state
`
}

/**
 * Default image for the Camofox sidecar in the VPN variant.
 *
 * This is the upstream third-party image (github.com/jo-inc/camofox-browser) —
 * public on GHCR and anonymously pullable. Pinned by tag AND digest so the
 * default can never silently drift or vanish: the previous default
 * (`ghcr.io/nimblecoai/camofox:latest`) never existed under any namespace, so
 * every VPN-enabled agent got a compose that failed only at `docker compose up`
 * (issue #192). Digest verified against ghcr.io on 2026-08-04 (tags `1.13.0`
 * and `latest` both resolved to this digest). Bumping the version means
 * re-verifying the new tag's digest and updating both here.
 */
export const DEFAULT_CAMOFOX_IMAGE =
  'ghcr.io/jo-inc/camofox-browser:1.13.0@sha256:64b30ffdbbc4ae0e28200a66dfbd6f55ac4188229eb34ef769afcf7be40faa6e'

export function generateStandaloneCompose(
  agentName: string,
  port: number,
  agentDataDir: string,
  options?: ComposeOptions,
): string {
  const { imageOrBuild, defaultImage, vpnEnabled, camofoxImage, vncBindHost, controlBindHost, bundledOllama, ollamaImage, memory, cpus, extraMounts, extraEnv } = options ?? {}
  const resolved = imageOrBuild ?? { image: defaultImage || 'ghcr.io/cyborg-garden/hermes-agent-mt:latest' }
  const sourceBlock = 'image' in resolved
    ? `    image: ${resolved.image}`
    : `    build:\n      context: ${resolved.build}\n      dockerfile: Dockerfile`

  // Rendered (and validated) once, before either variant, so a malformed mount
  // fails generation identically in VPN and plain mode.
  const mountLines = renderExtraMounts(extraMounts)
  const envLines = renderExtraEnv(extraEnv)

  if (vpnEnabled) {
    return generateVpnCompose(agentName, port, agentDataDir, sourceBlock, camofoxImage, vncBindHost, controlBindHost, bundledOllama, ollamaImage, memory, cpus, mountLines, envLines)
  }

  return generatePlainCompose(agentName, port, agentDataDir, sourceBlock, bundledOllama, ollamaImage, memory, cpus, mountLines, envLines)
}

/** Render the hermes service's `deploy.resources.limits` block (8-space indented). */
function resourcesBlock(memory?: string, cpus?: string): string {
  return `    deploy:
      resources:
        limits:
          memory: ${memory ?? '2G'}
          cpus: '${cpus ?? '2.0'}'`
}

/**
 * Render the bundled ollama sidecar service block. CPU-only: no GPU device
 * reservations. Pulls and serves a tiny model on boot via a shell entrypoint
 * (serve in background → wait for ready → pull → wait on serve), and exposes a
 * healthcheck so the hermes service can depend_on it being healthy.
 *
 * `networkBlock` is the network attachment lines (already indented to 4 spaces),
 * empty for the plain default network or the wireguard service-network line for
 * the VPN variant — mirrors how camofox is wired in each variant.
 */
export function ollamaSidecar(
  agentName: string,
  agentDataDir: string,
  ollamaImage: string | undefined,
  networkBlock: string,
): string {
  return `  ollama-${agentName}:
    image: ${ollamaImage || 'ollama/ollama'}
    container_name: ollama-${agentName}
    restart: unless-stopped
${networkBlock}    entrypoint:
      - /bin/sh
      - -c
      - |
        ollama serve &
        until ollama list >/dev/null 2>&1; do sleep 1; done
        ollama pull ${BUNDLED_OLLAMA_MODEL}
        wait
    volumes:
      - ${agentDataDir}/.ollama:/root/.ollama
    healthcheck:
      test: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || wget -qO- http://localhost:11434/api/tags >/dev/null 2>&1"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 60s
`
}

function generatePlainCompose(
  agentName: string,
  port: number,
  agentDataDir: string,
  sourceBlock: string,
  bundledOllama?: boolean,
  ollamaImage?: string,
  memory?: string,
  cpus?: string,
  extraMountLines: string = '',
  extraEnvLines: string = '',
): string {
  // Sidecars share the default (named) network, so the hermes service reaches
  // ollama at http://ollama-<name>:11434 — no network_mode needed.
  const ollamaBlock = bundledOllama
    ? ollamaSidecar(agentName, agentDataDir, ollamaImage, '')
    : ''
  const initBlock = stateInitService(agentName, agentDataDir, sourceBlock)
  // depends_on is always emitted now (init gate); map form so the conditional
  // ollama entry can merge in (compose can't mix list + map forms).
  const hermesDepends =
    `    depends_on:\n` +
    (bundledOllama ? `      ollama-${agentName}:\n        condition: service_healthy\n` : '') +
    `      state-init-${agentName}:\n        condition: service_completed_successfully\n`

  return `# Generated by hermes-swarm-map — agent: ${agentName}
services:
${initBlock}${ollamaBlock}  hermes-${agentName}:
${sourceBlock}
    container_name: hermes-${agentName}
    restart: unless-stopped
${hermesDepends}    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - ${agentDataDir}/.env
    environment:
      # The gateway runs as a non-root user; without HOME it falls back to /root
      # (mode 700) and home-relative credential probes (~/.claude/.credentials.json)
      # raise EACCES → "Provider authentication failed". Pin HOME to the mounted
      # data dir so every agent works regardless of image-level ENV.
      - HOME=/opt/data
      - HERMES_HOME=/opt/data
${extraEnvLines}    ports:
      - published: ${port}
        target: 8642
    volumes:
      - ${agentDataDir}:/opt/data
      - ${stateVolumeName(agentName)}:/state
${extraMountLines}    command: gateway
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - NET_BIND_SERVICE
      - SETGID
      - SETUID
${resourcesBlock(memory, cpus)}

networks:
  default:
    name: hermes-${agentName}
${stateVolumeBlock(agentName)}`
}

function generateVpnCompose(
  agentName: string,
  port: number,
  agentDataDir: string,
  sourceBlock: string,
  camofoxImage?: string,
  vncBindHost: string = '127.0.0.1',
  controlBindHost: string = '127.0.0.1',
  bundledOllama?: boolean,
  ollamaImage?: string,
  memory?: string,
  cpus?: string,
  extraMountLines: string = '',
  extraEnvLines: string = '',
): string {
  const camofoxPort = port + 1000
  const vncPort = port + 2000

  // Sidecars share the wireguard network namespace (same as camofox), so the
  // hermes service reaches ollama on localhost:11434 inside that namespace.
  // CAVEAT for callers: in VPN mode the bundled ollama is reachable at
  // http://localhost:11434 — NOT http://ollama-<name>:11434. Any env-writer
  // pairing VPN + bundledOllama must set OLLAMA_BASE_URL accordingly. The plain
  // variant (and the create-new deploy path) use the service-name URL. There is
  // currently no VPN+bundled env-writer, so this is a guard against future drift.
  const ollamaNetworkBlock = `    network_mode: "service:wireguard"\n    depends_on:\n      - wireguard\n`
  const ollamaBlock = bundledOllama
    ? '\n' + ollamaSidecar(agentName, agentDataDir, ollamaImage, ollamaNetworkBlock)
    : ''
  // The state-init gate is unconditional, so depends_on is ALWAYS map form now
  // (compose can't mix list + map forms; `- wireguard` can't coexist with the
  // init condition entry).
  const hermesDepends =
    `    depends_on:\n      wireguard:\n        condition: service_started\n` +
    (bundledOllama ? `      ollama-${agentName}:\n        condition: service_healthy\n` : '') +
    `      state-init-${agentName}:\n        condition: service_completed_successfully\n`
  // Init runs on the default network (no wireguard namespace) — it only touches
  // the two mounts and must not depend on VPN bring-up.
  const initBlock = stateInitService(agentName, agentDataDir, sourceBlock)

  return `# Generated by hermes-swarm-map — agent: ${agentName} (VPN mode)
services:
${initBlock}  wireguard:
    image: lscr.io/linuxserver/wireguard:latest
    container_name: wireguard-${agentName}
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      - net.ipv4.conf.all.src_valid_mark=1
    volumes:
      - ${agentDataDir}/wg-config:/config
    ports:
      - published: ${port}
        target: 8642
      # Camofox control port (9377) is UNAUTHENTICATED remote browser control. The
      # agent reaches Camofox in-namespace (localhost), so this host publish is for
      # host-local tooling only — bind to loopback by default to keep it off the
      # LAN/tailnet. Set controlBindHost to a Tailscale address for remote control.
      - host_ip: ${controlBindHost}
        published: ${camofoxPort}
        target: 9377
      # VNC is human-only (CAPTCHA escalation); bind to loopback by default so it
      # is not exposed on the LAN/tailnet. Set vncBindHost to a Tailscale address
      # to allow remote human escalation.
      - host_ip: ${vncBindHost}
        published: ${vncPort}
        target: 6080

  camofox:
    image: ${camofoxImage || DEFAULT_CAMOFOX_IMAGE}
    container_name: camofox-${agentName}
    restart: unless-stopped
    network_mode: "service:wireguard"
    depends_on:
      - wireguard
    environment:
      - CAMOFOX_PORT=9377
      - ENABLE_VNC=true
      - VNC_BIND=0.0.0.0
      - VNC_RESOLUTION=1280x720
      # Human-in-the-loop flows (VNC checkout/login handoff) generate no API
      # activity, and the camofox server's 5-minute default reaps the browser
      # mid-payment. One hour keeps sessions alive across a human handoff.
      - BROWSER_IDLE_TIMEOUT_MS=3600000
    volumes:
      - ${agentDataDir}/.camofox:/data
${ollamaBlock}
  hermes-${agentName}:
${sourceBlock}
    container_name: hermes-${agentName}
    restart: unless-stopped
    network_mode: "service:wireguard"
${hermesDepends}    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file:
      - ${agentDataDir}/.env
    environment:
      # See generatePlainCompose: pin HOME so non-root credential probes don't
      # hit /root and fail with EACCES ("Provider authentication failed").
      - HOME=/opt/data
      - HERMES_HOME=/opt/data
${extraEnvLines}    volumes:
      - ${agentDataDir}:/opt/data
      - ${stateVolumeName(agentName)}:/state
${extraMountLines}    command: gateway
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - NET_BIND_SERVICE
      - SETGID
      - SETUID
${resourcesBlock(memory, cpus)}

networks:
  default:
    name: hermes-${agentName}
${stateVolumeBlock(agentName)}`
}

/**
 * Surgically replace the hermes service's source block (`image:` line or
 * `build:` block) with `image: <ref>`, leaving everything else — including any
 * wireguard/camofox sidecar images in the VPN variant — untouched. Relies on
 * generateStandaloneCompose always emitting the source block as the FIRST line
 * inside the `hermes-<name>:` service. Used by the image-update (CD) path.
 */
export function setComposeImage(compose: string, image: string): string {
  // A newline here would let the ref inject arbitrary YAML keys under the hermes
  // service (e.g. `privileged: true` + a `/:/host` bind) → host-root breakout (F8).
  assertNoNewline(image, 'image ref')
  const lines = compose.split('\n')
  const svcIdx = lines.findIndex((l) => /^  hermes-[\w.-]+:\s*$/.test(l))
  if (svcIdx < 0 || svcIdx + 1 >= lines.length) {
    throw new Error('setComposeImage: no hermes-<name> service found in compose')
  }
  setServiceSource(lines, svcIdx, image)
  // The state-init service reuses the hermes source block by construction
  // (#204 PR2) — rewrite it too so a CD image pin doesn't leave the init
  // container on a stale (possibly garbage-collected) ref. Optional: pre-PR2
  // composes have no init service.
  const initIdx = lines.findIndex((l) => /^  state-init-[\w.-]+:\s*$/.test(l))
  if (initIdx >= 0 && initIdx + 1 < lines.length) {
    setServiceSource(lines, initIdx, image)
  }
  return lines.join('\n')
}

/** Replace the source block (first line under a service key) with `image: <ref>`. */
function setServiceSource(lines: string[], svcIdx: number, image: string): void {
  const srcIdx = svcIdx + 1
  if (/^ {4}image:\s/.test(lines[srcIdx])) {
    lines[srcIdx] = `    image: ${image}`
    return
  }
  if (/^ {4}build:\s*$/.test(lines[srcIdx])) {
    let end = srcIdx + 1
    // Consume every line nested under build: — any indent deeper than the
    // 4-space service-key level (context:, dockerfile:, args:, 8-space list
    // items, …). Stops at the next 4-space sibling key or a blank line.
    while (end < lines.length && /^ {5,}\S/.test(lines[end])) end++
    lines.splice(srcIdx, end - srcIdx, `    image: ${image}`)
    return
  }
  throw new Error(`setComposeImage: unexpected source block under service "${lines[svcIdx].trim()}": "${lines[srcIdx]}"`)
}

/**
 * Deploy-born compose detection (#204 PR2). generateAgentCompose adds
 * hardening (read_only/tmpfs) and google-MCP wiring that the STANDALONE
 * generator knows nothing about — regenerating such a file via the standalone
 * template silently strips those extras. Callers that regenerate must refuse
 * when this returns true.
 */
export function isDeployBornCompose(compose: string): boolean {
  return (
    /^ {4}read_only: true$/m.test(compose) ||
    compose.includes('google-multiplayer-mcp') ||
    compose.includes('/opt/google/tokens')
  )
}

/**
 * Surgically add the named-volume DB migration wiring (#204 PR2) to an
 * EXISTING compose file, without regenerating it — the only safe way to
 * migrate a live harness, since regeneration via the wrong-lineage generator
 * silently strips extras (deploy-born hardening, google-MCP mounts, VPN
 * sidecars). Inserts:
 *   1. the one-shot state-init service (before the hermes service),
 *   2. `- hermes-state-<name>:/state` in the hermes service's volumes,
 *   3. a `state-init-<name>: condition: service_completed_successfully`
 *      depends_on entry (converting any list-form deps to map form — compose
 *      cannot mix forms),
 *   4. the top-level `volumes:` declaration with a pinned name.
 *
 * Idempotent: returns the input unchanged when the volume wiring is already
 * present. Throws (REFUSES — callers must never fall back to a generator) when
 * an insertion anchor can't be found, e.g. a hand-edited file.
 */
export function addStateMigrationToCompose(
  compose: string,
  agentName: string,
  agentDataDir: string,
): string {
  const vol = stateVolumeName(agentName)
  if (compose.includes(`${vol}:`)) return compose // already migrated

  const refuse = (why: string): never => {
    throw new Error(`migrate-db: cannot transform compose (${why}) — refusing to regenerate; edit the file manually`)
  }

  if (/^volumes:/m.test(compose)) refuse('existing top-level volumes: block')

  const lines = compose.split('\n')
  const svcHeader = `  hermes-${agentName}:`
  const svcIdx = lines.findIndex((l) => l.trimEnd() === svcHeader)
  if (svcIdx < 0) refuse(`no "${svcHeader.trim()}" service found`)

  // Source block for the init service = the hermes service's own image/build.
  const srcIdx = svcIdx + 1
  let sourceBlock: string
  if (/^ {4}image:\s/.test(lines[srcIdx] ?? '')) {
    sourceBlock = lines[srcIdx]
  } else if (/^ {4}build:\s*/.test(lines[srcIdx] ?? '')) {
    let end = srcIdx + 1
    while (end < lines.length && /^ {5,}\S/.test(lines[end])) end++
    sourceBlock = lines.slice(srcIdx, end).join('\n')
  } else {
    return refuse('hermes service does not start with an image:/build: source block')
  }

  // End of the hermes service block: first subsequent line that is non-empty
  // and indented less than 4 spaces (sibling service or top-level key).
  let blockEnd = srcIdx
  while (blockEnd < lines.length && (lines[blockEnd] === '' || /^ {4,}/.test(lines[blockEnd]) || lines[blockEnd].trim() === '')) {
    blockEnd++
  }

  const inBlock = (re: RegExp): number => {
    for (let i = svcIdx + 1; i < blockEnd; i++) if (re.test(lines[i])) return i
    return -1
  }

  // 3. depends_on — merge or insert (do this before other splices so indices
  // stay simple; everything below operates inside the block).
  const initDepends = [
    `      state-init-${agentName}:`,
    '        condition: service_completed_successfully',
  ]
  const depIdx = inBlock(/^ {4}depends_on:\s*$/)
  if (depIdx >= 0) {
    let end = depIdx + 1
    const converted: string[] = []
    while (end < blockEnd && /^ {5,}\S/.test(lines[end])) {
      const listItem = lines[end].match(/^ {6}- (\S+)\s*$/)
      if (listItem) {
        // list form → map form (compose can't mix forms with the init entry)
        converted.push(`      ${listItem[1]}:`, '        condition: service_started')
      } else {
        converted.push(lines[end])
      }
      end++
    }
    const replacement = [...converted, ...initDepends]
    lines.splice(depIdx + 1, end - (depIdx + 1), ...replacement)
    blockEnd += replacement.length - (end - (depIdx + 1))
  } else {
    lines.splice(srcIdx + (sourceBlock.split('\n').length), 0, '    depends_on:', ...initDepends)
    blockEnd += 1 + initDepends.length
  }

  // 2. hermes volumes entry. The service must already mount the data dir.
  const volIdx = inBlock(/^ {4}volumes:\s*$/)
  if (volIdx < 0) refuse('hermes service has no volumes: key')
  let volEnd = volIdx + 1
  while (volEnd < blockEnd && /^ {6}- /.test(lines[volEnd])) volEnd++
  if (volEnd === volIdx + 1) refuse('hermes volumes: list has no entries')
  lines.splice(volEnd, 0, `      - ${vol}:/state`)

  // 1. init service, inserted as a sibling right before the hermes service.
  const initLines = stateInitService(agentName, agentDataDir, sourceBlock).split('\n')
  if (initLines[initLines.length - 1] === '') initLines.pop()
  lines.splice(svcIdx, 0, ...initLines)

  // 4. top-level volumes declaration at the end (stateVolumeBlock leads with
  // a blank-line separator, matching the generators' trailer shape).
  let out = lines.join('\n')
  if (!out.endsWith('\n')) out += '\n'
  return out + stateVolumeBlock(agentName)
}

/** Read the hermes service's image ref from a compose string, or null if it's a build: block (local). */
export function readComposeImage(compose: string): string | null {
  const lines = compose.split('\n')
  const svcIdx = lines.findIndex((l) => /^  hermes-[\w.-]+:\s*$/.test(l))
  if (svcIdx < 0 || svcIdx + 1 >= lines.length) return null
  const m = lines[svcIdx + 1].match(/^ {4}image:\s+(\S+)/)
  return m ? m[1] : null
}

/**
 * Read the hermes service's build-context directory from a compose string, or
 * null if it runs from a prebuilt `image:` (no local build).
 *
 * Handles both forms emitted/seen in the wild:
 *   - long form:  `    build:\n      context: /path`
 *   - shorthand:  `    build: /path`
 *
 * This is the actual filesystem source a `--build` reads from, so it's the
 * authoritative thing to git-sync before a rebuild.
 */
export function readComposeBuildContext(compose: string): string | null {
  const lines = compose.split('\n')
  const svcIdx = lines.findIndex((l) => /^  hermes-[\w.-]+:\s*$/.test(l))
  if (svcIdx < 0 || svcIdx + 1 >= lines.length) return null
  const srcLine = lines[svcIdx + 1]

  // Shorthand: `    build: /path`
  const shorthand = srcLine.match(/^ {4}build:\s+(\S.*)$/)
  if (shorthand) return shorthand[1].trim()

  // Long form: `    build:` then a nested `      context: /path`
  if (/^ {4}build:\s*$/.test(srcLine)) {
    for (let i = svcIdx + 2; i < lines.length && /^ {5,}\S/.test(lines[i]); i++) {
      const ctx = lines[i].match(/^ {6,}context:\s+(\S.*)$/)
      if (ctx) return ctx[1].trim()
    }
  }
  return null
}
