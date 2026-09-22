import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import type { Harness, HarnessStatus, HabitatTier, RestartMode } from '@/lib/types'
import { generateDefaultConfig } from '@/lib/templates/config-yaml'
import type { Storage } from './storage'
import type { DockerService } from './docker'
import type { AuditService } from './audit'
import type { ConfigService } from './config'
import { getCostToday, getInvocationsToday } from './usage'
import { markRestarting, isRestarting, clearRestarting } from './restart-tracker'
import { installBaselineTemplates } from './templates'
import { defaultEnabledPlugins, loadManifest, type InstallResult } from './artifacts-manifest'
import { planArtifactSync, applyArtifactSync, ensurePluginsEnabled, SyncResult } from './artifacts-sync'
import { getUseCaseTemplate, reapplyUseCaseTemplate as reapplyTemplateToDataDir } from './usecase-templates'
import type { ToolsService } from './tools'
import { generateStandaloneCompose, setComposeImage, readComposeImage, readComposeBuildContext, stateVolumeName, MIGRATED_DB_FILES } from './harness-compose'
import { isStateDbMigrated } from './db-path'
import { RegistryService, parseImageRef } from './registry'
import type { ContainerRuntimeAdapter } from './runtime-adapter'

const DEFAULT_IMAGE_REPO = 'cyborg-garden/hermes-agent-mt'
import { hsmBaseUrl } from './hsm-url'
import { PLATFORM_ENV_KEYS as SURFACE_STRIP_BY_PLATFORM, MENTION_GATING_VARS } from '@/lib/surfaces/derive'

const HARNESSES_FILE = 'harnesses.json'

// Services that are infrastructure, not Hermes agents — skip during discovery
const EXCLUDED_SERVICES = new Set(['litellm', 'vertex-proxy'])

// Default port for new agents — Hermes standard is 8642+
const BASE_PORT = 8642
const PORT_STEP = 10

// Per-platform mention-gating env vars. An empty value (KEY=) reads as false at
// runtime (gateway/platforms/signal.py), but HSM's secure default is
// require-mention — so an imported/legacy .env with a bare KEY= would silently
// un-gate the agent while the UI still showed "@mention only".
// Derived from the surface registry (lib/surfaces) — one var per platform.
const MENTION_GATING_ENV_VARS = Object.values(MENTION_GATING_VARS)

// Rewrite any empty (or whitespace-only) mention-gating value to the secure
// default 'true', so the stored value is unambiguous and the runtime gate
// matches the UI. Absent lines and explicit values (including 'false', a
// deliberate respond-to-all choice) are left untouched.
export function normalizeEmptyMentionGating(envContent: string): string {
  let out = envContent
  for (const v of MENTION_GATING_ENV_VARS) {
    // [ \t\r]* so a CRLF .env (KEY=\r\n) heals too — without \r the trailing
    // carriage return defeats the end-of-line anchor.
    out = out.replace(new RegExp(`^(${v})=[ \\t\\r]*$`, 'm'), '$1=true')
  }
  return out
}

// Parse a .env file into key=value pairs
function parseEnvFilePairs(envPath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const varName = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (varName && value) result[varName] = value
    }
  } catch {}
  return result
}

// Normalize a harness name to a lowercase slug. Docker image/service/network
// references must be lowercase, and macOS's case-insensitive filesystem makes a
// capitalized name (e.g. "Mare") collide with its lowercase compose/data dirs —
// so a duplicate silently reuses the capitalized compose and `up` then fails
// with "no such service: hermes-mare". Forcing lowercase at creation prevents
// the whole class. This is the single naming convention — the wizard deploy
// route and the duplicate route's pre-existence check import it too.
export function toHarnessSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Default source of Docker-published host ports. Uses `docker ps -a` (NOT just
// running containers) so a STOPPED agent's published port is still counted —
// a stopped agent is still "using" that host port the moment it's restarted, and
// reassigning it would make the restart fail with "port is already allocated".
// The `0.0.0.0:(\d+)->` binding format is emitted for created/exited containers
// too, so stopped agents are caught here; the .env scan (source 3) is the
// belt-and-suspenders catch-all for anything docker doesn't surface.
function dockerPublishedPorts(): number[] {
  const ports: number[] = []
  try {
    const output = execSync('docker ps -a --format "{{.Ports}}"', { timeout: 5000 }).toString()
    for (const match of output.matchAll(/0\.0\.0\.0:(\d+)->/g)) {
      ports.push(parseInt(match[1], 10))
    }
  } catch {}
  return ports
}

// Scan every managed agent's data dir for its declared API_SERVER_PORT. This is
// the robust catch-all for the cyborg↔personal collision: the monolithic
// `personal` agent lives at ~/.hermes, declares its port only in its own .env,
// and has NO compose file under composeBaseDir — so neither the compose scan nor
// (when stopped) docker would ever surface its 8642, and a new agent could be
// handed the same port. Enumerates ~/.hermes plus every ~/.hermes-<name>
// sibling and reads API_SERVER_PORT from each .env. Defensive throughout:
// a missing home dir, missing .env, or unparseable value is simply skipped.
function agentEnvPorts(homeDir: string): number[] {
  const ports: number[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true })
  } catch {
    return ports
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Match the personal agent (~/.hermes) and per-agent dirs (~/.hermes-<name>).
    if (entry.name !== '.hermes' && !entry.name.startsWith('.hermes-')) continue
    const envPath = path.join(homeDir, entry.name, '.env')
    const pairs = parseEnvFilePairs(envPath)
    const raw = pairs['API_SERVER_PORT']
    if (!raw) continue
    const p = parseInt(raw, 10)
    if (!isNaN(p)) ports.push(p)
  }
  return ports
}

export interface UsedPortsOptions {
  composeBaseDir: string
  // Ports allocated-but-not-yet-observable (persisted in harnesses.json but whose
  // compose file hasn't been written / container not yet created). Seeding these
  // prevents two near-concurrent creates from both deriving the same BASE_PORT.
  reservedPorts?: number[]
  // Home dir to scan for agent `.env` files. Injectable for tests; defaults to
  // the real home so production picks up ~/.hermes* automatically.
  homeDir?: string
  // Source of Docker-published ports. Injectable for tests (mock without a real
  // daemon); defaults to `docker ps -a`.
  dockerPorts?: () => number[]
}

// Collect every host port currently claimed by any source, so port assignment
// never hands out one already in use. Sources:
//   1. `published:` ports in per-agent compose files under composeBaseDir
//   2. Docker-published ports (running AND stopped containers, via `docker ps -a`)
//   3. API_SERVER_PORT declared in each agent's .env (catches the monolithic
//      `personal` agent and any agent whose compose isn't under composeBaseDir)
//   + any explicitly reserved (in-flight) ports.
// Exported so the used-port scan is unit-testable in isolation.
export function collectUsedPorts(opts: UsedPortsOptions): Set<number> {
  const {
    composeBaseDir,
    reservedPorts = [],
    homeDir = os.homedir(),
    dockerPorts = dockerPublishedPorts,
  } = opts

  const usedPorts = new Set<number>(reservedPorts.filter((p): p is number => typeof p === 'number'))

  // Source 1: standalone compose files
  try {
    const entries = fs.readdirSync(composeBaseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const composePath = path.join(composeBaseDir, entry.name, 'docker-compose.yml')
      try {
        const content = fs.readFileSync(composePath, 'utf-8')
        const portMatch = content.match(/published:\s*(\d+)/g)
        if (portMatch) {
          for (const m of portMatch) {
            const p = parseInt(m.replace('published:', '').trim(), 10)
            if (!isNaN(p)) usedPorts.add(p)
          }
        }
      } catch {}
    }
  } catch {}

  // Source 2: live/stopped Docker containers (catches monolithic compose)
  try {
    for (const p of dockerPorts()) {
      if (!isNaN(p)) usedPorts.add(p)
    }
  } catch {}

  // Source 3: every managed agent's declared API_SERVER_PORT
  for (const p of agentEnvPorts(homeDir)) {
    usedPorts.add(p)
  }

  return usedPorts
}

// Find the next free host port, stepping by PORT_STEP from BASE_PORT over every
// port collectUsedPorts reports as claimed. Accepts the same options object.
export function nextAvailablePort(opts: UsedPortsOptions): number {
  const usedPorts = collectUsedPorts(opts)
  let port = BASE_PORT
  while (usedPorts.has(port)) {
    port += PORT_STEP
  }
  return port
}

// Fail loud before writing a compose file if `port` is already claimed by another
// persisted overlay. This is the last line of defense against double-assignment:
// nextAvailablePort now seeds reserved ports, but the import path honors a port
// declared in an agent's own .env (API_SERVER_PORT) which can collide — refuse
// rather than write a compose that binds an already-taken host port (the agent
// would otherwise hang in "Created" with no network).
function assertPortAvailable(overlays: Partial<Harness>[], port: number, selfId: string): void {
  const clash = overlays.find((h) => h.id !== selfId && h.apiPort === port)
  if (clash) {
    throw new Error(
      `Port ${port} already assigned to harness "${clash.name ?? clash.id}" — refusing to create colliding harness`,
    )
  }
}

// Directories to skip when duplicating an agent (caches, build artifacts, ephemeral state)
const COPY_SKIP_DIRS = new Set(['.cache', 'node_modules', '__pycache__', '.venv'])

// Surface-specific env vars stripped from duplicates to prevent two harnesses sharing one surface
// The surface vars a DUPLICATED agent must NOT inherit from its source — the
// credential + identity-bound (admission) set, derived from the single surface
// registry classification (lib/surfaces), the same set disconnect strips.
// Deriving it fixed drift D4: the old hand-maintained list here omitted
// MATTERMOST_ADMIN_USERS, DISCORD_ALLOWED_ROLES and DISCORD_IGNORED_CHANNELS,
// so a clone silently inherited the source's Mattermost admins and Discord
// role/ignored-channel policy. Behavioral prefs (REQUIRE_MENTION, etc.) are
// deliberately NOT in this set and DO carry to the clone.
const SURFACE_ENV_VARS = Object.values(SURFACE_STRIP_BY_PLATFORM).flat()

// Recursively copy a directory (sync — used by duplicateOverlay for full agent dir copies)
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    if (COPY_SKIP_DIRS.has(entry.name)) continue
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    try {
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(srcPath)
        fs.symlinkSync(target, destPath)
      } else if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    } catch {
      // Skip files that vanish during copy (volatile caches, broken symlinks)
    }
  }
}

// Write scaffold files for a brand-new agent data directory
// Standard SOUL.md content for a fresh agent identity. Shared by scaffold (create)
// and duplicate so a duplicated agent gets its own identity rather than the source's.
function defaultSoulContent(name: string): string {
  return `# ${name}

You are **${name}**, a Hermes agent in a multi-tenant deployment managed by Swarm Map.

## How You Work

**Multi-platform:** You serve users across Signal, Telegram, Mattermost, and other platforms simultaneously. Each platform connection is independent.

**Memory isolation:** Your memory is scoped per-context. What you learn in one group chat stays in that group. You maintain separate context for each conversation thread. If someone asks "what did we talk about last time?" — you recall only what happened in THAT specific chat.

**Session lifecycle:** Your conversations reset after 24 hours of inactivity or at 4 AM daily. This keeps you fast and prevents runaway costs. Important context is preserved in your per-context memory.

**Skills are global:** Skills you learn or create are available across all your conversations. A skill learned in one group benefits everyone.

**Group approval:** You only respond in groups that your admin has approved. If you're added to a new group, you'll check with HSM before engaging.

## Behavioral Defaults

- Be helpful, direct, and honest
- When you don't know something, say so clearly
- Never reference or leak information between different conversations
- You can share that you run on Hermes if asked about your system
- Use \`/model\` to check or switch your AI model
- Use \`/memory\` to review what you remember about this conversation
- If you're unsure whether something is appropriate to share across contexts, don't

## Your Admin

Your admin manages you through HSM. They can:
- Approve/deny groups you can participate in
- Monitor your usage and costs
- Update your configuration and model
- Manage your API keys and budget

## Personality

Customize this section to give ${name} a distinct voice, tone, and purpose.
What kind of assistant should ${name} be? Formal? Casual? Technical? Creative?
`
}

async function scaffoldAgentDir(dataDir: string, name: string, port: number): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true })

  // .env with placeholder API key section
  const hsmUrl = hsmBaseUrl()
  const envContent = `# Hermes Agent: ${name}
# Generated by hermes-swarm-map

ANTHROPIC_API_KEY=
API_SERVER_PORT=${port}

# HSM policy endpoint
HSM_URL=${hsmUrl}
SWARM_MAP_POLICY_URL=${hsmUrl}

# Agent identity & memory
HERMES_MEMORY_SCOPE=channel
HERMES_AGENT_NAME=${name}
HERMES_HOME_CHANNEL=

# Web extraction (self-hosted Firecrawl — no API key needed)
FIRECRAWL_API_URL=http://host.docker.internal:3002

# Platform integration (uncomment as needed)
# MATTERMOST_TOKEN=
# MATTERMOST_URL=
# MATTERMOST_ALLOWED_USERS=
# MATTERMOST_ALLOWED_CHANNELS=
# TELEGRAM_BOT_TOKEN=

# Policy defaults (secure by default)
HERMES_DM_POLICY=approved-only
HERMES_APPROVAL_ADMIN_ONLY=true
SIGNAL_REQUIRE_MENTION=true
TELEGRAM_REQUIRE_MENTION=true
MATTERMOST_REQUIRE_MENTION=true
SIGNAL_GROUP_INVITE_POLICY=approved-only
`
  const envPath = path.join(dataDir, '.env')
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, envContent, { mode: 0o600 })
  }

  // config.yaml with opinionated defaults
  const configContent = generateDefaultConfig({
    provider: 'anthropic',
    primaryModel: 'claude-sonnet-4-5',
    enabledPlugins: defaultEnabledPlugins(),
  })
  const configPath = path.join(dataDir, 'config.yaml')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, configContent, 'utf-8')
  }

  // SOUL.md with operational awareness template
  const soulPath = path.join(dataDir, 'SOUL.md')
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, defaultSoulContent(name), 'utf-8')
  }

  // BOOT.md with startup checklist template
  const bootPath = path.join(dataDir, 'BOOT.md')
  if (!fs.existsSync(bootPath)) {
    const bootContent = `# Boot Checklist

On startup, verify your operational readiness:

1. **Check HSM connection** — Can you reach your management server? If not, note it but continue (you can still operate, just without group policy updates).

2. **Review your memory** — Check if you have any persistent memories from previous sessions. If this is your first boot, that's expected.

3. **Verify skills** — Run a quick skills check. Note any skills that failed to load.

4. **Status report** — If everything is nominal, reply with [SILENT]. Only report if something needs attention.

If this is your very first startup ever, introduce yourself briefly in your home channel (if configured).
`
    fs.writeFileSync(bootPath, bootContent, 'utf-8')
  }

  // memories directory
  fs.mkdirSync(path.join(dataDir, 'memories'), { recursive: true })

  // Install baseline plugins and hooks from templates
  await installBaselineTemplates(dataDir)
}

function expandPath(p: string): string {
  return p.replace(/^~/, os.homedir())
}

// Resolve image or build context from settings
function resolveImageOrBuild(settings?: { useLocalBuild?: boolean; hermesDir?: string }): { image: string } | { build: string } | undefined {
  if (!settings?.useLocalBuild || !settings.hermesDir) return undefined
  const resolved = expandPath(settings.hermesDir)
  try {
    const dockerfilePath = path.join(resolved, 'Dockerfile')
    if (fs.existsSync(dockerfilePath)) {
      return { build: resolved }
    }
  } catch {}
  return undefined
}

function containerNameToHarnessName(containerName: string): string {
  // hermes-personal → personal, seraph-thinker → seraph-thinker
  return containerName.replace(/^hermes-/, '')
}

function stateToStatus(state: string): HarnessStatus {
  switch (state) {
    case 'running': return 'running'
    case 'exited': return 'stopped'
    case 'restarting': return 'error'
    case 'created': return 'idle'
    default: return 'stopped'
  }
}

export function readModelConfig(dataDir: string): string[] {
  try {
    const configPath = path.join(dataDir, 'config.yaml')
    const content = fs.readFileSync(configPath, 'utf-8')
    const lines = content.split('\n')

    const models: string[] = []
    let inModelSection = false
    let inAuxSection = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Detect top-level sections (no leading spaces). A flow-form header
      // (`model: {provider: x, default: y}`) carries its whole body inline.
      if (MODEL_HEADER.test(line)) {
        const flow = line.match(FLOW_MAP)
        if (flow) {
          for (const [key, raw] of parseFlowPairs(flow[1])) {
            const val = yamlScalar(raw)
            if (!val || models.includes(val)) continue
            if (key === 'default') models.unshift(val)
            else if (key === 'fallback') models.push(val)
          }
          continue
        }
        inModelSection = true
        inAuxSection = false
        continue
      }
      if (/^auxiliary:/.test(line)) {
        inAuxSection = true
        inModelSection = false
        continue
      }
      // Any new top-level key ends both sections
      if (/^\w/.test(line) && !trimmed.startsWith('#')) {
        inModelSection = false
        inAuxSection = false
      }

      if (inModelSection) {
        const defaultMatch = trimmed.match(/^default:\s*(.+)$/)
        if (defaultMatch) {
          const val = yamlScalar(defaultMatch[1])
          if (val && !models.includes(val)) {
            models.unshift(val) // primary model goes first
          }
        }
        const fallbackMatch = trimmed.match(/^fallback:\s*(.+)$/)
        if (fallbackMatch) {
          const val = yamlScalar(fallbackMatch[1])
          if (val && !models.includes(val)) {
            models.push(val)
          }
        }
      }

      // Auxiliary models — look for `model:` under nested keys
      if (inAuxSection) {
        const modelMatch = trimmed.match(/^model:\s*(.+)$/)
        if (modelMatch) {
          const val = yamlScalar(modelMatch[1])
          if (val && !models.includes(val)) {
            models.push(val)
          }
        }
      }
    }

    return models
  } catch {
    return []
  }
}

export type FallbackProvider = {
  provider: string
  model: string
  base_url?: string
}

/**
 * Matches the top-level `fallback_providers:` / `model:` headers in every
 * form a hand-edited file uses: bare (`model:`), with a trailing comment
 * (`fallback_providers:  # note`), or flow (`fallback_providers: []`,
 * `model: {provider: x, default: y}`). Shared with the cascade writer so the
 * readers and the writer can never disagree about what a header looks like —
 * a header the writer failed to recognise got a second block appended below
 * it (#149, and again for the flow forms in r3).
 */
export const FALLBACK_PROVIDERS_HEADER = /^fallback_providers:(\s|$)/
export const MODEL_HEADER = /^model:(\s|$)/
/** The inline body of a flow-form header: `key: {a: 1}` → group 1 = `a: 1`; `key: [..]` → group 1 = `..`. */
export const FLOW_MAP = /^[\w-]+:\s*\{(.*)\}/
export const FLOW_SEQ = /^[\w-]+:\s*\[(.*)\]/

/**
 * A YAML scalar as these line readers understand it: surrounding quotes
 * stripped, a trailing ` # comment` dropped (a `#` glued to the value —
 * `qwen3:30b#q4` — is part of it), a value that IS a comment → ''.
 */
export function yamlScalar(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('"') || s.startsWith("'")) {
    const close = s.indexOf(s[0], 1)
    if (close > 0) return s.slice(1, close)
    return s.replace(/^["']|["']$/g, '')
  }
  if (s.startsWith('#')) return ''
  return s.replace(/\s+#.*$/, '').trim()
}

/** `key: value` pairs of a flow mapping body (`{…}` without the braces). Values are raw — quote-aware, quotes kept. */
export function parseFlowPairs(body: string): Array<[string, string]> {
  return [...body.matchAll(/([\w-]+):\s*("[^"]*"|'[^']*'|[^,}]*)/g)].map((m) => [m[1], m[2].trim()])
}

/** Each `{…}` mapping of a flow sequence body (`[…]` without the brackets), as flow pairs. */
export function parseFlowMaps(body: string): Array<Array<[string, string]>> {
  return [...body.matchAll(/\{([^}]*)\}/g)].map((m) => parseFlowPairs(m[1]))
}

/**
 * Rows of the first fallback_providers: block — provider / model / base_url
 * ONLY. An inline `api_key:` is read past and never returned: these rows go
 * straight into GET/PUT /api/harnesses/:id/models responses and the editor
 * echoes them back as expected_fallback_providers, so returning it put proxy
 * credentials in front of every dashboard viewer. The cascade writer carries
 * the key inside the file by line, without ever reading its value here.
 */
export function readFallbackProviders(dataDir: string): FallbackProvider[] {
  try {
    const configPath = path.join(dataDir, 'config.yaml')
    const content = fs.readFileSync(configPath, 'utf-8')
    const lines = content.split('\n')

    const providers: FallbackProvider[] = []
    let inSection = false
    let current: Partial<FallbackProvider> | null = null

    for (const line of lines) {
      const trimmed = line.trim()

      // Detect the fallback_providers: top-level key (a trailing comment is
      // still a bare header — `fallback_providers:  # note`). A flow-form
      // header (`fallback_providers: []`, `[{…}, {…}]`) IS the whole block:
      // its rows are read inline and nothing below it belongs to it.
      if (FALLBACK_PROVIDERS_HEADER.test(line)) {
        const flow = line.match(FLOW_SEQ)
        if (flow) {
          for (const pairs of parseFlowMaps(flow[1])) {
            const row: Record<string, string> = {}
            for (const [key, raw] of pairs) {
              const val = yamlScalar(raw)
              if (val) row[key] = val
            }
            if (row.provider && row.model) {
              const entry: FallbackProvider = { provider: row.provider, model: row.model }
              if (row.base_url) entry.base_url = row.base_url
              providers.push(entry)
            }
          }
          continue
        }
        inSection = true
        continue
      }

      // Any new top-level key ends the section
      if (inSection && /^\w/.test(line) && !trimmed.startsWith('#')) {
        inSection = false
        // Flush last entry
        if (current?.provider && current?.model) {
          const entry: FallbackProvider = { provider: current.provider, model: current.model }
          if (current.base_url) entry.base_url = current.base_url
          providers.push(entry)
        }
        current = null
        continue
      }

      if (!inSection) continue

      // New list item starts with "- "
      if (trimmed.startsWith('- ')) {
        // Flush previous entry
        if (current?.provider && current?.model) {
          const entry: FallbackProvider = { provider: current.provider, model: current.model }
          if (current.base_url) entry.base_url = current.base_url
          providers.push(entry)
        }
        current = {}
        const rest = trimmed.slice(2).trim()
        // Flow-style item: `- {provider: ollama, model: x, base_url: y}`
        const flow = rest.match(/^\{(.*)\}$/)
        if (flow) {
          for (const [key, raw] of parseFlowPairs(flow[1])) {
            const val = yamlScalar(raw)
            if (val) (current as Record<string, string>)[key] = val
          }
          continue
        }
        // Parse the key on the same line as "- "
        const kv = rest.match(/^(\w+):\s*(.+)$/)
        if (kv) {
          const key = kv[1] as keyof FallbackProvider
          const val = yamlScalar(kv[2])
          if (val) (current as Record<string, string>)[key] = val
        }
        continue
      }

      // Continuation line for current entry (indented, no "- ")
      if (current && trimmed) {
        const kv = trimmed.match(/^(\w+):\s*(.+)$/)
        if (kv) {
          const key = kv[1] as keyof FallbackProvider
          const val = yamlScalar(kv[2])
          if (val) (current as Record<string, string>)[key] = val
        }
      }
    }

    // Flush last entry
    if (current?.provider && current?.model) {
      const entry: FallbackProvider = { provider: current.provider, model: current.model }
      if (current.base_url) entry.base_url = current.base_url
      providers.push(entry)
    }

    return providers
  } catch {
    return []
  }
}

export function readModelProvider(dataDir: string): string {
  try {
    const configPath = path.join(dataDir, 'config.yaml')
    const content = fs.readFileSync(configPath, 'utf-8')
    const lines = content.split('\n')

    let inModelSection = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (MODEL_HEADER.test(line)) {
        const flow = line.match(FLOW_MAP)
        if (flow) {
          const prov = parseFlowPairs(flow[1]).find(([key]) => key === 'provider')
          return prov ? yamlScalar(prov[1]) : ''
        }
        inModelSection = true
        continue
      }
      if (/^\w/.test(line) && !trimmed.startsWith('#')) { inModelSection = false }
      if (inModelSection) {
        const provMatch = trimmed.match(/^provider:\s*(.+)$/)
        if (provMatch) return yamlScalar(provMatch[1])
      }
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Read the set of env-var NAMES configured (with a real value) in an agent's
 * .env file. Used to decide which model providers the agent can actually serve.
 *
 * Mirrors keys.ts `parseEnvFile` semantics: skips comments/blank lines and
 * entries whose value is empty or an unexpanded `${...}` reference (a value the
 * runtime can't authenticate with). Returns names only — never reads values
 * into memory. Missing/unreadable .env → empty set (callers fail open).
 */
export function readAgentEnvVarNames(dataDir: string): Set<string> {
  const names = new Set<string>()
  try {
    const envPath = path.join(dataDir, '.env')
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const varName = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (varName && value && !value.startsWith('${')) {
        names.add(varName)
      }
    }
  } catch {
    // No .env / unreadable → empty set. Credential validation fails open.
  }
  return names
}

function readSoul(dataDir: string, maxChars = 200): string {
  try {
    const soulPath = path.join(dataDir, 'SOUL.md')
    const content = fs.readFileSync(soulPath, 'utf-8')
    // Strip markdown headers/lines, grab first meaningful text
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('---'))
    const text = lines.join(' ').slice(0, maxChars)
    return text || ''
  } catch {
    return ''
  }
}

function getComposeFilesForDir(hermesDir: string): string[] {
  const expanded = expandPath(hermesDir)
  try {
    const entries = fs.readdirSync(expanded)
    return entries
      .filter((f) => f.startsWith('docker-compose') && f.endsWith('.yml'))
      .map((f) => path.join(expanded, f))
  } catch {
    return []
  }
}

// Map service name to the data directory where its SOUL.md lives
export function guessDataDir(serviceName: string, containerName: string): string {
  // hermes-personal → ~/.hermes (the default/personal instance)
  // hermes-osint → ~/.hermes-osint
  // seraph-thinker → ~/.hermes-seraph-thinker
  const home = os.homedir()
  if (containerName === 'hermes-personal' || serviceName === 'hermes-personal') {
    return path.join(home, '.hermes')
  }
  if (!serviceName) {
    return path.join(home, '.hermes-' + (containerName || 'unknown'))
  }
  if (serviceName.startsWith('hermes-')) {
    return path.join(home, '.' + serviceName)
  }
  // seraph-* agents
  if (serviceName.startsWith('seraph-')) {
    return path.join(home, '.hermes-' + serviceName)
  }
  return path.join(home, '.hermes-' + serviceName)
}

// --- Container-runtime seam (design §1b) ------------------------------------
// The Hermes adapter is a behavior-preserving wrapper around the module
// functions discover() already calls inline. Extracting them behind
// ContainerRuntimeAdapter lets discover() dispatch on runtime instead of
// hardcoding the `hermes-`/`seraph-` prefix. readSoul/guessDataDir/
// readModelConfig are module-local, so this delegates with ZERO behavior change.
export const hermesAdapter: ContainerRuntimeAdapter = {
  runtime: 'hermes',
  // Preserves the exact gate from discover(): hermes-* and seraph-* containers.
  matches: (containerName) =>
    containerName.startsWith('hermes-') || containerName.startsWith('seraph-'),
  dataDir: (serviceName, containerName) => guessDataDir(serviceName, containerName),
  readPersona: (dataDir) => readSoul(dataDir),
  readModels: (dataDir) => readModelConfig(dataDir),
  serviceName: (name) => `hermes-${name}`,
  generateCompose: (name, port, dataDir, options) =>
    generateStandaloneCompose(name, port, dataDir, options),
  scaffold: (dataDir, name, port) => scaffoldAgentDir(dataDir, name, port),
  readImageRef: (compose) => readComposeImage(compose),
  setImageRef: (compose, ref) => setComposeImage(compose, ref),
  defaultImageRepo: DEFAULT_IMAGE_REPO,
}

// Registry of container adapters. Hermes is the only member;
// claude-code-proxy/custom slot in here later (design §1b). Letta is NOT here —
// it's an AgentResourceProvider (REST), not a container adapter.
const containerAdapters: ContainerRuntimeAdapter[] = [hermesAdapter]

/** Register a container adapter (future runtimes; exported for tests). */
export function registerContainerAdapter(adapter: ContainerRuntimeAdapter): void {
  if (!containerAdapters.some((a) => a.runtime === adapter.runtime)) {
    containerAdapters.push(adapter)
  }
}

/** Pick the container adapter that owns this live container, if any. */
export function pickContainerAdapter(
  containerName: string,
): ContainerRuntimeAdapter | undefined {
  return containerAdapters.find((a) => a.matches(containerName))
}

/**
 * Pick the adapter for a harness's *persisted* runtime. Falls back to Hermes
 * for undefined/unknown runtimes — the historical default for overlay rows
 * that predate the `runtime` field. Letta rows never reach the container
 * paths that call this (they have no container to operate on).
 */
export function adapterForRuntime(runtime?: Harness['runtime']): ContainerRuntimeAdapter {
  return containerAdapters.find((a) => a.runtime === runtime) ?? hermesAdapter
}

// Resolve a harness's data dir from its NAME, honoring the personal special-case
// (personal lives at ~/.hermes; every other agent at ~/.hermes-<name>). The
// name-keyed twin of guessDataDir — used by duplicate/remove, which work from
// the harness name rather than the service name (D1).
export function agentDataDirForName(name: string): string {
  const home = os.homedir()
  return name === 'personal' ? path.join(home, '.hermes') : path.join(home, '.hermes-' + name)
}

// Read the last N lines of a log file without slurping the whole thing.
// Reads a bounded window from the END of the file (capped) so a multi-MB
// gateway.log never lands entirely in memory. Returns '' if the file is
// missing or empty, so callers can fall back to docker logs.
export function tailLogFile(filePath: string, lines: number): string {
  const MAX_BYTES = 2 * 1024 * 1024 // 2MB cap regardless of line count
  let fd: number | undefined
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return ''

    const readBytes = Math.min(stat.size, MAX_BYTES)
    const start = stat.size - readBytes
    const buf = Buffer.alloc(readBytes)
    fd = fs.openSync(filePath, 'r')
    fs.readSync(fd, buf, 0, readBytes, start)

    let text = buf.toString('utf-8')
    // If we started mid-file, drop the (likely partial) first line.
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl !== -1) text = text.slice(nl + 1)
    }
    const all = text.split('\n')
    // A trailing newline produces an empty final element; drop it.
    if (all.length && all[all.length - 1] === '') all.pop()
    const tail = lines > 0 ? all.slice(-lines) : all
    return tail.join('\n')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

export class HarnessService {
  private toolsService?: ToolsService

  constructor(
    private storage: Storage,
    private docker: DockerService,
    private audit: AuditService,
    private config?: ConfigService,
  ) {}

  /** Inject ToolsService after construction to break circular init dependency */
  setToolsService(toolsService: ToolsService): void {
    this.toolsService = toolsService
  }

  // Cache for auto-discovered tools per harness name — avoids re-scanning config.yaml on every API call
  private toolsDiscoveryCache = new Map<string, { tools: string[]; ts: number }>()
  private static TOOLS_CACHE_TTL_MS = 60_000 // 1 minute

  /**
   * Auto-discover tools for a harness by scanning its config.yaml and skills dir.
   * Results are cached for TOOLS_CACHE_TTL_MS to avoid filesystem reads on every request.
   * Returns undefined if ToolsService is not wired up.
   */
  private autoDiscoverTools(harnessName: string): string[] | undefined {
    if (!this.toolsService) return undefined

    const cached = this.toolsDiscoveryCache.get(harnessName)
    if (cached && Date.now() - cached.ts < HarnessService.TOOLS_CACHE_TTL_MS) {
      return cached.tools
    }

    const tools = this.toolsService.discoverForHarness(harnessName)
    this.toolsDiscoveryCache.set(harnessName, { tools, ts: Date.now() })
    return tools
  }

  // Load stored overlays — tier, tools, keys, and other user-configured fields
  private loadOverlays(): Record<string, Partial<Harness>> {
    const stored = this.storage.read<Harness[]>(HARNESSES_FILE, [])
    const overlays: Record<string, Partial<Harness>> = {}
    for (const h of stored) {
      overlays[h.id] = h
    }
    return overlays
  }

  // Write overlays back — only persists user-configured fields, not live Docker state
  private saveOverlays(harnesses: Harness[]): void {
    this.storage.write(HARNESSES_FILE, harnesses)
  }

  discover(): { harnesses: Harness[]; error?: string } {
    if (!this.docker.isAvailable()) {
      return { harnesses: [], error: 'Docker is not available' }
    }

    const settings = this.config?.getSettings()
    const hermesDir = settings?.hermesDir ?? process.env.HERMES_DIR ?? '~/hermes-swarm'
    const configuredFiles = settings?.composeFiles ?? []

    // Determine which compose files to scan
    const composeFiles =
      configuredFiles.length > 0
        ? configuredFiles.map(expandPath)
        : getComposeFilesForDir(hermesDir)

    // Also scan standalone compose files created by Swarm Map
    const swarmMapDataDir = settings?.dataDir
      ? expandPath(settings.dataDir)
      : path.join(os.homedir(), '.hermes-swarm-map')
    const standaloneDir = path.join(swarmMapDataDir, 'compose')
    try {
      const dirs = fs.readdirSync(standaloneDir, { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const cf = path.join(standaloneDir, d.name, 'docker-compose.yml')
        if (fs.existsSync(cf) && !composeFiles.includes(cf)) {
          composeFiles.push(cf)
        }
      }
    } catch {}

    if (composeFiles.length === 0) {
      return { harnesses: [], error: `No docker-compose*.yml files found in ${hermesDir}` }
    }

    const overlays = this.loadOverlays()

    // Build a map of container name → live state via `docker compose ls` + per-project inspect
    // Use the project name "hermes-swarm" since that's how both files are deployed
    const liveContainers: Record<string, {
      state: string
      ports: Array<{ published: number; target: number }>
      composeFile: string
      serviceName: string
    }> = {}

    // Find the project names for our compose files via `docker compose ls`
    const projects = this.docker.listComposeProjects()
    // Build a set of absolute config file paths we care about
    const wantedFiles = new Set(composeFiles.map((f) => expandPath(f)))

    for (const project of projects) {
      const matchingFiles = project.configFiles.filter((f) => wantedFiles.has(f))
      if (matchingFiles.length === 0) continue

      const containers = this.docker.inspectContainers(project.name)
      for (const c of containers) {
        if (EXCLUDED_SERVICES.has(c.service)) continue
        // Prefer the config file that was in our wanted set
        const composeFile = c.composeFile ?? matchingFiles[0]
        liveContainers[c.name] = {
          state: c.state,
          ports: c.ports,
          composeFile,
          serviceName: c.service,
        }
      }
    }

    // If project-based lookup gave nothing, fall back to per-file inspection
    if (Object.keys(liveContainers).length === 0) {
      for (const composeFile of composeFiles) {
        const containers = this.docker.inspectContainers(
          path.basename(path.dirname(composeFile))
        )
        // Also try direct file-based approach
        const raw = this.docker.listContainers(composeFile)
        for (const c of raw) {
          if (EXCLUDED_SERVICES.has(c.service)) continue
          liveContainers[c.name] = {
            state: c.state,
            ports: [],
            composeFile,
            serviceName: c.service,
          }
        }
        void containers // suppress unused warning
      }
    }

    // Batch stats for ALL containers in one Docker call (~2s total, not 10s per container)
    const allStats = this.docker.getAllContainerStats()

    const harnesses: Harness[] = []

    for (const [containerName, live] of Object.entries(liveContainers)) {
      const name = containerNameToHarnessName(containerName)
      const id = 'h_' + name.replace(/-/g, '_')

      // Dispatch on the container-runtime seam (design §1b). A container is
      // included if a runtime adapter claims it OR it has a stored overlay.
      // Overlay-only containers dispatch on their PERSISTED runtime — not a
      // blind Hermes fallback — so a container whose name no adapter claims
      // still gets the adapter its overlay recorded. Rows without a runtime
      // (pre-seam overlays) keep Hermes semantics, the historical default.
      const adapter = pickContainerAdapter(containerName)
      if (!adapter && !overlays[id]) continue
      const effAdapter = adapter ?? adapterForRuntime(overlays[id]?.runtime)

      const dataDir = effAdapter.dataDir(live.serviceName, containerName)
      const persona = effAdapter.readPersona(dataDir)

      const stats = allStats[containerName] ?? { cpu: 0, memMiB: 0 }

      // Port: first published port
      const port = live.ports[0]?.published

      const overlay = overlays[id] ?? {}

      const harness: Harness = {
        // Discoverable fields
        id,
        name,
        runtime: effAdapter.runtime,
        status: stateToStatus(live.state),
        health: { errors: 0 },
        persona: persona || overlay.persona || `Hermes agent: ${name}`,
        lastSeen: Date.now(),
        cpu: stats.cpu,
        mem: stats.memMiB,
        composeFile: live.composeFile,
        serviceName: live.serviceName,
        // Overlay fields (user-configured) — fall back to sensible defaults
        tier: overlay.tier ?? 'individual',
        platform: overlay.platform ?? 'hermes',
        channel: overlay.channel ?? (port ? `:${port}` : ''),
        models: overlay.models?.length ? overlay.models : effAdapter.readModels(dataDir),
        costToday: getCostToday(id),
        invocations: getInvocationsToday(id),
        tools: overlay.tools?.length ? overlay.tools : (this.autoDiscoverTools(name) ?? []),
        ...(overlay.health ? { health: overlay.health } : {}),
        ...(overlay.cacheState ? { cacheState: overlay.cacheState } : {}),
        ...(overlay.cacheAge !== undefined ? { cacheAge: overlay.cacheAge } : {}),
        ...(overlay.parentId ? { parentId: overlay.parentId } : {}),
        ...(overlay.resources ? { resources: overlay.resources } : {}),
        // Overlay-only fields that MUST survive the discovered projection.
        //
        // This literal — not normalizeStored — is what list()/get() return for
        // every container Docker finds, i.e. for every agent that is actually
        // running. normalizeStored is only the fallback for agents with no
        // container. Anything carried there and forgotten here is silently
        // absent exactly when it matters most:
        //
        //  - extraMounts/extraEnv: the settings route regenerates the compose
        //    from get(id). Missing here, it regenerates WITHOUT the agent's
        //    hand-added host mounts — for iris, its approval-gate spool — and
        //    the container comes back healthy with the capability gone. That
        //    is the failure these fields exist to prevent (#222).
        //  - pinnedImageRef/lastKnownDigest: imageStatus() computes
        //    `updateAvailable` from lastKnownDigest, and you only ever ask for
        //    the image status of a RUNNING agent. Missing here, the answer is
        //    permanently "no update available".
        //  - apiPort: the persisted port reservation.
        //
        // Omitted-when-absent, exactly like the fields above, so a harness
        // with no overlay extras keeps a byte-identical shape.
        ...(overlay.extraMounts?.length ? { extraMounts: overlay.extraMounts } : {}),
        ...(overlay.extraEnv && Object.keys(overlay.extraEnv).length
          ? { extraEnv: overlay.extraEnv }
          : {}),
        ...(overlay.apiPort !== undefined ? { apiPort: overlay.apiPort } : {}),
        ...(overlay.pinnedImageRef ? { pinnedImageRef: overlay.pinnedImageRef } : {}),
        ...(overlay.lastKnownDigest ? { lastKnownDigest: overlay.lastKnownDigest } : {}),
        //  - modelTracking: the model-update scheduler decides whether it may
        //    rotate a RUNNING agent's cascade from get(id). Missing here, no
        //    tracked entry is ever applied.
        ...(overlay.modelTracking && Object.keys(overlay.modelTracking).length
          ? { modelTracking: overlay.modelTracking }
          : {}),
      }

      // Override status based on restart tracker
      if (isRestarting(id)) {
        if (harness.status === 'running') {
          clearRestarting(id) // build completed successfully
        } else {
          harness.status = 'restarting'
        }
      }

      harnesses.push(harness)
    }

    // Sort: hermes-* first, then seraph-*
    harnesses.sort((a, b) => {
      const aIsSeraph = a.name.startsWith('seraph-') ? 1 : 0
      const bIsSeraph = b.name.startsWith('seraph-') ? 1 : 0
      if (aIsSeraph !== bIsSeraph) return aIsSeraph - bIsSeraph
      return a.name.localeCompare(b.name)
    })

    return { harnesses }
  }

  list(): Harness[] {
    const { harnesses } = this.discover()
    // Fall back to stored overlays if Docker discovery returned nothing (fresh
    // install, Docker down, nothing started yet). Stored entries are
    // Partial<Harness> and may omit required fields like `health`, so normalize
    // each to a full Harness shape — otherwise the dashboard, which reads
    // h.health.errors, crashes on first run.
    if (harnesses.length === 0) {
      // Discovery returned nothing, so no container is confirmed running —
      // force 'stopped' rather than trust a possibly-stale persisted status
      // (else a Docker-down dashboard shows a phantom "running").
      return this.storage
        .read<Partial<Harness>[]>(HARNESSES_FILE, [])
        .filter((o) => o.id)
        .map((o) => this.normalizeStored(o, 'stopped'))
    }

    // Include overlay-only entries that have no running container (e.g. duplicated but not started).
    // Discovery proved these aren't running, so force status 'stopped'.
    const discoveredIds = new Set(harnesses.map((h) => h.id))
    const overlays = this.storage.read<Partial<Harness>[]>(HARNESSES_FILE, [])
    for (const overlay of overlays) {
      if (!overlay.id || discoveredIds.has(overlay.id)) continue
      harnesses.push(this.normalizeStored(overlay, 'stopped'))
    }

    return harnesses
  }

  // Coerce a stored Partial<Harness> overlay into a full Harness, filling every
  // required field with a sensible default. This is the single normalization
  // point for stored entries — keeping it in one place is what prevents the
  // "one construction path forgot `health`" class of dashboard crash.
  private normalizeStored(o: Partial<Harness>, statusOverride?: HarnessStatus): Harness {
    return {
      id: o.id!,
      name: o.name ?? (o.id ?? '').replace(/^h_/, '').replace(/_/g, '-'),
      runtime: o.runtime ?? 'hermes',
      status: statusOverride ?? o.status ?? 'stopped',
      health: o.health ?? { errors: 0 },
      persona: o.persona ?? '',
      lastSeen: o.lastSeen ?? 0,
      cpu: o.cpu ?? 0,
      mem: o.mem ?? 0,
      tier: o.tier ?? 'individual',
      platform: o.platform ?? 'hermes',
      channel: o.channel ?? '',
      models: o.models ?? [],
      tools: o.tools ?? [],
      // Preserve null (= unknown: migrated harness awaiting its first
      // snapshot). `?? 0` would coerce it to a confident $0.00 — the exact
      // zero-when-unknown misread the number|null contract exists to prevent.
      // Only a genuinely absent field (legacy overlay) defaults to 0.
      costToday: o.costToday === undefined ? 0 : o.costToday,
      invocations: o.invocations === undefined ? 0 : o.invocations,
      composeFile: o.composeFile,
      serviceName: o.serviceName,
      ...(o.parentId ? { parentId: o.parentId } : {}),
      ...(o.apiPort !== undefined ? { apiPort: o.apiPort } : {}),
      ...(o.cacheState ? { cacheState: o.cacheState } : {}),
      ...(o.cacheAge !== undefined ? { cacheAge: o.cacheAge } : {}),
      ...(o.pinnedImageRef ? { pinnedImageRef: o.pinnedImageRef } : {}),
      ...(o.lastKnownDigest ? { lastKnownDigest: o.lastKnownDigest } : {}),
      ...(o.resources ? { resources: o.resources } : {}),
      // Carried onto every projected harness so compose regeneration can see
      // them. Omitted when absent, exactly like the fields above, so a legacy
      // overlay stays byte-identical.
      ...(o.extraMounts?.length ? { extraMounts: o.extraMounts } : {}),
      ...(o.extraEnv && Object.keys(o.extraEnv).length ? { extraEnv: o.extraEnv } : {}),
      // Per-entry "track newest version" flags; omitted when absent so a
      // legacy overlay stays byte-identical.
      ...(o.modelTracking && Object.keys(o.modelTracking).length ? { modelTracking: o.modelTracking } : {}),
    }
  }

  get(id: string): Harness | undefined {
    return this.list().find((h) => h.id === id)
  }

  updateConfig(id: string, partial: Partial<Harness>): Harness | undefined {
    // Load existing overlays, merge, persist
    const overlays = this.storage.read<Harness[]>(HARNESSES_FILE, [])
    const index = overlays.findIndex((h) => h.id === id)
    if (index !== -1) {
      overlays[index] = { ...overlays[index], ...partial }
    } else {
      // New overlay entry — we need at least a skeleton
      const current = this.get(id)
      if (!current) return undefined
      overlays.push({ ...current, ...partial })
    }
    this.saveOverlays(overlays)
    return this.get(id)
  }

  // Resolve the compose file + service name for lifecycle ops (restart/start/stop).
  //
  // composeFile/serviceName are LIVE Docker state (not persisted in the overlay),
  // so a harness whose container is briefly undiscoverable (mid-recreate, port
  // bind failure, daemon hiccup) would otherwise have no composeFile and every
  // restart/start/stop would throw "no compose file configured" — leaving the
  // agent unmanageable through Swarm Map. Fall back to the conventional
  // standalone layout (~/.hermes-swarm-map/compose/<name>/docker-compose.yml,
  // service hermes-<name>) so a known agent stays recoverable.
  private resolveComposeTarget(
    harness: Harness
  ): { composeFile: string; serviceName: string } | undefined {
    let composeFile = harness.composeFile
    if (!composeFile && harness.name) {
      const settings = this.config?.getSettings()
      const swarmMapDataDir = settings?.dataDir
        ? expandPath(settings.dataDir)
        : path.join(os.homedir(), '.hermes-swarm-map')
      const candidate = path.join(swarmMapDataDir, 'compose', harness.name, 'docker-compose.yml')
      if (fs.existsSync(candidate)) composeFile = candidate
    }
    const serviceName =
      harness.serviceName ||
      (composeFile && harness.name
        ? adapterForRuntime(harness.runtime).serviceName(harness.name)
        : undefined)
    if (!composeFile || !serviceName) return undefined
    return { composeFile, serviceName }
  }

  /**
   * Public compose-file/service resolution for operations that need to read or
   * rewrite the compose (e.g. the DB migration route). Same fallback logic as
   * every lifecycle op (resolveComposeTarget).
   */
  composeTarget(id: string): { composeFile: string; serviceName: string } | undefined {
    const harness = this.get(id)
    return harness ? this.resolveComposeTarget(harness) : undefined
  }

  restart(id: string, mode: RestartMode): void {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!target) {
      throw new Error(`Harness ${id} has no compose file configured`)
    }
    // For build modes, resolve the local source the build will read so the
    // docker layer can sync it to its configured ref FIRST (fail loud if it
    // can't), instead of silently building whatever's checked out.
    const buildSource =
      mode === 'rebuild' || mode === 'purge'
        ? this.resolveBuildSource(target.composeFile)
        : undefined
    markRestarting(id, mode)
    try {
      this.docker.restart(target.composeFile, target.serviceName, mode, undefined, buildSource)
    } catch (err) {
      // A build-source sync that fails loud must NOT leave the harness wedged
      // in the "restarting" state — clear it so the user can retry after fixing.
      clearRestarting(id)
      this.audit.append({
        who: 'admin',
        what: `restart:${mode}:failed`,
        target: harness!.name,
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
    this.audit.append({ who: 'admin', what: `restart:${mode}`, target: harness!.name })
  }

  /**
   * Resolve the local build-source directory a rebuild will read from.
   * Prefers the harness's own compose `build:` context (authoritative — it's
   * exactly what `--build` consumes, and honors any per-harness override),
   * falling back to the global `hermesDir` setting. Returns null for
   * image-only harnesses (nothing to sync).
   */
  private resolveBuildSource(composeFile: string): string | null {
    try {
      const compose = fs.readFileSync(composeFile, 'utf-8')
      const ctx = readComposeBuildContext(compose)
      if (ctx) return expandPath(ctx)
      // Image-only compose → no local build to sync.
      if (readComposeImage(compose)) return null
    } catch {
      // fall through to settings default
    }
    const settings = this.config?.getSettings()
    if (settings?.useLocalBuild && settings.hermesDir) return expandPath(settings.hermesDir)
    return null
  }

  /**
   * Force the agent runtime to re-provision its git credentials.
   *
   * The runtime writes ~/.git-credentials + ~/.gitconfig at container boot
   * (a cont-init hook) but is apply-if-absent, so it won't overwrite stale
   * files (e.g. after a token rotation). We delete the cred files and recreate
   * the container so the boot hook regenerates them from the agent's current
   * .env token — keeping the runtime as the single source of truth instead of
   * re-introducing a host-side writer.
   */
  refreshGitCredentials(id: string): { ok: boolean; serviceName: string } {
    const harness = this.get(id)
    if (!harness?.serviceName) {
      throw new Error(`Harness ${id} not found`)
    }
    const dataDir = guessDataDir(harness.serviceName, harness.serviceName)
    for (const f of ['.git-credentials', '.gitconfig']) {
      try {
        fs.rmSync(path.join(dataDir, 'home', f), { force: true })
      } catch {
        // Best-effort: a missing file is fine — recreate re-provisions anyway.
      }
    }
    this.restart(id, 'recreate')
    return { ok: true, serviceName: harness.serviceName }
  }

  /**
   * Sync an already-created agent's artifacts (plugins/skills/hooks) against the
   * repo manifest — the missing lifecycle path (#82). installBaselineTemplates
   * only runs at create/duplicate, so existing agents never gain artifacts added
   * to infra/artifacts.json later. This installs MISSING artifacts and updates
   * provably-unmodified ones (see artifacts-sync.ts no-clobber model), enables
   * any newly-installed plugins in config.yaml, then recreates the container so
   * the runtime loads them. dryRun returns the plan without writing or restarting.
   */
  syncArtifacts(
    id: string,
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): { ok: boolean; serviceName: string; dryRun: boolean; results: SyncResult[]; pluginsEnabled: string[]; restarted: boolean } {
    const harness = this.get(id)
    if (!harness?.serviceName) {
      throw new Error(`Harness ${id} not found`)
    }
    const dataDir = guessDataDir(harness.serviceName, harness.serviceName)
    const repoRoot = process.cwd()
    const manifest = loadManifest(path.join(repoRoot, 'infra', 'artifacts.json'))
    const plan = planArtifactSync(dataDir, manifest, repoRoot, { force: opts.force })

    if (opts.dryRun) {
      return {
        ok: true,
        serviceName: harness.serviceName,
        dryRun: true,
        results: plan.items.map((i) => ({ ...i, applied: false })),
        pluginsEnabled: plan.enablePlugins,
        restarted: false,
      }
    }

    const results = applyArtifactSync(dataDir, plan, repoRoot)
    const changed = results.some((r) => r.applied)

    // Enable any newly-installed/updated plugins in config.yaml so the runtime loads them.
    let pluginsEnabled: string[] = []
    const toEnable = plan.enablePlugins.filter((n) =>
      results.some((r) => r.name === n && r.applied),
    )
    if (toEnable.length > 0) {
      const configPath = path.join(dataDir, 'config.yaml')
      try {
        const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
        const { content, added } = ensurePluginsEnabled(current, toEnable)
        if (added.length > 0) {
          fs.writeFileSync(configPath, content)
          pluginsEnabled = added
        }
      } catch {
        // config.yaml unwritable — artifacts are still installed; surface nothing fatal.
      }
    }

    // Only bounce the container if something actually changed.
    if (changed) this.restart(id, 'recreate')
    this.audit.append({ who: 'admin', what: 'artifacts:sync', target: harness.name })
    return {
      ok: true,
      serviceName: harness.serviceName,
      dryRun: false,
      results,
      pluginsEnabled,
      restarted: changed,
    }
  }

  /**
   * Re-apply a use-case template to an already-created agent: update its
   * plugins/skills/SOUL from the template's currently-pinned git tag (trust-gated),
   * enable any new plugins in config.yaml, and recreate the container so the
   * runtime loads them. This is how a DEPLOYED agent gets package updates — the
   * template id is not persisted at create time, so the caller supplies it.
   */
  async reapplyUseCaseTemplate(
    id: string,
    templateId: string,
  ): Promise<{ ok: boolean; serviceName: string; results: InstallResult[]; pluginsEnabled: string[]; restarted: boolean }> {
    const harness = this.get(id)
    if (!harness?.serviceName) {
      throw new Error(`Harness ${id} not found`)
    }
    const template = getUseCaseTemplate(templateId)
    if (!template) {
      throw new Error(`Unknown use-case template "${templateId}"`)
    }
    const dataDir = guessDataDir(harness.serviceName, harness.serviceName)
    const configPath = path.join(dataDir, 'config.yaml')
    const { results, pluginsEnabled, changed } = await reapplyTemplateToDataDir(dataDir, template, configPath)

    // Only bounce the container if something actually changed on disk.
    if (changed) this.restart(id, 'recreate')
    this.audit.append({ who: 'admin', what: `usecase:reapply:${templateId}`, target: harness.name })
    return {
      ok: true,
      serviceName: harness.serviceName,
      results,
      pluginsEnabled,
      restarted: changed,
    }
  }

  // --- Runtime-image CD (version-awareness + manual pinned update) ---

  /** The image ref an agent's compose currently runs, or 'local-build' if it builds from source. */
  currentImage(id: string): string | null {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!target) return null
    try {
      const compose = fs.readFileSync(target.composeFile, 'utf-8')
      return adapterForRuntime(harness.runtime).readImageRef(compose) ?? 'local-build'
    } catch {
      return null
    }
  }

  /**
   * Version status for an agent: what it runs now, what it's pinned to, and the
   * digest the default repo's `:latest` resolves to — so the UI can flag
   * "update available". Registry failures degrade to latest=null (never throws).
   */
  async imageStatus(id: string, registry: RegistryService = new RegistryService()): Promise<{
    current: string | null
    pinned?: string
    lastKnownDigest?: string
    latestTag: string
    latestDigest: string | null
    updateAvailable: boolean
  }> {
    const harness = this.get(id)
    if (!harness) throw new Error(`Harness ${id} not found`)
    const current = this.currentImage(id)
    const repo =
      current && current !== 'local-build'
        ? parseImageRef(current).repo
        : adapterForRuntime(harness.runtime).defaultImageRepo
    const latestDigest = await registry.getDigest(repo, 'latest')
    const updateAvailable =
      !!latestDigest && (current === 'local-build' || (!!harness.lastKnownDigest && harness.lastKnownDigest !== latestDigest))
    return {
      current,
      pinned: harness.pinnedImageRef,
      lastKnownDigest: harness.lastKnownDigest,
      latestTag: `${repo}:latest`,
      latestDigest,
      updateAvailable,
    }
  }

  /**
   * Pin an agent to an image ref and roll it: surgically rewrite the compose
   * source block to `image: <ref>`, persist the pin (+ resolved digest for
   * rollback/drift), and recreate the container (which pulls the ref if absent).
   * Does NOT touch the build for any other service (wireguard/camofox).
   */
  async setAgentImage(id: string, ref: string, registry: RegistryService = new RegistryService()): Promise<{ ok: boolean; serviceName: string; ref: string; digest: string | null }> {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!harness || !target) throw new Error(`Harness ${id} not found`)
    if (!fs.existsSync(target.composeFile)) throw new Error(`Harness ${id} compose file not found at ${target.composeFile}`)
    const compose = fs.readFileSync(target.composeFile, 'utf-8')
    fs.writeFileSync(
      target.composeFile,
      adapterForRuntime(harness.runtime).setImageRef(compose, ref),
    )
    const parsed = parseImageRef(ref)
    const digest = parsed.digest ?? (parsed.tag ? await registry.getDigest(parsed.repo, parsed.tag) : null)
    this.updateConfig(id, { pinnedImageRef: ref, lastKnownDigest: digest ?? harness.lastKnownDigest })
    this.restart(id, 'recreate')
    this.audit.append({ who: 'admin', what: `image:set:${ref}`, target: harness.name })
    return { ok: true, serviceName: target.serviceName, ref, digest }
  }

  /**
   * Canary signal after a recreate: is the container up and stable? Honest about
   * "starting" (running but very young) vs "healthy" vs "unhealthy" (not running
   * / restart-looping). No assumption of an HTTP health endpoint.
   */
  agentHealth(id: string): { status: 'healthy' | 'starting' | 'unhealthy'; running: boolean; restartCount: number; uptimeSec: number | null } {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!harness || !target) throw new Error(`Harness ${id} not found`)
    const state = this.docker.inspectState(target.serviceName)
    if (!state || !state.running) {
      return { status: 'unhealthy', running: false, restartCount: state?.restartCount ?? 0, uptimeSec: null }
    }
    const started = state.startedAt ? Date.parse(state.startedAt) : NaN
    const uptimeSec = Number.isNaN(started) ? null : Math.max(0, Math.floor((this.now() - started) / 1000))
    // Young-but-running = still booting; restart-looping = unhealthy.
    if (state.restartCount > 2) return { status: 'unhealthy', running: true, restartCount: state.restartCount, uptimeSec }
    if (uptimeSec !== null && uptimeSec < 8) return { status: 'starting', running: true, restartCount: state.restartCount, uptimeSec }
    return { status: 'healthy', running: true, restartCount: state.restartCount, uptimeSec }
  }

  // Wrapped for test injection (Date is otherwise unmockable mid-suite).
  protected now(): number {
    return Date.now()
  }

  start(id: string): void {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!target) {
      throw new Error(`Harness ${id} has no compose file configured`)
    }
    this.docker.start(target.composeFile, target.serviceName)
    this.audit.append({ who: 'admin', what: 'start', target: harness!.name })
  }

  stop(id: string): void {
    const harness = this.get(id)
    const target = harness && this.resolveComposeTarget(harness)
    if (!target) {
      throw new Error(`Harness ${id} has no compose file configured`)
    }
    this.docker.stop(target.composeFile, target.serviceName)
    this.audit.append({ who: 'admin', what: 'stop', target: harness!.name })
  }

  async duplicateOverlay(sourceId: string, newName: string): Promise<Partial<Harness> | undefined> {
    // Force a lowercase slug (see toHarnessSlug) so the duplicate's compose,
    // data dir, and service name are all consistent and docker-valid. The
    // sourceId lookup below is untouched — existing harnesses keep their ids.
    newName = toHarnessSlug(newName)
    if (!newName) return undefined
    const overlays = this.storage.read<Partial<Harness>[]>('harnesses.json', [])
    const source = overlays.find((h) => h.id === sourceId)
    if (!source) return undefined

    const newId = 'h_' + newName.replace(/-/g, '_').replace(/\s+/g, '_')

    // Reject if name or ID already exists
    if (overlays.some((h) => h.id === newId || h.name === newName)) {
      return undefined
    }

    // Determine agent dirs
    const sourceName = source.name ?? sourceId.replace(/^h_/, '').replace(/_/g, '-')
    // personal's data lives at ~/.hermes, not ~/.hermes-personal (D1) — resolve
    // through the shared name→dir helper so duplicating personal copies real data.
    const sourceDataDir = agentDataDirForName(sourceName)
    const newDataDir = agentDataDirForName(newName)

    // Settings for compose dir
    const settings = this.config?.getSettings()
    const swarmMapDataDir = settings?.dataDir
      ? expandPath(settings.dataDir)
      : path.join(os.homedir(), '.hermes-swarm-map')
    const composeBaseDir = path.join(swarmMapDataDir, 'compose')

    // Pick next available port — seed reserved ports from persisted overlays so
    // the duplicate never reuses a port already handed to another agent.
    const port = nextAvailablePort({
      composeBaseDir,
      reservedPorts: overlays.map((h) => h.apiPort).filter((p): p is number => typeof p === 'number'),
    })

    // Provision through the source's runtime adapter — a duplicate is the
    // same kind of agent as its source (pre-seam rows default to Hermes).
    const dupAdapter = adapterForRuntime(source.runtime)

    // Copy source data directory if it exists, else scaffold fresh
    if (fs.existsSync(sourceDataDir) && !fs.existsSync(newDataDir)) {
      // Deep copy using recursive dir copy
      copyDirRecursive(sourceDataDir, newDataDir)
      // Update port and strip surface credentials from the new .env
      const newEnvPath = path.join(newDataDir, '.env')
      if (fs.existsSync(newEnvPath)) {
        let envContent = fs.readFileSync(newEnvPath, 'utf-8')
        envContent = envContent.replace(
          /^API_SERVER_PORT=.*/m,
          `API_SERVER_PORT=${port}`
        )
        // Reset the agent's identity to the new name. HERMES_AGENT_NAME is the
        // agent's identifier to HSM policy (swarm_map_policy: allowlist + admin
        // lookups) and lifecycle notifications — leaving the source's value makes
        // the duplicate impersonate its source. The import path already does this.
        if (/^HERMES_AGENT_NAME=/m.test(envContent)) {
          envContent = envContent.replace(
            /^HERMES_AGENT_NAME=.*/m,
            `HERMES_AGENT_NAME=${newName}`
          )
        } else {
          envContent += `\nHERMES_AGENT_NAME=${newName}\n`
        }
        // Remove surface-specific vars to avoid two harnesses bound to the same surface
        envContent = envContent
          .split('\n')
          .filter((line) => !SURFACE_ENV_VARS.some((v) => line.startsWith(`${v}=`)))
          .join('\n')
        fs.writeFileSync(newEnvPath, envContent, { mode: 0o600 })
      }
      // Reset SOUL.md so the duplicate has its own identity, not the source's
      // persona/name. A duplicate is a new agent; persona is customized afterward.
      fs.writeFileSync(path.join(newDataDir, 'SOUL.md'), defaultSoulContent(newName), 'utf-8')
      // Migrated source (#204 PR2): the copy above reproduced DB symlinks, not
      // DBs — replace them with real copies of the source's data (see helper).
      await this.hydrateMigratedDbCopies(sourceName, sourceDataDir, newDataDir, source)
    } else if (!fs.existsSync(newDataDir)) {
      await dupAdapter.scaffold(newDataDir, newName, port)
    }

    // Generate standalone compose for the duplicate
    const agentComposeDir = path.join(composeBaseDir, newName)
    fs.mkdirSync(agentComposeDir, { recursive: true })
    const composePath = path.join(agentComposeDir, 'docker-compose.yml')
    if (!fs.existsSync(composePath)) {
      assertPortAvailable(overlays, port, newId)
      fs.writeFileSync(composePath, dupAdapter.generateCompose(newName, port, newDataDir, { imageOrBuild: resolveImageOrBuild(settings), defaultImage: settings?.defaultImage }), 'utf-8')
    }

    // A duplicate must NOT inherit the source's host bind mounts, nor the env
    // vars naming them. Those paths point at the SOURCE agent's directories —
    // for the iris gate, its approval spool — and the compose generated just
    // above deliberately carries none of them. Spreading them onto the new
    // overlay would leave overlay and compose silently divergent, and the next
    // unrelated settings PUT regenerates FROM the overlay, at which point the
    // duplicate gets (possibly rw) access to another agent's host paths. There
    // is no console field for extraMounts, so nothing would ever surface it.
    //
    // Stripping is the safe default: a duplicate inheriting another agent's
    // host mounts is almost never what someone meant. Re-add them deliberately
    // on the duplicate if they are actually wanted.
    const {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      extraMounts: _sourceExtraMounts,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      extraEnv: _sourceExtraEnv,
      ...sourceWithoutHostAccess
    } = source
    const duplicate: Partial<Harness> = {
      ...sourceWithoutHostAccess,
      id: newId,
      name: newName,
      channel: `:${port}`,
      apiPort: port,
      composeFile: composePath,
      serviceName: dupAdapter.serviceName(newName),
      parentId: sourceId,
      platform: undefined, // reset — no surfaces connected yet
    }

    overlays.push(duplicate)
    this.storage.write('harnesses.json', overlays)

    this.audit.append({
      who: 'admin',
      what: 'duplicate',
      target: `${source.name ?? sourceId} → ${newName}`,
    })

    return duplicate
  }

  /**
   * Hydrate a duplicate's data dir with REAL DB copies when the source is
   * migrated (#204 PR2). copyDirRecursive reproduces the source's state.db /
   * response_store.db / kanban.db SYMLINKS verbatim — they point at /state/*,
   * which inside the DUPLICATE's container resolves to its own (empty) volume,
   * so the clone would silently boot amnesiac. Instead: drop the copied
   * symlinks (and stale snapshot artifacts) and pull consistent regular-file
   * copies of the source DBs into the new data dir — the duplicate's own
   * state-init migrates them onto its volume on first boot.
   *
   * Source container RUNNING → docker exec + Python sqlite3 backup API (a
   * consistent copy under a live writer) written into the source's /opt/data
   * (host-visible via the bind mount), then moved host-side. Source STOPPED →
   * one-shot `docker run` cold-copying from the source volume (no writer, so
   * plain cp is consistent). Best-effort: on failure the clone still works but
   * starts with fresh DBs — logged and audited, never thrown.
   */
  private async hydrateMigratedDbCopies(
    sourceName: string,
    sourceDataDir: string,
    newDataDir: string,
    source: Partial<Harness>,
  ): Promise<void> {
    if (!isStateDbMigrated(sourceDataDir)) return

    // 1. Drop the copied symlinks + siblings + stale snapshot artifacts. Even
    // if hydration below fails, dangling symlinks into the wrong volume and a
    // stale .snapshot must not survive in the clone.
    for (const db of MIGRATED_DB_FILES) {
      for (const suf of ['', '-wal', '-shm']) {
        const p = path.join(newDataDir, `${db}${suf}`)
        try {
          if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true })
        } catch {} // missing — fine
      }
    }
    for (const f of ['state.db.snapshot', 'state.db.snapshot.tmp']) {
      fs.rmSync(path.join(newDataDir, f), { force: true })
    }

    const containerName = adapterForRuntime(source.runtime).serviceName(sourceName)
    try {
      const running = this.docker.inspectState(containerName)?.running ?? false
      if (running) {
        // Consistent copy under the live writer via the sqlite3 backup API.
        for (const db of MIGRATED_DB_FILES) {
          const tmpName = `.clone-${db}.tmp`
          const prog = [
            'import sqlite3, os',
            `p = "/opt/data/${db}"`,
            `t = "/opt/data/${tmpName}"`,
            'if os.path.exists(p):',
            '    if os.path.exists(t):',
            '        os.remove(t)',
            '    s = sqlite3.connect("file:" + p + "?mode=ro", uri=True, timeout=10)',
            '    d = sqlite3.connect(t)',
            '    s.backup(d)',
            '    d.close()',
            '    s.close()',
          ].join('\n')
          await this.docker.execInContainer(containerName, ['python3', '-c', prog], 120000)
          const hostTmp = path.join(sourceDataDir, tmpName)
          if (fs.existsSync(hostTmp)) {
            fs.copyFileSync(hostTmp, path.join(newDataDir, db))
            fs.rmSync(hostTmp, { force: true })
          }
        }
      } else {
        // No writer — a plain cp out of the volume is consistent. Reuse the
        // source's own image (guaranteed present if it ever ran); fall back to
        // the default agent image.
        let image: string | null = null
        try {
          if (source.composeFile && fs.existsSync(source.composeFile)) {
            image = readComposeImage(fs.readFileSync(source.composeFile, 'utf-8'))
          }
        } catch {}
        image = image ?? this.config?.getSettings()?.defaultImage ?? 'ghcr.io/cyborg-garden/hermes-agent-mt:latest'
        const script = [
          `for db in ${MIGRATED_DB_FILES.join(' ')}; do`,
          '  for suf in "" -wal -shm; do',
          '    if [ -f "/state/$db$suf" ]; then cp -p "/state/$db$suf" "/out/$db$suf"; fi',
          '  done',
          'done',
        ].join('\n')
        this.docker.runOneShot(image, [`${stateVolumeName(sourceName)}:/state:ro`, `${newDataDir}:/out`], script)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[harness] duplicate ${sourceName}: could not copy migrated DBs — clone starts with EMPTY databases:`, msg.slice(0, 300))
      this.audit.append({
        who: 'admin',
        what: 'duplicate:db-copy-failed',
        target: sourceName,
        meta: { error: msg.slice(0, 300) },
      })
    }
  }

  remove(id: string, deleteFiles: boolean): { removed: boolean; stopped: boolean; filesDeleted: boolean; volumeRemoved: boolean } {
    const overlays = this.storage.read<Partial<Harness>[]>(HARNESSES_FILE, [])
    const index = overlays.findIndex((h) => h.id === id)
    if (index === -1) return { removed: false, stopped: false, filesDeleted: false, volumeRemoved: false }

    const overlay = overlays[index]
    const name = overlay.name ?? id.replace(/^h_/, '').replace(/_/g, '-')
    let stopped = false
    let filesDeleted = false
    let volumeRemoved = false

    // Stop container if running. For a full delete, `down` instead of `stop`:
    // it also REMOVES the containers (incl. the exited state-init-<name> one),
    // without which `docker volume rm hermes-state-<name>` below would refuse
    // — any container referencing a volume, even exited, blocks its removal.
    if (overlay.composeFile && overlay.serviceName) {
      try {
        if (deleteFiles) this.docker.down(overlay.composeFile)
        else this.docker.stop(overlay.composeFile, overlay.serviceName)
        stopped = true
      } catch {
        // Container may not be running — that's fine
      }
    }

    // Remove overlay entry
    overlays.splice(index, 1)
    this.storage.write(HARNESSES_FILE, overlays)

    if (deleteFiles) {
      // Remove data directory (resolved through the personal-aware helper, D1).
      const dataDir = agentDataDirForName(name)
      // Never delete the personal base ~/.hermes from a dashboard action — it's
      // the root install, not a disposable overlay. Guard is explicit rather
      // than relying on the old accidental ~/.hermes-personal miss.
      const personalBase = path.join(os.homedir(), '.hermes')
      if (dataDir !== personalBase && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true })
        filesDeleted = true
      }
      // Remove compose directory
      if (overlay.composeFile) {
        const composeDir = path.dirname(overlay.composeFile)
        if (fs.existsSync(composeDir)) {
          fs.rmSync(composeDir, { recursive: true, force: true })
          filesDeleted = true
        }
      }
      // Remove the named state volume (#204 PR2). For a migrated harness the
      // real DBs live here, NOT in the data dir — without this, "delete files"
      // leaves the most sensitive data alive, and a future same-name agent
      // reattaches it (the pinned `name:` defeats project prefixing) and boots
      // with the deleted agent's full brain. Personal is exempt, matching the
      // ~/.hermes guard above. Best-effort: "no such volume" (never migrated /
      // pre-PR2) is the normal case and stays silent; real failures are logged.
      if (dataDir !== personalBase) {
        try {
          this.docker.removeVolume(stateVolumeName(name))
          volumeRemoved = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // execFileSync puts docker's actual complaint in err.stderr, not message.
          const stderr = String((err as { stderr?: unknown })?.stderr ?? '')
          if (!/no such volume/i.test(`${msg} ${stderr}`)) {
            console.error(`[harness] delete ${name}: could not remove volume ${stateVolumeName(name)}:`, (stderr.trim() || msg).slice(0, 300))
          }
        }
      }
    }

    this.audit.append({
      who: 'admin',
      what: deleteFiles ? 'delete' : 'unregister',
      target: name,
    })

    return { removed: true, stopped, filesDeleted, volumeRemoved }
  }

  async createOverlay(input: { name: string; tier?: HabitatTier; platform?: string; channel?: string; models?: string[]; tools?: string[] }): Promise<Partial<Harness>> {
    // Force a lowercase slug so all docker identifiers + data/compose dirs are
    // consistent (see toHarnessSlug — capital names break docker on case-
    // insensitive filesystems). Creation-time only: existing overlays keep
    // whatever name they were persisted with.
    input = { ...input, name: toHarnessSlug(input.name) }
    if (!input.name) {
      throw new Error('Harness name must contain at least one letter or digit')
    }
    const overlays = this.storage.read<Partial<Harness>[]>('harnesses.json', [])

    // Check for duplicate name
    const id = 'h_' + input.name.replace(/-/g, '_').replace(/\s+/g, '_')
    if (overlays.some((h) => h.id === id || h.name === input.name)) {
      throw new Error(`Harness "${input.name}" already exists`)
    }

    // Determine standalone compose directory from settings
    const settings = this.config?.getSettings()
    const swarmMapDataDir = settings?.dataDir
      ? expandPath(settings.dataDir)
      : path.join(os.homedir(), '.hermes-swarm-map')
    const composeBaseDir = path.join(swarmMapDataDir, 'compose')

    // Pick next available port — seed reserved ports from persisted overlays so
    // an allocated-but-not-yet-started agent is never re-handed out.
    const port = nextAvailablePort({
      composeBaseDir,
      reservedPorts: overlays.map((h) => h.apiPort).filter((p): p is number => typeof p === 'number'),
    })

    // Agent data directory (where .env, config.yaml, SOUL.md live)
    const agentDir = path.join(os.homedir(), `.hermes-${input.name}`)

    // createOverlay provisions Hermes agents only — the Letta path branches at
    // the deploy route (design §3c) and never reaches container provisioning.
    const adapter = hermesAdapter

    // Scaffold agent data directory if it doesn't exist
    if (!fs.existsSync(agentDir)) {
      await adapter.scaffold(agentDir, input.name, port)
    }

    // Git auth is provisioned by the agent runtime at container boot (a
    // cont-init hook reads the agent's own .env). HSM no longer writes the
    // credential files — single source of truth, and nothing to clobber.

    // Generate standalone compose file
    const agentComposeDir = path.join(composeBaseDir, input.name)
    fs.mkdirSync(agentComposeDir, { recursive: true })
    const composePath = path.join(agentComposeDir, 'docker-compose.yml')
    if (!fs.existsSync(composePath)) {
      assertPortAvailable(overlays, port, id)
      fs.writeFileSync(composePath, adapter.generateCompose(input.name, port, agentDir, { imageOrBuild: resolveImageOrBuild(settings), defaultImage: settings?.defaultImage }), 'utf-8')
    }

    const overlay: Partial<Harness> = {
      id,
      name: input.name,
      tier: input.tier ?? 'individual',
      platform: input.platform ?? 'hermes',
      channel: input.channel ?? `:${port}`,
      apiPort: port,
      models: input.models ?? ['claude-sonnet-4-5'],
      tools: input.tools ?? [],
      composeFile: composePath,
      serviceName: adapter.serviceName(input.name),
    }

    overlays.push(overlay)
    this.storage.write('harnesses.json', overlays)
    this.audit.append({ who: 'admin', what: 'create', target: input.name })
    return overlay
  }

  async importFromDir(sourceDir: string, name: string): Promise<{
    id?: string
    name: string
    sourceDir: string
    destDir: string
    changes: {
      copied: boolean
      envVarsAdded: string[]
      pluginsInstalled: string[]
      bootMdCreated: boolean
      composeGenerated: boolean
    }
  }> {
    // 1. Validate source directory
    const expandedSource = expandPath(sourceDir)
    if (!fs.existsSync(expandedSource)) {
      throw new Error(`Source directory not found: ${expandedSource}`)
    }
    const hasEnv = fs.existsSync(path.join(expandedSource, '.env'))
    const hasConfig = fs.existsSync(path.join(expandedSource, 'config.yaml'))
    if (!hasEnv && !hasConfig) {
      throw new Error(`Not a Hermes data directory: missing .env and config.yaml`)
    }

    // 2. Determine destination
    const slug = toHarnessSlug(name)
    const destDir = slug === 'personal'
      ? path.join(os.homedir(), '.hermes')
      : path.join(os.homedir(), `.hermes-${slug}`)

    // 3. Copy source to managed location (fail if dest exists)
    let copied = false
    if (expandedSource !== destDir) {
      if (fs.existsSync(destDir)) {
        throw new Error(`Destination already exists: ${destDir}. Remove it first or choose a different name.`)
      }
      copyDirRecursive(expandedSource, destDir)
      copied = true
    }

    const workDir = destDir

    // 4. Patch .env — append missing HSM vars
    const hsmUrl = hsmBaseUrl()
    const requiredVars: Record<string, string> = {
      HSM_URL: hsmUrl,
      SWARM_MAP_POLICY_URL: hsmUrl,
      HERMES_AGENT_NAME: slug,
      HERMES_MEMORY_SCOPE: 'channel',
      HERMES_DM_POLICY: 'approved-only',
      HERMES_APPROVAL_ADMIN_ONLY: 'true',
      // Mention-only is the secure default for groups, matching newly-created
      // and deployed agents. Only applied when absent, so an imported agent that
      // explicitly set these stays as configured.
      SIGNAL_REQUIRE_MENTION: 'true',
      TELEGRAM_REQUIRE_MENTION: 'true',
      MATTERMOST_REQUIRE_MENTION: 'true',
    }

    const envPath = path.join(workDir, '.env')
    let envContent = ''
    try { envContent = fs.readFileSync(envPath, 'utf-8') } catch {}

    // Heal any empty mention-gating values (KEY=) the imported .env carries —
    // they read as false at runtime despite HSM's require-mention default, so a
    // bare line would silently un-gate the agent. (Append-missing below only
    // covers absent keys, not present-but-empty ones.)
    const healedEnv = normalizeEmptyMentionGating(envContent)
    const mentionGatingHealed = healedEnv !== envContent
    envContent = healedEnv

    const envVarsAdded: string[] = []
    const existingVars = new Set(
      envContent.split('\n')
        .filter(l => !l.startsWith('#') && l.includes('='))
        .map(l => l.split('=')[0].trim())
    )

    const newLines: string[] = []
    for (const [key, value] of Object.entries(requiredVars)) {
      if (!existingVars.has(key)) {
        newLines.push(`${key}=${value}`)
        envVarsAdded.push(key)
      }
    }

    if (newLines.length > 0) {
      const separator = envContent.endsWith('\n') ? '' : '\n'
      envContent += `${separator}\n# HSM integration (added by import)\n${newLines.join('\n')}\n`
    }
    if (newLines.length > 0 || mentionGatingHealed) {
      fs.writeFileSync(envPath, envContent, { mode: 0o600 })
    }

    // 5. Install baseline plugins
    const installResults = await installBaselineTemplates(workDir)
    const pluginsInstalled = installResults
      .filter((r) => r.type === 'plugins' && r.installed)
      .map((r) => r.name)

    // 6. Write BOOT.md if not present
    let bootMdCreated = false
    const bootPath = path.join(workDir, 'BOOT.md')
    if (!fs.existsSync(bootPath)) {
      const bootContent = `# Boot Checklist

On startup, verify your operational readiness:

1. **Check HSM connection** — Can you reach your management server? If not, note it but continue (you can still operate, just without group policy updates).

2. **Review your memory** — Check if you have any persistent memories from previous sessions. If this is your first boot, that's expected.

3. **Verify skills** — Run a quick skills check. Note any skills that failed to load.

4. **Status report** — If everything is nominal, reply with [SILENT]. Only report if something needs attention.

If this is your very first startup ever, introduce yourself briefly in your home channel (if configured).
`
      fs.writeFileSync(bootPath, bootContent, 'utf-8')
      bootMdCreated = true
    }

    // 7. Generate standalone compose file
    let composeGenerated = false
    const settings = this.config?.getSettings()
    const swarmMapDataDir = settings?.dataDir
      ? expandPath(settings.dataDir)
      : path.join(os.homedir(), '.hermes-swarm-map')
    const composeBaseDir = path.join(swarmMapDataDir, 'compose')
    const agentComposeDir = path.join(composeBaseDir, slug)
    const composePath = path.join(agentComposeDir, 'docker-compose.yml')

    // Resolve the port up front: honor a port the imported .env already declares,
    // else allocate, seeding reserved ports from persisted overlays so the import
    // can't be handed a port another agent already owns. The slug-derived id
    // matches createOverlay's id so the fail-loud guard checks against everyone else.
    const importId = 'h_' + slug.replace(/-/g, '_').replace(/\s+/g, '_')
    const importOverlays = this.storage.read<Partial<Harness>[]>('harnesses.json', [])
    const reservedPorts = importOverlays
      .map((h) => h.apiPort)
      .filter((p): p is number => typeof p === 'number')
    const existingPort = existingVars.has('API_SERVER_PORT')
      ? parseInt(envContent.match(/API_SERVER_PORT=(\d+)/)?.[1] || '0', 10)
      : 0
    const port = existingPort || nextAvailablePort({ composeBaseDir, reservedPorts })

    if (!fs.existsSync(composePath)) {
      assertPortAvailable(importOverlays, port, importId)
      fs.mkdirSync(agentComposeDir, { recursive: true })
      fs.writeFileSync(
        composePath,
        hermesAdapter.generateCompose(slug, port, workDir, { imageOrBuild: resolveImageOrBuild(settings), defaultImage: settings?.defaultImage }),
        'utf-8'
      )
      composeGenerated = true
    }

    // 8. Read metadata from the copy for overlay registration
    let persona = ''
    try {
      const soulPath = path.join(workDir, 'SOUL.md')
      const content = fs.readFileSync(soulPath, 'utf-8')
      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('---'))
      persona = lines.join(' ').slice(0, 200)
    } catch {}

    const env = parseEnvFilePairs(path.join(workDir, '.env'))
    let platform = 'hermes'
    if (env['MATTERMOST_TOKEN'] || env['MATTERMOST_URL']) {
      platform = 'mattermost'
    } else if (env['TELEGRAM_BOT_TOKEN']) {
      platform = 'telegram'
    }
    const agentPort = env['API_SERVER_PORT'] ? parseInt(env['API_SERVER_PORT'], 10) : undefined
    const channel = agentPort ? `:${agentPort}` : ''

    const models = readModelConfig(workDir)

    let tools: string[] = []
    try {
      const skillsDir = path.join(workDir, 'skills')
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      tools = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .slice(0, 50)
    } catch {}

    // 9. Register overlay
    const overlay = await this.createOverlay({ name: slug, platform, channel, models })

    const patches: Partial<Harness> = {}
    if (persona) patches.persona = persona
    if (tools.length > 0) patches.tools = tools
    patches.composeFile = composePath
    patches.serviceName = hermesAdapter.serviceName(slug)
    // Persist the port the compose actually publishes — createOverlay above
    // allocated its own throwaway port, so pin the authoritative one here (and
    // align the display channel) for the next allocation to reserve.
    patches.apiPort = port
    patches.channel = `:${port}`

    if (Object.keys(patches).length > 0) {
      Object.assign(overlay, patches)
      const overlays = this.storage.read<Partial<Harness>[]>('harnesses.json', [])
      const idx = overlays.findIndex((h) => h.id === overlay.id)
      if (idx !== -1) {
        overlays[idx] = { ...overlays[idx], ...patches }
        this.storage.write('harnesses.json', overlays)
      }
    }

    // Git auth is provisioned by the agent runtime at container boot (a
    // cont-init hook reads the imported agent's own .env). HSM deliberately
    // doesn't write these files here — doing so is exactly what would clobber
    // an imported user's existing git setup.

    return {
      id: overlay.id,
      name: slug,
      sourceDir: expandedSource,
      destDir,
      changes: {
        copied,
        envVarsAdded,
        pluginsInstalled,
        bootMdCreated,
        composeGenerated,
      },
    }
  }

  restartRunning(): { restarted: string[]; errors: Record<string, string> } {
    const running = this.list().filter((h) => h.status === 'running')
    const restarted: string[] = []
    const errors: Record<string, string> = {}
    for (const harness of running) {
      try {
        if (harness.composeFile && harness.serviceName) {
          this.docker.restart(harness.composeFile, harness.serviceName, 'quick')
          restarted.push(harness.id)
          this.audit.append({ who: 'admin', what: 'restart:quick', target: harness.name })
        }
      } catch (err) {
        errors[harness.id] = err instanceof Error ? err.message : String(err)
      }
    }
    return { restarted, errors }
  }
}
