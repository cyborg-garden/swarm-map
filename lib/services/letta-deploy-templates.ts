/**
 * Letta base-package deploy templating (design §2b, slice A2 / Phase 3).
 *
 * The Letta base package INVERTS the Hermes layering: instead of one container
 * per agent, the Letta server comes up ONCE (a single `letta/letta` container
 * against one Postgres), and each agent is an API POST carrying config — no
 * per-agent compose, port, data dir, or `docker compose up`.
 *
 * This module owns the three pieces the deploy-route Letta branch needs:
 *   1. ensureLettaServer()  — idempotently bring the server up (once per host)
 *   2. defaultAgentConfig() — the opinionated base CreateAgentConfig
 *   3. deployLettaAgent()   — the orchestration the route delegates to
 *
 * LIVE-VALIDATION BOUNDARY (spec §5 Phase 4): the CreateAgentConfig payload and
 * the server's create/list response shapes are docs-verified, not live-verified.
 * Everything here compiles + is unit-tested against a mocked LettaService; the
 * real create round-trip must be confirmed against a running Letta server before
 * this path is considered production-ready. Provider keys are SERVER-WIDE in
 * self-hosted Letta (compose reads ${ANTHROPIC_API_KEY} etc.), so multi-tenant
 * isolation ultimately needs one server per trust boundary (spec §C1) — out of
 * scope for A2, which brings up a single shared server.
 */

import fs from 'fs'
import path from 'path'
import type { DockerService } from './docker'
import { defaultApiBindHost, isValidBindHost } from './harness-compose'
import type { LettaService, CreateAgentConfig, LettaBlock } from './letta'

/** Docker compose project name for the Letta server (stable across deploys). */
export const LETTA_PROJECT = 'letta'
/** Compose service name for the Letta server. */
export const LETTA_SERVICE = 'letta'
/**
 * The server image the compose declares (docker/letta-compose.yml). Pulled
 * explicitly before `up -d` so a first-run ~500MB fetch doesn't blow the
 * compose-up timeout.
 *
 * Pinned to 0.16.8 (spec §C2) — the newest stable numeric tag, exactly what
 * :latest resolved to during the 2026-07-19 live spike, and the last line
 * before Letta's v1-SDK transition (which makes :latest actively dangerous for
 * the /v1/agents/{id}/messages contract the door relies on).
 * Digest for the record: sha256:aa66c3eeee13d2dfc40c650d709b550237ee31bfc91942a52fa488a13fa8c102
 * Keep in sync with the compose `image:` — update both refs together (a
 * drift-guard test string-matches the compose line against this constant).
 */
export const LETTA_IMAGE = 'letta/letta:0.16.8'
/** Default published REST port for the Letta server (the compose default and the client default). */
export const LETTA_DEFAULT_PORT = 8283
/** Default REST base URL — matches the compose-published port and the client default. */
export const LETTA_DEFAULT_BASE_URL = `http://localhost:${LETTA_DEFAULT_PORT}`

/**
 * The modern Letta agent architecture: memory as git-backed context-repo files
 * (memfs), edited via filesystem tools. Letta's team flagged the legacy
 * memory-blocks architecture (`memgpt_agent`) as "a very old style" in direct
 * feedback (2026-07) and are removing the legacy memory tools in favor of memfs
 * (www.letta.com/blog/our-next-phase). The base package defaults here.
 */
export const LETTA_MODERN_AGENT_TYPE = 'letta_v1_agent'
/** Legacy memory-blocks architecture. Only for the airlock `shareable`-block path (Phase 5), pending its memfs remap. */
export const LETTA_LEGACY_AGENT_TYPE = 'memgpt_agent'

/** Repo-relative compose template path; overridable for tests / non-standard layouts. */
export function repoLettaComposePath(): string {
  return path.join(process.cwd(), process.env.LETTA_COMPOSE_FILE || 'docker/letta-compose.yml')
}

/**
 * The Letta server's config directory under the swarm-map data dir (holds the
 * server .env). The default (unnamed) instance lives at `<dataDir>/letta/`;
 * a named instance (spec §C1) at `<dataDir>/letta-<name>/`.
 */
export function lettaServerDir(swarmMapDataDir: string, name?: string): string {
  return path.join(swarmMapDataDir, name ? `letta-${name}` : 'letta')
}

/**
 * Map a Letta model handle's provider prefix to the SERVER-WIDE env var the
 * compose expects. Self-hosted Letta reads provider keys from the server
 * container's environment, not per-agent — so a Letta deploy's "LLM key" is a
 * server key. Handles look like `anthropic/claude-3-5-sonnet`, `openai/gpt-4o`.
 * Returns undefined for handles whose provider we don't map (caller skips key
 * injection; the operator may have configured the server key out-of-band).
 */
export function serverKeyVarForModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const provider = model.includes('/') ? model.split('/', 1)[0].toLowerCase() : ''
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'openai':
      return 'OPENAI_API_KEY'
    default:
      return undefined
  }
}

/** Parse `KEY=value` lines into a map (ignores blanks/comments). Used to merge server .env. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
  }
  return out
}

function serializeEnv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  )
}

/**
 * Write/merge server-level provider keys into the server dir's `.env`, returning
 * the env-file path when one exists (so the caller can pass `--env-file`), or
 * undefined when there's nothing to inject and no prior file (server inherits
 * the host env / compose defaults). MERGES over any existing file so a second
 * agent deploy never blanks the keys an earlier one set (idempotent server).
 */
export function writeServerEnv(
  serverDir: string,
  provided: Record<string, string>,
): string | undefined {
  const envFile = path.join(serverDir, '.env')
  const existing = fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, 'utf-8')) : {}
  const providedNonEmpty = Object.fromEntries(
    Object.entries(provided).filter(([, v]) => v && v.length > 0),
  )
  if (Object.keys(existing).length === 0 && Object.keys(providedNonEmpty).length === 0) {
    return undefined
  }
  const merged = { ...existing, ...providedNonEmpty }
  fs.mkdirSync(serverDir, { recursive: true })
  fs.writeFileSync(envFile, serializeEnv(merged), { mode: 0o600 })
  // writeFileSync's mode only applies when it CREATES the file — on an overwrite
  // of a pre-existing .env the mode is ignored. Force 0600 so a server-wide
  // provider key never sits at looser perms inherited from an earlier file.
  fs.chmodSync(envFile, 0o600)
  return envFile
}

export interface EnsureLettaServerOptions {
  swarmMapDataDir: string
  /** Server-wide provider keys to inject (e.g. { ANTHROPIC_API_KEY: '...' }). */
  serverEnv?: Record<string, string>
  /** REST base URL to health-check; defaults to LETTA_DEFAULT_BASE_URL. */
  baseUrl?: string
  /** Compose template path; defaults to repoLettaComposePath(). */
  composeFile?: string
  /** Health-check budget in ms (server cold-start pulls a ~500MB image first run). */
  timeoutMs?: number
  /**
   * Instance name (spec §C1): scopes the compose project (`letta-<name>`) and
   * the server dir (`<dataDir>/letta-<name>/`) so multiple Letta servers can
   * coexist on one host (one per trust boundary). Omit for the singleton
   * default instance — behavior is then byte-for-byte the pre-C1 default.
   */
  name?: string
  /**
   * Published REST port (spec §C1). Non-default ports are delivered to the
   * compose via LETTA_PORT in the server .env ("${LETTA_BIND_HOST:-127.0.0.1}:${LETTA_PORT:-8283}:8283") and
   * used for the health poll + returned baseUrl. Defaults to LETTA_DEFAULT_PORT.
   */
  port?: number
  /**
   * Host interface the REST port is published on. Defaults to
   * defaultApiBindHost() (loopback on macOS, 0.0.0.0 on Linux, where the
   * Letta door container reaches the brain through the bridge IP). Must be a
   * bare IP. Written as LETTA_BIND_HOST only when it is not the compose's own
   * 127.0.0.1 default.
   */
  bindHost?: string
}

export interface LettaServerInfo {
  composeFile: string
  service: string
  project: string
  baseUrl: string
}

/**
 * Idempotently ensure the Letta server is up and answering. Writes any provided
 * server keys to the server dir's `.env`, runs `docker compose -p letta up -d`
 * (with `--env-file` when keys exist), then polls `GET /v1/agents` for a 200.
 * Called ONCE per host, not per agent — subsequent deploys reconcile a no-op.
 * Throws if the server never becomes reachable.
 */
export async function ensureLettaServer(
  docker: DockerService,
  opts: EnsureLettaServerOptions,
): Promise<LettaServerInfo> {
  const composeFile = opts.composeFile ?? repoLettaComposePath()
  const port = opts.port ?? LETTA_DEFAULT_PORT
  const project = opts.name ? `${LETTA_PROJECT}-${opts.name}` : LETTA_PROJECT
  // Default instance keeps the pre-C1 resolution chain byte-for-byte; a
  // non-default port derives its base URL from the port it publishes on.
  const baseUrl = (
    opts.baseUrl ??
    (port === LETTA_DEFAULT_PORT
      ? process.env.LETTA_BASE_URL ?? LETTA_DEFAULT_BASE_URL
      : `http://localhost:${port}`)
  ).replace(/\/+$/, '')
  const serverDir = lettaServerDir(opts.swarmMapDataDir, opts.name)
  // LETTA_PORT is written only for a non-default port — the compose publishes
  // "${LETTA_BIND_HOST:-127.0.0.1}:${LETTA_PORT:-8283}:8283", so the default instance needs (and gets) no
  // env line, preserving the "no keys → no env-file" behavior.
  const serverEnv: Record<string, string> = { ...(opts.serverEnv ?? {}) }
  if (port !== LETTA_DEFAULT_PORT) serverEnv.LETTA_PORT = String(port)
  // Same pattern for the container name: named instances must not collide on
  // the compose file's `container_name: ${LETTA_CONTAINER_NAME:-letta}` — the
  // default instance keeps the historical `letta` (no env line).
  if (opts.name) serverEnv.LETTA_CONTAINER_NAME = project
  const bindHost = opts.bindHost || defaultApiBindHost()
  if (!isValidBindHost(bindHost)) throw new Error(`Letta bindHost must be a bare IP address, got ${JSON.stringify(bindHost)}`)
  if (bindHost !== '127.0.0.1') serverEnv.LETTA_BIND_HOST = bindHost
  const envFile = writeServerEnv(serverDir, serverEnv)

  // Pull the image first (best-effort): a first-run ~500MB fetch would otherwise
  // blow `up -d`'s timeout. If the pull fails (offline with the image already
  // local), `up` still succeeds; if it's genuinely unavailable, `up` surfaces
  // the error. Mirrors the Hermes deploy path.
  docker.pullImage(LETTA_IMAGE)

  // `docker compose -p <project> [--env-file .env] -f <compose> up -d letta`.
  docker.start(composeFile, LETTA_SERVICE, project, envFile)

  // The server answers GET /v1/agents with a 200 (JSON array) once ready.
  // First run pulls the image, so allow a generous default budget.
  const healthy = docker.healthCheck(`${baseUrl}/v1/agents`, opts.timeoutMs ?? 120_000)
  if (!healthy) {
    throw new Error(
      `Letta server did not become reachable at ${baseUrl} within the timeout — check \`docker compose -p ${project} logs ${LETTA_SERVICE}\`.`,
    )
  }
  return { composeFile, service: LETTA_SERVICE, project, baseUrl }
}

export interface DefaultAgentConfigInput {
  name: string
  /** Letta model handle, e.g. `anthropic/claude-3-5-sonnet`. */
  model: string
  /** Optional persona text. Modern agents seed it as `system`; legacy agents as a persona block. */
  persona?: string
  /** Optional embedding handle. */
  embedding?: string
  /**
   * Opt into the LEGACY memory-blocks architecture (`memgpt_agent`). Off by
   * default — the base package deploys modern memfs agents. The airlock
   * `shareable`-block use-case (Phase 5) is the only intended caller, and only
   * until its memfs (context-repo file) mapping is validated live.
   */
  legacyMemoryBlocks?: boolean
  /** Extra memory blocks — LEGACY only; ignored unless legacyMemoryBlocks is set. */
  extraBlocks?: LettaBlock[]
}

/**
 * The opinionated base CreateAgentConfig for a Letta agent (design §2b).
 *
 * Defaults to the MODERN memfs agent (`letta_v1_agent`): memory lives in the
 * agent's git-backed context repo, managed server-side by filesystem tools — the
 * base package does NOT hand-seed memory_blocks (Letta's team flagged that as the
 * old style). A persona, if given, is passed as `system`.
 *
 * LIVE-VALIDATION BOUNDARY (Phase 4): confirm `letta_v1_agent` accepts this
 * payload and how persona/context-repo seeding is done under memfs. The legacy
 * path (legacyMemoryBlocks) mirrors the demo that shipped and is retained only
 * for the airlock use-case pending its memfs remap.
 */
export function defaultAgentConfig(input: DefaultAgentConfigInput): CreateAgentConfig {
  const persona = input.persona?.trim()

  if (input.legacyMemoryBlocks) {
    const cfg: CreateAgentConfig = {
      name: input.name,
      agent_type: LETTA_LEGACY_AGENT_TYPE,
      model: input.model,
      memory_blocks: [
        { label: 'persona', value: persona && persona.length > 0 ? persona : `You are ${input.name}, a Letta agent deployed via Swarm Map.` },
        { label: 'human', value: '' },
        ...(input.extraBlocks ?? []),
      ],
    }
    if (input.embedding) cfg.embedding = input.embedding
    return cfg
  }

  const cfg: CreateAgentConfig = {
    name: input.name,
    agent_type: LETTA_MODERN_AGENT_TYPE,
    model: input.model,
  }
  if (persona && persona.length > 0) cfg.system = persona
  if (input.embedding) cfg.embedding = input.embedding
  return cfg
}

export interface DeployLettaAgentInput {
  docker: DockerService
  letta: LettaService
  slug: string
  model: string
  persona?: string
  /** Server-wide provider key (paste from the wizard Keys step), injected into the server .env. */
  serverKey?: string
  swarmMapDataDir: string
  /** Host interface for the Letta REST port; see ensureLettaServer's bindHost. */
  bindHost?: string
  baseUrl?: string
  composeFile?: string
  timeoutMs?: number
  /**
   * Optional server-instance selector (spec §C1), passed through to
   * ensureLettaServer. Unused by the deploy route in v1 (which always targets
   * the singleton default instance).
   */
  instance?: { name?: string; port?: number }
}

export interface DeployResult {
  status: number
  body: Record<string, unknown>
}

/**
 * Orchestrate a Letta-runtime deploy (design §3c). Ensures the server, checks
 * the agent name is free (GET /v1/agents — replaces the Hermes fs clobber
 * guard), then creates the agent via REST. Returns a `{ status, body }` the
 * route serializes directly. Never scaffolds a data dir or starts a per-agent
 * container — that's the whole point of the Letta base package.
 */
export async function deployLettaAgent(input: DeployLettaAgentInput): Promise<DeployResult> {
  const { docker, letta, slug, model, persona } = input

  if (!model || model.trim().length === 0) {
    return { status: 400, body: { ok: false, error: 'A Letta model handle is required (e.g. anthropic/claude-3-5-sonnet).' } }
  }
  if (!docker.isAvailable()) {
    return { status: 500, body: { ok: false, error: 'Docker is not available' } }
  }

  // Map the pasted server key to the env var the compose expects for this model's provider.
  const serverEnv: Record<string, string> = {}
  const keyVar = serverKeyVarForModel(model)
  if (keyVar && input.serverKey) serverEnv[keyVar] = input.serverKey

  let server: LettaServerInfo
  try {
    server = await ensureLettaServer(docker, {
      swarmMapDataDir: input.swarmMapDataDir,
      serverEnv,
      baseUrl: input.baseUrl,
      composeFile: input.composeFile,
      timeoutMs: input.timeoutMs,
      name: input.instance?.name,
      port: input.instance?.port,
      bindHost: input.bindHost,
    })
  } catch (err) {
    return { status: 502, body: { ok: false, error: err instanceof Error ? err.message : 'Failed to start the Letta server' } }
  }

  // Clobber check: a Letta agent is identified by name on the shared server.
  // Use the server-side exact-match filter (?name=) — a bare list is paginated,
  // so a same-named agent past the first page would be missed on a busy server.
  // NOTE: self-hosted Letta does not enforce name uniqueness server-side, so
  // this is a best-effort guard against the obvious collision, not a guarantee.
  try {
    const matches = await letta.listAgents({ name: slug })
    if (matches.some((a) => a.name === slug)) {
      return {
        status: 409,
        body: { ok: false, error: `A Letta agent named "${slug}" already exists on the server. Pick a different name, or manage it from the dashboard.` },
      }
    }
  } catch (err) {
    return { status: 502, body: { ok: false, error: `Could not query existing Letta agents: ${err instanceof Error ? err.message : String(err)}` } }
  }

  let agent
  try {
    agent = await letta.createAgent(defaultAgentConfig({ name: slug, model, persona }))
  } catch (err) {
    return { status: 502, body: { ok: false, error: `Letta agent creation failed: ${err instanceof Error ? err.message : String(err)}` } }
  }

  return {
    status: 200,
    body: {
      ok: true,
      runtime: 'letta',
      harnessId: `h_letta_${agent.id}`,
      agentId: agent.id,
      baseUrl: server.baseUrl,
    },
  }
}
