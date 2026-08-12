/**
 * Fleet code-drift detection — "is this agent running old code?".
 *
 * THE INCIDENT THIS EXISTS FOR (2026-08-10). Nothing on the host pulls or
 * rebuilds. Agent code moves only when a human runs a per-agent
 * `docker compose build` + `up -d --force-recreate`. A bug that silently
 * deleted tool results was fixed in the build source, and 11 agents went on
 * running four-day-old code carrying it — for days — because no surface
 * anywhere said "behind". The dashboard was entirely green the whole time.
 *
 * READ-ONLY. This module detects and reports. It never pulls, builds,
 * recreates, or writes anything. There is deliberately no apply path: the
 * failure mode was invisibility, not the absence of a button.
 *
 * HOW PROVENANCE WORKS. hermes-agent-mt's Dockerfile takes an
 * `ARG HERMES_GIT_SHA` and writes it to /opt/hermes/.hermes_build_sha. The
 * build-arg is supplied by DockerService.restart() (see the PROVENANCE note
 * there). So a running container can be asked, from inside, exactly which
 * commit it was built from — and that is compared against the build source's
 * current HEAD.
 *
 * NO STATE RENDERS AS GREEN BY DEFAULT. There are four states and only ONE of
 * them (`current`) is good. Everything else — a container we can't reach, a
 * container built before the build-arg existed, a container whose files were
 * hot-patched after build — reports as unknown or behind. "We could not tell"
 * must never be drawn the same as "we checked and it is fine"; that
 * equivalence is precisely what made the incident invisible.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import type { DockerService } from './docker'
import type { Harness } from '@/lib/types'

/**
 * `current`                — container's baked SHA equals build-source HEAD.
 * `behind`                 — container's baked SHA differs from HEAD (this
 *                            covers "N commits behind" and the rarer rolled-
 *                            back/diverged source; both mean the running code
 *                            is not the code the source would build now).
 * `unknown-no-provenance`  — container is running but cannot tell us its SHA
 *                            (built before the build-arg landed), or the build
 *                            source could not be resolved. NOT green.
 * `unknown-not-running`    — no running container to interrogate. NOT green.
 */
export type DriftState = 'current' | 'behind' | 'unknown-no-provenance' | 'unknown-not-running'

/** Where the agent's code is built from, and how stale that checkout itself is. */
export type BuildSourceHead = {
  dir: string
  /** Full SHA at HEAD, or null when the dir is missing / not a git repo. */
  head: string | null
  branch: string | null
  /** Configured tracking ref (e.g. `origin/main`), or null if none is set. */
  upstream: string | null
  /**
   * Commits HEAD is behind `upstream`, counted against the refs ALREADY on
   * disk. This module never runs `git fetch` — it is read-only observability
   * and must not touch the network or mutate refs — so this is only as fresh
   * as the last fetch anyone did. It is a secondary signal; the primary one
   * (container SHA vs HEAD) needs no fetch at all.
   */
  behindUpstream: number | null
  /** Commit timestamp of HEAD, epoch ms. */
  headCommittedAt: number | null
  error: string | null
}

export type AgentDrift = {
  harnessId: string
  name: string
  /** Compose service key — `hermes-<name>` or `seraph-<name>`. */
  service: string | null
  /** Container name we interrogate; null when nothing is running. */
  container: string | null
  state: DriftState
  /** Full SHA read out of the RUNNING container, null when unavailable. */
  containerSha: string | null
  /** Full SHA at the build source's HEAD, null when unresolvable. */
  sourceSha: string | null
  /** Commits between the container's commit and source HEAD. */
  commitsBehind: number | null
  /** Wall-clock gap between those two commits, in ms. The AGE half of the delta. */
  ageBehindMs: number | null
  /**
   * Files under /opt/hermes were modified after the image was built — someone
   * copied code into the running container. The next recreate silently reverts
   * it, and the baked SHA no longer describes what is running.
   */
  hotPatched: boolean
  buildSource: BuildSourceHead | null
  /** Human-readable reason, especially for the two unknown states. */
  detail: string | null
}

export type FleetDrift = {
  checkedAt: number
  agents: AgentDrift[]
}

/** Path inside the container that the Dockerfile stamps the build SHA into. */
export const BUILD_SHA_PATH = '/opt/hermes/.hermes_build_sha'

/** Container path whose modification breaks provenance (the agent's own code). */
export const AGENT_CODE_PATH = '/opt/hermes/agent'

const ANY_SHA = /^[0-9a-f]{7,40}$/

function expandPath(p: string): string {
  return p.replace(/^~/, os.homedir())
}

// --- compose parsing --------------------------------------------------------

/**
 * Read the FIRST service key, its build context, and its container_name out of
 * a standalone compose file.
 *
 * Deliberately NOT reusing harness-compose's readComposeBuildContext: that one
 * anchors on `^  hermes-[\w.-]+:` and therefore returns null for the three
 * `seraph-*` services, which is exactly the class of agent this module must not
 * miss. Drift detection is service-key agnostic.
 */
export function readComposeService(compose: string): {
  service: string | null
  buildContext: string | null
  containerName: string | null
  image: string | null
} {
  const none = { service: null, buildContext: null, containerName: null, image: null }
  const lines = compose.split('\n')

  // Anchor on the `services:` block: a two-space key elsewhere (e.g. `default:`
  // under `networks:`) is not a service and must never be read as one.
  const servicesIdx = lines.findIndex((l) => /^services:\s*$/.test(l))
  if (servicesIdx < 0) return none

  const svcIdx = lines.findIndex(
    (l, i) => i > servicesIdx && /^ {2}[A-Za-z0-9][\w.-]*:\s*$/.test(l),
  )
  if (svcIdx < 0) return none

  const service = lines[svcIdx].trim().replace(/:$/, '')
  let buildContext: string | null = null
  let containerName: string | null = null
  let image: string | null = null

  // Walk the service's own block: every line indented deeper than the key,
  // stopping at the next top-level or sibling key.
  for (let i = svcIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    // A sibling service key sits at 2 spaces and a top-level key at 0; either
    // ends this service's block.
    if (!/^ {3,}/.test(line)) break

    const shorthand = line.match(/^ {4}build:\s+(\S.*)$/)
    if (shorthand) buildContext = shorthand[1].trim()

    if (/^ {4}build:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length && /^ {5,}\S/.test(lines[j]); j++) {
        const ctx = lines[j].match(/^ {6,}context:\s+(\S.*)$/)
        if (ctx) buildContext = ctx[1].trim()
      }
    }

    const cn = line.match(/^ {4}container_name:\s+(\S.*)$/)
    if (cn) containerName = cn[1].trim()

    const img = line.match(/^ {4}image:\s+(\S.*)$/)
    if (img) image = img[1].trim()
  }

  return { service, buildContext, containerName, image }
}

// --- the three probes -------------------------------------------------------

/**
 * Read the build SHA out of a RUNNING container. Returns null when the file is
 * absent (image predates the build-arg being passed), when the container isn't
 * running, or when the contents aren't sha-shaped — every one of which means
 * "no provenance", never "current".
 */
export async function containerBuildSha(
  docker: Pick<DockerService, 'execInContainer'>,
  container: string,
): Promise<string | null> {
  try {
    const out = await docker.execInContainer(container, ['cat', BUILD_SHA_PATH], 10000)
    const sha = out.trim()
    return ANY_SHA.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Resolve the build source checkout's HEAD and how far behind its own upstream
 * it is. Never fetches (see BuildSourceHead.behindUpstream).
 */
export function buildSourceHead(dir: string): BuildSourceHead {
  const resolved = expandPath(dir)
  const empty: BuildSourceHead = {
    dir: resolved,
    head: null,
    branch: null,
    upstream: null,
    behindUpstream: null,
    headCommittedAt: null,
    error: null,
  }

  if (!fs.existsSync(resolved)) {
    return { ...empty, error: `build source ${resolved} does not exist` }
  }

  const git = (args: string[]): string =>
    execFileSync('git', ['-C', resolved, ...args], { stdio: 'pipe', timeout: 10000 })
      .toString()
      .trim()

  let head: string
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error('not a work tree')
    head = git(['rev-parse', 'HEAD'])
  } catch {
    return { ...empty, error: `build source ${resolved} is not a git repo` }
  }

  let branch: string | null = null
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {}

  let headCommittedAt: number | null = null
  try {
    const secs = parseInt(git(['show', '-s', '--format=%ct', head]), 10)
    if (Number.isFinite(secs)) headCommittedAt = secs * 1000
  } catch {}

  let upstream: string | null = null
  let behindUpstream: number | null = null
  try {
    upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const n = parseInt(git(['rev-list', '--count', `HEAD..${upstream}`]), 10)
    if (Number.isFinite(n)) behindUpstream = n
  } catch {
    // No tracking branch, or the upstream ref isn't on disk. Not fatal — the
    // container-vs-HEAD comparison is the signal that matters.
  }

  return { dir: resolved, head, branch, upstream, behindUpstream, headCommittedAt, error: null }
}

/**
 * True when the agent's own code inside the container differs from the image.
 * Only /opt/hermes paths count — bind mounts (/opt/data, /opt/iris, …) always
 * show up in `docker diff` and are not hot-patching.
 */
export async function hotPatched(
  docker: Pick<DockerService, 'diffContainer'>,
  container: string,
): Promise<boolean> {
  const lines = await docker.diffContainer(container)
  return lines.some((l) => {
    const p = l.replace(/^[ACD]\s+/, '')
    return p === AGENT_CODE_PATH || p.startsWith(AGENT_CODE_PATH + '/')
  })
}

// --- comparison -------------------------------------------------------------

/**
 * How far the container's commit sits behind the build source's HEAD, counted
 * in the source repo. Both numbers are null when the container's commit isn't
 * present in the checkout (e.g. the branch it was built from was deleted) —
 * null means unknown, and unknown must not be drawn as zero.
 */
export function commitGap(
  dir: string,
  containerSha: string,
  sourceSha: string,
): { commitsBehind: number | null; ageBehindMs: number | null; detail: string | null } {
  const resolved = expandPath(dir)
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', resolved, ...args], { stdio: 'pipe', timeout: 10000 })
      .toString()
      .trim()

  try {
    // Fail fast if the container's commit isn't in this checkout at all.
    git(['cat-file', '-e', `${containerSha}^{commit}`])
  } catch {
    return {
      commitsBehind: null,
      ageBehindMs: null,
      detail: `container was built from ${containerSha.slice(0, 12)}, which is not present in ${resolved}`,
    }
  }

  let commitsBehind: number | null = null
  let detail: string | null = null
  try {
    const n = parseInt(git(['rev-list', '--count', `${containerSha}..${sourceSha}`]), 10)
    if (Number.isFinite(n)) commitsBehind = n
  } catch {}

  // The container's commit not being an ancestor of HEAD means the source moved
  // sideways (rollback, force-push, branch switch), not simply forward. Still
  // not `current` — but say so rather than implying a clean N-commits-behind.
  try {
    execFileSync('git', ['-C', resolved, 'merge-base', '--is-ancestor', containerSha, sourceSha], {
      stdio: 'pipe',
      timeout: 10000,
    })
  } catch {
    detail = `container commit ${containerSha.slice(0, 12)} is not an ancestor of build-source HEAD — source has diverged or rolled back`
  }

  let ageBehindMs: number | null = null
  try {
    const cTs = parseInt(git(['show', '-s', '--format=%ct', containerSha]), 10)
    const sTs = parseInt(git(['show', '-s', '--format=%ct', sourceSha]), 10)
    if (Number.isFinite(cTs) && Number.isFinite(sTs)) ageBehindMs = (sTs - cTs) * 1000
  } catch {}

  return { commitsBehind, ageBehindMs, detail }
}

// --- enumeration ------------------------------------------------------------

export type DriftTarget = {
  harnessId: string
  name: string
  service: string | null
  container: string | null
  composeFile: string | null
  running: boolean
}

/** Same id derivation discover() uses, so targets line up with harness rows. */
export function harnessIdForName(name: string): string {
  return 'h_' + name.replace(/-/g, '_')
}

/**
 * Enumerate every agent drift should cover.
 *
 * NOT `docker ps | grep hermes-`. That misses agents twice over: three services
 * are keyed `seraph-doer` / `seraph-generalist` / `seraph-thinker` and never
 * match the prefix, and any agent that is stopped or has never been started has
 * no container to grep at all — and a stopped agent still needs to report
 * `unknown-not-running` rather than vanish from the list.
 *
 * Sources, unioned:
 *   1. the harness registry as the app already sees it (`harness.list()`),
 *      which is overlays (harnesses.json) merged with live discovery;
 *   2. every compose dir under `<dataDir>/compose/*`, which is the only source
 *      that sees an agent with a compose file but no container and no overlay
 *      row — exactly the seraph-* case.
 */
export function driftTargets(opts: {
  harnesses: Harness[]
  composeBaseDir: string
}): DriftTarget[] {
  const byId = new Map<string, DriftTarget>()

  for (const h of opts.harnesses) {
    // Letta agents are Postgres rows, not containers — nothing to build.
    if (h.runtime === 'letta' || h.runtime === 'letta-server') continue
    byId.set(h.id, {
      harnessId: h.id,
      name: h.name,
      service: h.serviceName ?? null,
      container: h.serviceName ?? null,
      composeFile: h.composeFile ?? null,
      running: h.status === 'running',
    })
  }

  let dirs: fs.Dirent[] = []
  try {
    dirs = fs.readdirSync(opts.composeBaseDir, { withFileTypes: true })
  } catch {
    dirs = []
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const composeFile = path.join(opts.composeBaseDir, d.name, 'docker-compose.yml')
    if (!fs.existsSync(composeFile)) continue
    const id = harnessIdForName(d.name)
    const existing = byId.get(id)
    if (existing) {
      // Discovery already knows this one; just make sure it has a compose file
      // to resolve its build source from.
      if (!existing.composeFile) existing.composeFile = composeFile
      continue
    }
    // Compose file with no overlay row and no live container: an agent HSM can
    // build but that Docker has never told us about. Never running by
    // definition here — if it were, discovery would have surfaced it.
    let parsed: ReturnType<typeof readComposeService> = {
      service: null,
      buildContext: null,
      containerName: null,
      image: null,
    }
    try {
      parsed = readComposeService(fs.readFileSync(composeFile, 'utf-8'))
    } catch {}
    byId.set(id, {
      harnessId: id,
      name: d.name,
      service: parsed.service,
      container: parsed.containerName ?? parsed.service,
      composeFile,
      running: false,
    })
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve the build-source dir a target's image would be built from. */
export function resolveBuildSourceDir(
  composeFile: string | null,
  fallbackHermesDir?: string | null,
): string | null {
  if (composeFile) {
    try {
      const parsed = readComposeService(fs.readFileSync(composeFile, 'utf-8'))
      if (parsed.buildContext) return expandPath(parsed.buildContext)
      // Image-only compose: pulled, not built here. No local source to compare.
      if (parsed.image) return null
    } catch {}
  }
  return fallbackHermesDir ? expandPath(fallbackHermesDir) : null
}

// --- the sweep --------------------------------------------------------------

export type DriftDeps = {
  docker: Pick<DockerService, 'execInContainer' | 'diffContainer'>
  /** Injectable for tests; defaults to the real git-backed reader. */
  readHead?: (dir: string) => BuildSourceHead
  /** Injectable for tests; defaults to the real git-backed comparison. */
  gap?: typeof commitGap
}

export async function driftForTarget(
  target: DriftTarget,
  buildSourceDir: string | null,
  deps: DriftDeps,
): Promise<AgentDrift> {
  const readHead = deps.readHead ?? buildSourceHead
  const gap = deps.gap ?? commitGap

  const base: AgentDrift = {
    harnessId: target.harnessId,
    name: target.name,
    service: target.service,
    container: target.container,
    state: 'unknown-no-provenance',
    containerSha: null,
    sourceSha: null,
    commitsBehind: null,
    ageBehindMs: null,
    hotPatched: false,
    buildSource: null,
    detail: null,
  }

  if (!target.running || !target.container) {
    return {
      ...base,
      state: 'unknown-not-running',
      detail: 'no running container — cannot tell what code it would run',
    }
  }

  const [containerSha, patched] = await Promise.all([
    containerBuildSha(deps.docker, target.container),
    hotPatched(deps.docker, target.container),
  ])
  base.containerSha = containerSha
  base.hotPatched = patched

  if (!buildSourceDir) {
    return {
      ...base,
      detail: 'no local build source resolved for this agent (image-only or unconfigured)',
    }
  }

  const source = readHead(buildSourceDir)
  base.buildSource = source
  base.sourceSha = source.head

  if (!source.head) {
    return { ...base, detail: source.error ?? 'build source HEAD could not be resolved' }
  }

  if (!containerSha) {
    return {
      ...base,
      detail: `container has no ${BUILD_SHA_PATH} — it was built before build provenance was recorded, so what it is running cannot be established`,
    }
  }

  if (containerSha === source.head) {
    return {
      ...base,
      state: 'current',
      detail: patched
        ? `built from build-source HEAD, but files under ${AGENT_CODE_PATH} were modified after build — the next recreate will silently revert them`
        : null,
    }
  }

  const g = gap(source.dir, containerSha, source.head)
  return {
    ...base,
    state: 'behind',
    commitsBehind: g.commitsBehind,
    ageBehindMs: g.ageBehindMs,
    detail: g.detail,
  }
}

export async function fleetDrift(opts: {
  harnesses: Harness[]
  composeBaseDir: string
  fallbackHermesDir?: string | null
  deps: DriftDeps
}): Promise<FleetDrift> {
  const targets = driftTargets({ harnesses: opts.harnesses, composeBaseDir: opts.composeBaseDir })

  // Nearly every agent builds from the SAME checkout; resolve each dir's HEAD
  // once per sweep rather than shelling out to git 14 times over.
  const readHead = cachedHeadReader(opts.deps)

  const agents: AgentDrift[] = []
  for (const t of targets) {
    const dir = resolveBuildSourceDir(t.composeFile, opts.fallbackHermesDir)
    agents.push(await driftForTarget(t, dir, { ...opts.deps, readHead }))
  }

  return { checkedAt: Date.now(), agents }
}

function cachedHeadReader(deps: DriftDeps): (dir: string) => BuildSourceHead {
  const inner = deps.readHead ?? buildSourceHead
  const cache = new Map<string, BuildSourceHead>()
  return (dir: string) => {
    const hit = cache.get(dir)
    if (hit) return hit
    const val = inner(dir)
    cache.set(dir, val)
    return val
  }
}
