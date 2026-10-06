/**
 * Discord thread mention gate — DISCORD_THREAD_REQUIRE_MENTION.
 *
 * 2026-10-06 (#bounties-work): two bots answered un-mentioned messages inside a
 * thread. The adapter skips the @mention check in any thread the bot has
 * "participated" in unless thread_require_mention is on, and its default is
 * off. Neither bot's .env set the var, and swarm-map had no knob for it.
 *
 * Fleet policy (Juniper, 2026-10-06): @mention is required everywhere,
 * threads included. The only sanctioned way to let an agent answer freely is
 * DISCORD_FREE_RESPONSE_CHANNELS (blackhouse's #theblackhouse), or an explicit
 * per-agent DISCORD_THREAD_REQUIRE_MENTION=false listed in the
 * `discordThreadMentionOptOuts` setting.
 *
 * This module has three parts, deliberately separated:
 *   - `ensureDiscordThreadGate` — the ONLY writer: adds `=true` to a Discord
 *     agent's .env when the key is absent or empty. Never overrides a value.
 *   - `healDiscordThreadGates` — runs that over the fleet (once per server
 *     start, from instrumentation.ts). Skips opted-out agents.
 *   - `discordThreadPosture` — REPORT ONLY. Computes each agent's effective
 *     gate the way the adapter does and lists the open ones. It never writes:
 *     a second .env writer is how the retired
 *     disabled-hermes-discord-policy-assert.py fought the console.
 *
 * Adapter precedence (plugins/platforms/discord/adapter.py,
 * `_discord_thread_require_mention` + the yaml→env bridge):
 *   1. config.yaml `platforms.discord.extra.thread_require_mention` — outranks
 *      everything, including .env. HSM must never write it there.
 *   2. .env DISCORD_THREAD_REQUIRE_MENTION, when non-empty.
 *   3. config.yaml top-level `discord.thread_require_mention`, bridged into the
 *      env only when the env var is unset/empty.
 *   4. the adapter default ("false" on the adapter the fleet runs today).
 */

import fs from 'fs'
import path from 'path'
import { SURFACES } from '@/lib/surfaces/registry'

export const DISCORD_THREAD_GATE_VAR = SURFACES.discord.behavior.threadRequireMention!

const TOKEN_VAR = SURFACES.discord.credentials[0] // DISCORD_BOT_TOKEN
const ENV_TRUTHY = new Set(['true', '1', 'yes', 'on'])
const EXTRA_FALSY = new Set(['false', '0', 'no', 'off'])

// ── .env helpers ─────────────────────────────────────────────────────────────

/**
 * The value of KEY in a .env as docker's env_file delivers it, or undefined
 * when there is no (uncommented) line. Last line wins, like compose.
 */
export function readEnvValue(env: string, key: string): string | undefined {
  let value: string | undefined
  for (const raw of env.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith(`${key}=`)) continue
    let v = line.slice(key.length + 1).trim()
    const q = v[0]
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    value = v
  }
  return value
}

/** True when the .env carries a non-empty Discord bot token. */
export function hasDiscordSurface(env: string): boolean {
  return !!readEnvValue(env, TOKEN_VAR)
}

/**
 * Add DISCORD_THREAD_REQUIRE_MENTION=true to a Discord agent's .env when the
 * key is absent, and heal an empty value (the adapter reads "" as false when
 * the yaml is silent). An explicit value — true OR false — is never touched:
 * false is how an operator opts an agent out. No-op for non-Discord agents.
 */
export function ensureDiscordThreadGate(env: string): string {
  if (!hasDiscordSurface(env)) return env
  const emptyLine = new RegExp(`^(${DISCORD_THREAD_GATE_VAR})=[ \\t]*(\\r?)$`, 'm')
  if (emptyLine.test(env)) return env.replace(emptyLine, '$1=true$2')
  if (readEnvValue(env, DISCORD_THREAD_GATE_VAR) !== undefined) return env
  return env.trimEnd() + `\n${DISCORD_THREAD_GATE_VAR}=true\n`
}

// ── minimal YAML reader ──────────────────────────────────────────────────────

export type YamlScalar = string | number | boolean | null

/**
 * Read one scalar at an exact key path from a block-style YAML document,
 * without a YAML dependency (HSM handles config.yaml as text everywhere).
 *
 * Matches keys only at the exact nesting the path names, so the nested
 * `  platforms:` block real fleet configs carry under another section is never
 * mistaken for the top-level one (the nested-platforms trap). Duplicate keys:
 * last wins, as in PyYAML. Scalars are typed with YAML 1.1 rules (PyYAML):
 * yes/no/on/off are booleans, ~/null are null.
 *
 * Flow-style mappings (`discord: {a: b}`) are not parsed — reported as not
 * found, which the posture check surfaces as the adapter default rather than
 * guessing.
 */
export function readYamlScalar(text: string, keys: string[]): { found: boolean; value: YamlScalar } {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  let start = 0
  let end = lines.length
  let parentIndent = -1

  for (let depth = 0; depth < keys.length; depth++) {
    const key = keys[depth]
    const last = depth === keys.length - 1
    // Child indent = indent of the first content line in the block.
    let childIndent = -1
    for (let i = start; i < end; i++) {
      if (isBlank(lines[i])) continue
      childIndent = indentOf(lines[i])
      break
    }
    if (childIndent <= parentIndent) return { found: false, value: null }

    let hit = -1
    let rest = ''
    for (let i = start; i < end; i++) {
      const line = lines[i]
      if (isBlank(line) || indentOf(line) !== childIndent) continue
      const m = line.slice(childIndent).match(/^(['"]?)([^'":#][^:]*?)\1:(?:\s+(.*))?$/)
      if (m && m[2] === key) {
        hit = i
        rest = m[3] ?? ''
      }
    }
    if (hit === -1) return { found: false, value: null }

    if (last) return { found: true, value: parseScalar(rest) }

    // Descend: the block is every following line indented deeper than the key.
    let blockEnd = hit + 1
    while (blockEnd < end && (isBlank(lines[blockEnd]) || indentOf(lines[blockEnd]) > childIndent)) blockEnd++
    start = hit + 1
    end = blockEnd
    parentIndent = childIndent
  }
  return { found: false, value: null }
}

function isBlank(line: string): boolean {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function parseScalar(raw: string): YamlScalar {
  let v = raw.trim()
  if (v.startsWith("'") || v.startsWith('"')) {
    const q = v[0]
    const close = v.indexOf(q, 1)
    return close === -1 ? v.slice(1) : v.slice(1, close)
  }
  v = v.replace(/\s+#.*$/, '').trim()
  if (v === '' || v === '~' || /^null$/i.test(v)) return null
  if (/^(true|yes|on)$/i.test(v)) return true
  if (/^(false|no|off)$/i.test(v)) return false
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

// ── effective gate ───────────────────────────────────────────────────────────

export type ThreadGateSource =
  | 'platforms.discord.extra'
  | 'env'
  | 'env-empty'
  | 'yaml discord:'
  | 'adapter-default'

/**
 * The thread gate the adapter will actually apply, and which layer decided it.
 * `adapterDefault` is false for the adapter the fleet runs today; pass true
 * once every agent runs a build with the fail-closed default.
 */
export function effectiveDiscordThreadGate(input: {
  env: string
  configYaml: string | null
  adapterDefault?: boolean
}): { requireMention: boolean; source: ThreadGateSource } {
  const yaml = input.configYaml ?? ''

  // 1. platforms.discord.extra — outranks .env.
  const extra = readYamlScalar(yaml, ['platforms', 'discord', 'extra', 'thread_require_mention'])
  if (extra.found && extra.value !== null) {
    const v = extra.value
    const requireMention = typeof v === 'string' ? !EXTRA_FALSY.has(v.toLowerCase()) : Boolean(v)
    return { requireMention, source: 'platforms.discord.extra' }
  }

  // 2. .env, when non-empty.
  const envVal = readEnvValue(input.env, DISCORD_THREAD_GATE_VAR)
  if (envVal) return { requireMention: ENV_TRUTHY.has(envVal.toLowerCase()), source: 'env' }

  // 3. top-level `discord:` — bridged into env as str(value).lower().
  const top = readYamlScalar(yaml, ['discord', 'thread_require_mention'])
  if (top.found) {
    const s = top.value === null ? 'none' : String(top.value).toLowerCase()
    return { requireMention: ENV_TRUTHY.has(s), source: 'yaml discord:' }
  }

  // An empty env value with no yaml is read as "" → false, NOT the default.
  if (envVal === '') return { requireMention: false, source: 'env-empty' }

  // 4. adapter default.
  return { requireMention: input.adapterDefault ?? false, source: 'adapter-default' }
}

// ── fleet heal (the writer) + posture (report only) ──────────────────────────

export type ThreadGateTarget = { name: string; dataDir: string }

export type ThreadGateHealResult = { healed: string[]; skipped: string[]; failed: string[] }

/**
 * Apply `ensureDiscordThreadGate` to every target's .env. Opted-out agents and
 * agents without a .env or a Discord token are skipped. Never throws; never
 * touches config.yaml. Running containers keep their env until their next
 * recreate.
 */
export function healDiscordThreadGates(
  targets: ThreadGateTarget[],
  optOuts: readonly string[],
): ThreadGateHealResult {
  const result: ThreadGateHealResult = { healed: [], skipped: [], failed: [] }
  const opted = new Set(optOuts)
  for (const t of targets) {
    if (opted.has(t.name)) {
      result.skipped.push(t.name)
      continue
    }
    const envPath = path.join(t.dataDir, '.env')
    try {
      if (!fs.existsSync(envPath)) continue
      const env = fs.readFileSync(envPath, 'utf-8')
      const next = ensureDiscordThreadGate(env)
      if (next === env) continue
      // writeFileSync on an existing path keeps its mode (0600 for agent .envs).
      fs.writeFileSync(envPath, next)
      result.healed.push(t.name)
    } catch (err) {
      result.failed.push(t.name)
      console.error(`[discord-thread-gate] failed to heal ${envPath}:`, err)
    }
  }
  return result
}

export type ThreadPostureStatus = 'ok' | 'open' | 'opted-out' | 'no-discord' | 'unreadable'

export type ThreadPostureRow = {
  name: string
  status: ThreadPostureStatus
  requireMention?: boolean
  source?: ThreadGateSource
  /** Channels where the agent answers without any mention (incl. threads in them). */
  freeResponseChannels?: string[]
  error?: string
}

export type ThreadPostureReport = {
  ok: boolean
  adapterDefault: boolean
  optOuts: string[]
  open: string[]
  agents: ThreadPostureRow[]
}

/**
 * REPORT ONLY — reads each agent's .env and config.yaml and lists the Discord
 * agents whose effective thread gate is off and that are not opted out.
 * Writes nothing.
 */
export function discordThreadPosture(
  targets: ThreadGateTarget[],
  optOuts: readonly string[],
  adapterDefault = false,
): ThreadPostureReport {
  const opted = new Set(optOuts)
  const agents: ThreadPostureRow[] = []
  for (const t of targets) {
    let env: string
    try {
      env = fs.readFileSync(path.join(t.dataDir, '.env'), 'utf-8')
    } catch (err) {
      agents.push({ name: t.name, status: 'unreadable', error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!hasDiscordSurface(env)) {
      agents.push({ name: t.name, status: 'no-discord' })
      continue
    }
    let configYaml: string | null = null
    try {
      configYaml = fs.readFileSync(path.join(t.dataDir, 'config.yaml'), 'utf-8')
    } catch {}
    const gate = effectiveDiscordThreadGate({ env, configYaml, adapterDefault })
    const row: ThreadPostureRow = {
      name: t.name,
      status: gate.requireMention ? 'ok' : opted.has(t.name) ? 'opted-out' : 'open',
      requireMention: gate.requireMention,
      source: gate.source,
    }
    const free = freeResponseChannels(env, configYaml)
    if (free.length) row.freeResponseChannels = free
    agents.push(row)
  }
  const open = agents.filter((a) => a.status === 'open').map((a) => a.name)
  return { ok: open.length === 0, adapterDefault, optOuts: [...optOuts], open, agents }
}

function freeResponseChannels(env: string, configYaml: string | null): string[] {
  // Same precedence as the adapter: extra > env > yaml discord: block.
  const yaml = configYaml ?? ''
  const extra = readYamlScalar(yaml, ['platforms', 'discord', 'extra', 'free_response_channels'])
  let raw: string | undefined
  if (extra.found && extra.value !== null) raw = String(extra.value)
  else raw = readEnvValue(env, 'DISCORD_FREE_RESPONSE_CHANNELS') || undefined
  if (raw === undefined) {
    const top = readYamlScalar(yaml, ['discord', 'free_response_channels'])
    if (top.found && top.value !== null) raw = String(top.value)
  }
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}
