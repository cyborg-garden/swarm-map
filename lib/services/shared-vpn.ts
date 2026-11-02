/**
 * Shared VPN: agents with it on join ONE gluetun container's network
 * namespace (`network_mode: "container:gluetun-shared"`), so the whole VPN'd
 * fleet exits through a single Mullvad device while the host itself stays off
 * VPN (its Cloudflare tunnel cannot run through Mullvad).
 *
 * Why this is separate from the per-agent VPN (`VPN_ENABLED`, wireguard +
 * camofox sidecars in harness-compose.ts): that one is a different product (a
 * VPN'd browser with VNC escalation, one tunnel per agent) and it is built by
 * REGENERATING the compose from the standalone template, which the settings
 * route refuses on deploy-born composes because regeneration strips their
 * hardening. The shared VPN only changes the hermes service's networking
 * lines, so it is applied as a surgical, exactly-reversible transform on the
 * existing file — the deploy-born hardening is never re-rendered, so it cannot
 * be stripped. The generators also accept `sharedVpn` and produce the SAME
 * bytes as the transform (they call it), so any regeneration keeps the VPN.
 *
 * Source of truth: the compose file itself (`composeSharedVpnState`). There is
 * no second flag to drift from what actually runs.
 *
 * What the transform does to the `hermes-<name>` service, and nothing else:
 *   - comments out its `extra_hosts:` and `ports:` (compose forbids both on a
 *     service with `network_mode: container:`); the commented lines are kept
 *     verbatim with a `#~` prefix and restored when the VPN is turned off.
 *     `host.docker.internal` now comes from gluetun's own extra_hosts.
 *   - adds `network_mode: "container:gluetun-shared"`.
 *   - pins `API_SERVER_PORT=<the agent's own port>` in `environment:`. Every
 *     agent's API server defaults to 8642; inside ONE namespace two of them
 *     would collide. The agent's allocated host port is already unique fleet
 *     wide (port allocation), so it is reused as the in-namespace port. See
 *     `apiServerPortBlocker` for the one config shape the pin cannot override.
 *
 * Published ports: deliberately NONE while on the VPN. Moving each agent's
 * publish onto gluetun would mean recreating gluetun on every toggle, and
 * recreating gluetun cuts every joined agent off the network until each is
 * recreated too (they hold the old container's namespace). Withholding the
 * publish keeps a toggle's blast radius to the one agent. The commented
 * `published:` line keeps the port reserved for port allocation and for the
 * settings route, so turning the VPN off restores the same port.
 *
 * Kill switch: gluetun's firewall drops all non-tunnel traffic, so a joined
 * agent with the tunnel down has no internet (fails closed), except the
 * FIREWALL_OUTBOUND_SUBNETS the env file allows (the host gateway subnet, so
 * Ollama / swarm-map / Firecrawl on host.docker.internal keep working).
 *
 * Recreating gluetun (image bump, `up --force-recreate`, `down`) leaves every
 * joined agent with a dead namespace until the agent is recreated. Swarm-map
 * therefore only ever runs `up -d --no-recreate` on it. A plain restart of the
 * gluetun container behaves the same way for joined agents — recreate them
 * afterwards (Settings → restart, or `docker compose up -d --force-recreate`).
 *
 * Secrets: the WireGuard key lives in `<dataDir>/vpn/gluetun.env` (mode 600),
 * written by the owner's key script. Swarm-map only REFERENCES that path
 * (env_file) and checks it exists; it never reads, generates or prints it.
 */

import path from 'path'
import { assertNoNewline } from '@/lib/env-helpers'

/** Container every VPN'd agent joins. Must NOT start with hermes-/seraph- (discovery). */
export const SHARED_VPN_CONTAINER = 'gluetun-shared'
/** Compose project name of the shared gluetun stack. */
export const SHARED_VPN_PROJECT = 'swarm-vpn'
/**
 * Pinned by tag AND digest so the default can never silently drift. Digest is
 * the one the Mini resolved `qmcgaw/gluetun:v3.40.0` to on 2026-11-02 (the
 * image the hand-made vera setup was verified on). Bumping means re-verifying
 * the new tag's digest — and recreating every joined agent after gluetun.
 */
export const SHARED_VPN_IMAGE =
  'qmcgaw/gluetun:v3.40.0@sha256:2b42bfa046757145a5155acece417b65b4443c8033fb88661a8e9dcf7fda5a00'

const NETWORK_MODE_LINE = `    network_mode: "container:${SHARED_VPN_CONTAINER}"`
const MARK = '# shared-vpn'
const HEADER = [
  `    ${MARK}: on. Joined to ${SHARED_VPN_CONTAINER}; host.docker.internal comes from gluetun.`,
  `    ${MARK}: '#~' lines are this service's own networking, restored when the VPN is turned off.`,
]
const STASH = '    #~'

export type SharedVpnState = 'on' | 'off' | 'foreign'

export function sharedVpnPaths(swarmMapDataDir: string): {
  dir: string
  composeFile: string
  envFile: string
} {
  const dir = path.join(swarmMapDataDir, 'vpn')
  return {
    dir,
    composeFile: path.join(dir, 'docker-compose.yml'),
    envFile: path.join(dir, 'gluetun.env'),
  }
}

/** The shared gluetun compose. Publishes nothing; see the module doc. */
export function generateSharedVpnCompose(opts: { envFile: string }): string {
  const envFile = assertNoNewline(opts.envFile, 'shared VPN env file')
  if (!path.isAbsolute(envFile)) {
    throw new Error(`shared VPN env file must be an absolute path, got '${envFile}'`)
  }
  return `# Generated by hermes-swarm-map — shared VPN (gluetun).
# Every agent with the shared VPN on joins this container's network namespace.
# Do NOT recreate it (image bump, --force-recreate, down) without recreating
# every joined agent afterwards: they keep the old, dead namespace otherwise.
# The WireGuard key lives in the env_file below (mode 600, never in this file).
name: ${SHARED_VPN_PROJECT}
services:
  ${SHARED_VPN_CONTAINER}:
    image: ${SHARED_VPN_IMAGE}
    container_name: ${SHARED_VPN_CONTAINER}
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    env_file:
      - ${envFile}
    extra_hosts:
      - "host.docker.internal:host-gateway"
`
}

/**
 * True when line i is a blank or comment line whose block continues: the next
 * non-blank, non-comment line (before `to`) is indented at least `minIndent`.
 * YAML comments carry no structure, so a `  # note` at any indent inside a
 * service (or inside a key's list) must not end it.
 */
function gapContinues(lines: string[], i: number, to: number, minIndent: number): boolean {
  if (!(lines[i].trim() === '' || /^\s*#/.test(lines[i]))) return false
  for (let j = i + 1; j < to; j++) {
    if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue
    return lines[j].match(/^( *)/)![1].length >= minIndent
  }
  return false
}

/** [start, end) of the `hermes-<name>` service block, or null. */
function serviceBounds(lines: string[], agentName: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trimEnd() === `  hermes-${agentName}:`)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length
    && (!/^ {0,3}\S/.test(lines[end]) || gapContinues(lines, end, lines.length, 4))) end++
  // Trailing blank lines belong to the gap before the next key, not the service.
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  return [start, end]
}

/** [keyIdx, endIdx) of a 4-space service key and its nested (5+ space) lines. */
function keySpan(lines: string[], from: number, to: number, key: string): [number, number] | null {
  const re = new RegExp(`^ {4}${key}:(\\s.*)?$`)
  for (let i = from; i < to; i++) {
    if (re.test(lines[i])) {
      let end = i + 1
      while (end < to && (/^ {5,}\S/.test(lines[end]) || gapContinues(lines, end, to, 5))) end++
      return [i, end]
    }
  }
  return null
}

/**
 * The host port of THIS agent's hermes service: its first `published:` line,
 * including a stashed `#~` one while on the shared VPN. Null when none. Scoped
 * to the service so a multi-service file never yields a sibling's port.
 */
export function readServicePublishedPort(compose: string, agentName: string): number | null {
  const lines = compose.split('\n')
  const b = serviceBounds(lines, agentName)
  if (!b) return null
  for (let i = b[0] + 1; i < b[1]; i++) {
    const m = lines[i].match(/published:\s*(\d+)/)
    if (m) return parseInt(m[1], 10)
  }
  return null
}

/** The hermes service's `network_mode: ...` line (trimmed), or null. */
export function serviceNetworkMode(compose: string, agentName: string): string | null {
  const lines = compose.split('\n')
  const b = serviceBounds(lines, agentName)
  if (!b) return null
  for (let i = b[0] + 1; i < b[1]; i++) {
    if (/^ {4}network_mode:/.test(lines[i])) return lines[i].trim()
  }
  return null
}

export function composeSharedVpnState(compose: string, agentName: string): SharedVpnState {
  const lines = compose.split('\n')
  const b = serviceBounds(lines, agentName)
  if (!b) return 'off'
  for (let i = b[0] + 1; i < b[1]; i++) {
    if (/^ {4}network_mode:/.test(lines[i])) {
      return lines[i].trimEnd() === NETWORK_MODE_LINE ? 'on' : 'foreign'
    }
  }
  return 'off'
}

/**
 * Why this compose cannot take the shared VPN, or null. Checked BEFORE any
 * write so a refusal leaves no partial state.
 */
export function sharedVpnComposeBlocker(compose: string, agentName: string): string | null {
  if (new RegExp(`^ {2}ollama-${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm').test(compose)) {
    return 'This agent bundles an ollama sidecar, which the agent reaches by service name on its own ' +
      'network — unreachable from the shared VPN namespace. Remove the sidecar first.'
  }
  try {
    applySharedVpnToCompose(compose, agentName, 1)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function applySharedVpnToCompose(compose: string, agentName: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`shared VPN: invalid API port '${port}'`)
  }
  const lines = compose.split('\n')
  const b = serviceBounds(lines, agentName)
  if (!b) throw new Error(`shared VPN: no "hermes-${agentName}" service in compose`)
  const [start, end] = b
  for (let i = start + 1; i < end; i++) {
    if (/^ {4}network_mode:/.test(lines[i])) {
      throw new Error(
        `shared VPN: hermes-${agentName} already has a network_mode (${lines[i].trim()}) — refusing to stack another`)
    }
  }
  for (let i = start + 1; i < end; i++) {
    if (lines[i].includes(MARK) || lines[i].startsWith(STASH)) {
      throw new Error(`shared VPN: hermes-${agentName} carries leftover shared-vpn markers — fix the compose by hand`)
    }
  }
  // Keys Docker rejects (or silently ignores) on a service that joins another
  // container's network. ports/extra_hosts are stashed below; the rest are
  // refused, since dropping them would change what the service means.
  for (const key of ['networks', 'hostname', 'domainname', 'dns', 'dns_search', 'dns_opt', 'expose', 'links', 'mac_address']) {
    if (keySpan(lines, start + 1, end, key)) {
      throw new Error(`shared VPN: hermes-${agentName} has a service-level ${key}: key, which network_mode: container forbids — remove it first`)
    }
  }

  const env = keySpan(lines, start + 1, end, 'environment')
  if (env) {
    if (lines[env[0]].trimEnd() !== '    environment:') {
      throw new Error('shared VPN: unsupported environment: form (expected a block list)')
    }
    for (let i = env[0] + 1; i < env[1]; i++) {
      if (!/^ {6}(- |#)/.test(lines[i])) {
        throw new Error('shared VPN: environment: must be list form (- KEY=value) to pin API_SERVER_PORT')
      }
    }
  }

  const stashed = (['extra_hosts', 'ports'] as const)
    .map((k) => keySpan(lines, start + 1, end, k))
    .filter((s): s is [number, number] => s !== null)
    .sort((a, b2) => a[0] - b2[0])

  const pin = `      - API_SERVER_PORT=${port} ${MARK}`
  // Build the new service block, top to bottom.
  const out: string[] = []
  const anchor = stashed.length ? stashed[0][0] : (() => {
    const idx = lines.findIndex((l, i) => i > start && i < end && /^ {4}container_name:/.test(l))
    if (idx < 0) throw new Error(`shared VPN: hermes-${agentName} has no container_name: to anchor on`)
    return idx + 1
  })()
  const inStash = (i: number) => stashed.some(([s, e]) => i >= s && i < e)

  for (let i = start; i < end; i++) {
    if (i === anchor) {
      out.push(...HEADER, NETWORK_MODE_LINE)
      if (!env) out.push(`    environment: ${MARK}`, pin)
    }
    // Stashed lines stay where they were, so turning off restores them in place.
    if (inStash(i)) {
      // Raw line kept whole (any indent), so restore is exact.
      out.push(STASH + lines[i])
      continue
    }
    out.push(lines[i])
    if (env && i === env[1] - 1) out.push(pin)
  }
  if (anchor === end) {
    // container_name was the last line of the service (unusual but legal).
    out.push(...HEADER, NETWORK_MODE_LINE)
    if (!env) out.push(`    environment: ${MARK}`, pin)
  }

  return [...lines.slice(0, start), ...out, ...lines.slice(end)].join('\n')
}

export function removeSharedVpnFromCompose(compose: string, agentName: string): string {
  if (composeSharedVpnState(compose, agentName) !== 'on') {
    throw new Error(`shared VPN: hermes-${agentName} is not on the shared VPN`)
  }
  const lines = compose.split('\n')
  const [start, end] = serviceBounds(lines, agentName)!
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const l = lines[i]
    if (l.startsWith(`    ${MARK}:`)) continue
    if (l === NETWORK_MODE_LINE) continue
    if (l === `    environment: ${MARK}`) continue
    if (/^ {6}- API_SERVER_PORT=\d+ # shared-vpn$/.test(l)) continue
    if (l.startsWith(STASH)) {
      out.push(l.slice(STASH.length))
      continue
    }
    out.push(l)
  }
  const result = [...lines.slice(0, start), ...out, ...lines.slice(end)].join('\n')
  // Scoped to THIS service: another agent in the same file may still be on.
  if (out.some((l) => l.includes(MARK) || l.startsWith(STASH)) || composeSharedVpnState(result, agentName) !== 'off') {
    throw new Error('shared VPN: compose was hand-edited after the VPN was applied — restore it by hand')
  }
  return result
}

// ---------------------------------------------------------------------------
// What the agent listens on, read from its config.yaml and env.
//
// Inside ONE shared namespace every listener is shared: two agents on the same
// fixed port fail to bind, and some adapters (whatsapp's local bridge) probe
// localhost and silently ATTACH to whichever agent's bridge answers first —
// a cross-agent message leak. So the check is an allowlist, not a denylist:
// an agent may join only when every platform it enables is a known
// outbound-only client, and its API server is on its own port.
//
// config.yaml is line-parsed (never round-tripped through a YAML parser here;
// see lib/config-yaml-helpers.ts). Anything this parser cannot read with
// confidence is reported as unreadable and refused — never guessed as "off".
// ---------------------------------------------------------------------------

/**
 * Platforms that only make outbound connections (bot gateways, the host's
 * signal-cli HTTP API), so any number of agents can run them side by side in
 * one namespace. Everything else enabled is refused.
 */
export const OUTBOUND_ONLY_PLATFORMS: ReadonlySet<string> = new Set([
  'discord', 'signal', 'telegram', 'slack', 'mattermost', 'matrix', 'email',
])

type YamlChild = { key: string; idx: number; inline: string; bodyStart: number; bodyEnd: number }

const isGap = (l: string) => l.trim() === '' || /^\s*#/.test(l)
const indentOf = (l: string) => l.match(/^( *)/)![1].length
const EMPTY_INLINE = new Set(['', '{}', 'null', '~'])
const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2')

/**
 * Direct children of the mapping occupying lines [from, to). Null when the
 * block is not a plain block mapping (a list, a tab-indented line, a key form
 * this parser does not know) — callers treat null as unreadable.
 */
function yamlChildren(lines: string[], from: number, to: number): YamlChild[] | null {
  const out: YamlChild[] = []
  let childIndent = -1
  for (let i = from; i < to; i++) {
    const l = lines[i]
    if (isGap(l)) continue
    if (/^\s*\t/.test(l)) return null
    const ind = indentOf(l)
    if (childIndent < 0) childIndent = ind
    if (ind < childIndent) return null
    if (ind > childIndent) continue // body of the previous child
    const m = l.slice(ind).match(/^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/)
    if (!m) return null
    const key = m[1] ?? m[2] ?? m[3]
    const inline = (m[4] ?? '').replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim()
    let end = i + 1
    while (end < to && (isGap(lines[end]) || indentOf(lines[end]) > childIndent)) end++
    // Trailing gap lines belong to the next sibling, not this body.
    let bodyEnd = end
    while (bodyEnd > i + 1 && isGap(lines[bodyEnd - 1])) bodyEnd--
    out.push({ key, idx: i, inline, bodyStart: i + 1, bodyEnd })
    i = end - 1
  }
  return out
}

export type PlatformEntry = { name: string; enabled: boolean; port?: number; unreadable?: true }

function parseBool(v: string): boolean | null {
  const t = unquote(v).toLowerCase()
  if (['true', 'yes', 'on'].includes(t)) return true
  if (['false', 'no', 'off'].includes(t)) return false
  return null
}

function readEntry(lines: string[], c: YamlChild): PlatformEntry {
  const name = c.key
  if (!EMPTY_INLINE.has(c.inline)) return { name, enabled: false, unreadable: true }
  const kids = yamlChildren(lines, c.bodyStart, c.bodyEnd)
  if (!kids) return { name, enabled: false, unreadable: true }
  const e: PlatformEntry = { name, enabled: false }
  for (const k of kids) {
    if (k.key === '<<') return { name, enabled: false, unreadable: true }
    if (k.key === 'enabled') {
      const b = parseBool(k.inline)
      if (b === null) return { name, enabled: false, unreadable: true }
      e.enabled = b
    }
    if (k.key === 'extra') {
      if (!EMPTY_INLINE.has(k.inline)) return { name, enabled: false, unreadable: true }
      const ex = yamlChildren(lines, k.bodyStart, k.bodyEnd)
      if (!ex) return { name, enabled: false, unreadable: true }
      for (const x of ex) {
        if (x.key !== 'port') continue
        const m = unquote(x.inline).match(/^\d+$/)
        if (!m) return { name, enabled: false, unreadable: true }
        e.port = parseInt(m[0], 10)
      }
    }
  }
  return e
}

/**
 * Every platform entry hermes would merge: top-level `platforms:` AND
 * `gateway.platforms` (hermes deep-merges the latter in). `unreadable` lists
 * the blocks this parser could not read with confidence.
 */
export function readPlatformEntries(configYaml: string): { entries: PlatformEntry[]; unreadable: string[] } {
  const lines = configYaml.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  const top = yamlChildren(lines, 0, lines.length)
  if (!top) return { entries: [], unreadable: ['config.yaml'] }
  const entries: PlatformEntry[] = []
  const unreadable: string[] = []
  const readPlatforms = (c: YamlChild, where: string) => {
    if (!EMPTY_INLINE.has(c.inline)) { unreadable.push(where); return }
    const kids = yamlChildren(lines, c.bodyStart, c.bodyEnd)
    if (!kids) { unreadable.push(where); return }
    for (const k of kids) {
      const e = readEntry(lines, k)
      if (e.unreadable) unreadable.push(`${where}.${e.name}`)
      entries.push(e)
    }
  }
  for (const c of top) {
    if (c.key === 'platforms') readPlatforms(c, 'platforms')
    if (c.key === 'gateway') {
      if (!EMPTY_INLINE.has(c.inline)) { unreadable.push('gateway'); continue }
      const kids = yamlChildren(lines, c.bodyStart, c.bodyEnd)
      if (!kids) { unreadable.push('gateway'); continue }
      for (const k of kids) if (k.key === 'platforms') readPlatforms(k, 'gateway.platforms')
    }
  }
  return { entries, unreadable }
}

/** `platforms.api_server` merged across both sources. */
export function readApiServerConfig(configYaml: string): { enabled: boolean; port?: number; unreadable?: true } {
  const { entries, unreadable } = readPlatformEntries(configYaml)
  const mine = entries.filter((e) => e.name === 'api_server')
  const out: { enabled: boolean; port?: number; unreadable?: true } = { enabled: mine.some((e) => e.enabled) }
  const port = mine.find((e) => e.port !== undefined)?.port
  if (port !== undefined) out.port = port
  if (mine.some((e) => e.unreadable) || unreadable.some((u) => !u.includes('.') || u.endsWith('.api_server'))) {
    out.unreadable = true
  }
  return out
}

/**
 * Parse an env file the way python-dotenv (what hermes loads `.env` with)
 * does for the shapes that matter here: `export KEY=v`, quoted values, and an
 * inline ` # comment` after an unquoted value.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2]
    const q = v.match(/^(['"])(.*?)\1/)
    if (q) v = q[2]
    else v = v.replace(/\s+#.*$/, '').trim()
    out[m[1]] = v
  }
  return out
}

/** `- KEY=value` entries of the hermes service's environment: list (our pin excluded). */
export function readServiceEnvironment(compose: string, agentName: string): Record<string, string> {
  const lines = compose.split('\n')
  const b = serviceBounds(lines, agentName)
  const out: Record<string, string> = {}
  if (!b) return out
  const env = keySpan(lines, b[0] + 1, b[1], 'environment')
  if (!env) return out
  for (let i = env[0] + 1; i < env[1]; i++) {
    if (lines[i].includes(MARK)) continue
    const m = lines[i].match(/^ {6}- ["']?([A-Za-z_][A-Za-z0-9_]*)=(.*?)["']?\s*$/)
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '')
  }
  return out
}

/**
 * Null when the agent's API server, if it runs at all, will listen on `port`
 * inside the shared namespace; otherwise why not.
 *
 * Deliberately does NOT emulate hermes' precedence between env and
 * config.yaml: it differs across hermes versions, and hermes re-loads the
 * agent's own `.env` over the process environment, so the compose pin does
 * not outrank `.env` either. Instead every source that can name a port must
 * agree with `port` (.env / compose environment API_SERVER_PORT, and
 * api_server.extra.port in either config.yaml block). With none set, every
 * precedence order lands on the compose pin.
 */
export function apiServerPortBlocker(opts: {
  configYaml: string
  env: Record<string, string>
  port: number
}): string | null {
  const { configYaml, env, port } = opts
  const envPort = (env.API_SERVER_PORT ?? '').trim()
  if (envPort !== '' && envPort !== String(port)) {
    return `This agent's environment sets API_SERVER_PORT=${envPort}, but on the shared VPN it must use its own ` +
      `port ${port} (agents there share one network). Set API_SERVER_PORT=${port} in its .env, then retry.`
  }
  const cfg = readApiServerConfig(configYaml)
  if (cfg.unreadable) {
    return 'Could not read the platforms settings in this agent\'s config.yaml (an inline or unusual YAML ' +
      'form), so its API port cannot be checked for the shared VPN. Rewrite it in block form, then retry.'
  }
  if (cfg.port !== undefined && cfg.port !== port) {
    return `This agent's config.yaml sets api_server.extra.port to ${cfg.port}. ` +
      `Agents on the shared VPN share one network, so each needs its own port — remove that port line ` +
      `(the shared VPN then assigns ${port}) or set it to ${port}.`
  }
  return null
}

const truthy = (v?: string) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

/**
 * Env-var prefixes of hermes platforms that open a local listener or bridge.
 * Any non-empty value under one counts as "on" (conservative), except an
 * explicit falsy `<PREFIX>ENABLED`. Platforms in OUTBOUND_ONLY_PLATFORMS are
 * deliberately absent.
 */
const LISTENER_ENV_PREFIXES = [
  'WEBHOOK_', 'MSGRAPH_WEBHOOK_', 'TEAMS_', 'BLUEBUBBLES_', 'WHATSAPP_', 'SMS_', 'LINE_',
  'WECOM_', 'FEISHU_', 'PHOTON_', 'A2A_',
]

/**
 * Null when every listener-capable platform this agent turns on is safe in a
 * shared namespace; otherwise why the agent cannot join. Checked when the VPN
 * is turned on; a later .env/config.yaml edit is not rechecked (documented
 * risk).
 */
export function fixedPortPlatformBlocker(configYaml: string, env: Record<string, string> = {}): string | null {
  const { entries, unreadable } = readPlatformEntries(configYaml)
  if (unreadable.length) {
    return `Could not read ${unreadable.join(', ')} in this agent's config.yaml (an inline or unusual YAML ` +
      'form), so its listeners cannot be checked for the shared VPN. Rewrite it in block form, then retry.'
  }
  const on = new Set<string>()
  for (const e of entries) {
    if (e.enabled && e.name !== 'api_server' && !OUTBOUND_ONLY_PLATFORMS.has(e.name)) on.add(e.name)
  }
  for (const [key, value] of Object.entries(env)) {
    const prefix = LISTENER_ENV_PREFIXES.find((p) => key.startsWith(p))
    if (!prefix || value.trim() === '') continue
    if (key.endsWith('_ENABLED') && !truthy(value)) continue
    on.add(key)
  }
  if (truthy(env.HERMES_DASHBOARD)) on.add('HERMES_DASHBOARD (dashboard)')
  if (!on.size) return null
  return `This agent turns on ${[...on].join(', ')}, which open a local listener or bridge. Agents on the ` +
    'shared VPN share one network, so a second agent would collide with it (or attach to its bridge). ' +
    'Turn it off for this agent, or keep this agent off the shared VPN.'
}
