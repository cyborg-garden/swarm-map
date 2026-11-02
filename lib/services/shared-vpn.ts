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

/**
 * The top-level `platforms.api_server` of an agent's config.yaml, line-parsed
 * (config.yaml is never round-tripped through a YAML parser here; see
 * lib/config-yaml-helpers.ts). Anchors to the column-0 `platforms:` key, so a
 * nested `  platforms:` elsewhere is ignored.
 */
export function readApiServerConfig(configYaml: string): { enabled: boolean; port?: number; unreadable?: true } {
  return readPlatformConfig(configYaml, 'api_server')
}

/** `platforms.<name>.enabled` and `.extra.port` from config.yaml (top-level block only). */
export function readPlatformConfig(configYaml: string, name: string): { enabled: boolean; port?: number; unreadable?: true } {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid platform name '${name}'`)
  // Any inline value (flow mapping `{...}`, anchor, alias) after the entry key
  // is a shape this line parser cannot read: report it, never guess "off".
  const inlineRe = new RegExp(`^\\s+${name}:[ \\t]*[^\\s#]`)
  const entryRe = new RegExp(`^\\s+${name}:[ \\t]*(#.*)?$`)
  const lines = configYaml.replace(/\r\n/g, '\n').split('\n')
  const top = lines.findIndex((l) => /^platforms:[ \t]*(#.*)?$/.test(l))
  if (top < 0) return { enabled: false }
  let i = top + 1
  let entry = -1
  let entryIndent = 0
  let childIndent = -1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    if (/^\S/.test(l)) break
    const indent = l.match(/^(\s*)/)![1].length
    // Direct children only: the first child's indent defines the level, so a
    // deeper `api_server:` under some other platform is not this entry.
    if (childIndent < 0) childIndent = indent
    if (indent === childIndent && inlineRe.test(l)) return { enabled: false, unreadable: true }
    if (indent === childIndent && entryRe.test(l)) {
      entry = i
      entryIndent = indent
      break
    }
  }
  if (entry < 0) return { enabled: false }
  let enabled = false
  let port: number | undefined
  let unreadable = false
  let inExtra = false
  let extraIndent = 0
  for (let j = entry + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '' || /^\s*#/.test(l)) continue
    const indent = l.match(/^(\s*)/)![1].length
    if (indent <= entryIndent) break
    const val = l.trim().replace(/\s+#.*$/, '')
    if (inExtra && indent <= extraIndent) inExtra = false
    if (!inExtra) {
      const en = val.match(/^enabled:\s*(.+)$/)
      if (en) {
        const v = en[1].trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase()
        if (['true', 'yes', 'on'].includes(v)) enabled = true
        else if (['false', 'no', 'off'].includes(v)) enabled = false
        else unreadable = true
      }
      if (/^extra:/.test(val)) {
        if (!/^extra:\s*$/.test(val)) unreadable = true
        inExtra = true
        extraIndent = indent
      }
    } else {
      const p = val.match(/^port:\s*(.*)$/)
      if (p) {
        const m = p[1].trim().match(/^(['"]?)(\d+)\1$/)
        if (m) port = parseInt(m[2], 10)
        else unreadable = true
      }
    }
  }
  const out: { enabled: boolean; port?: number; unreadable?: true } = { enabled }
  if (port !== undefined) out.port = port
  if (unreadable) out.unreadable = true
  return out
}

/**
 * Null when the agent's API server, if it runs at all, will listen on `port`
 * inside the shared namespace; otherwise why not.
 *
 * Deliberately does NOT emulate hermes' precedence between env and
 * config.yaml: it differs across hermes versions (older gateways apply env
 * API_SERVER_PORT when API_SERVER_ENABLED or a key is set; newer ones only
 * with a usable key), and hermes re-loads the agent's own `.env` over the
 * process environment, so the compose pin does not outrank `.env` either.
 * Instead every source that can name a port must agree with `port`:
 *   - `.env` API_SERVER_PORT, when set;
 *   - config.yaml `platforms.api_server.extra.port`, when set.
 * With neither set, every precedence order lands on the compose pin.
 */
export function apiServerPortBlocker(opts: {
  configYaml: string
  env: Record<string, string>
  port: number
}): string | null {
  const { configYaml, env, port } = opts
  const envPort = (env.API_SERVER_PORT ?? '').trim()
  if (envPort !== '' && envPort !== String(port)) {
    return `This agent's .env sets API_SERVER_PORT=${envPort}, but on the shared VPN it must use its own ` +
      `port ${port} (agents there share one network). Set API_SERVER_PORT=${port} in its .env, then retry.`
  }
  const cfg = readApiServerConfig(configYaml)
  if (cfg.unreadable) {
    return 'Could not read platforms.api_server in this agent\'s config.yaml (an inline or unusual YAML ' +
      'form), so its API port cannot be checked for the shared VPN. Rewrite it in block form, then retry.'
  }
  if (cfg.port !== undefined && cfg.port !== port) {
    return `This agent's config.yaml sets platforms.api_server.extra.port to ${cfg.port}. ` +
      `Agents on the shared VPN share one network, so each needs its own port — remove that port line ` +
      `(the shared VPN then assigns ${port}) or set it to ${port}.`
  }
  return null
}

/**
 * Gateway listeners on a FIXED default port. Two VPN'd agents with the same
 * one on would collide in the shared namespace, and nothing makes their ports
 * unique yet, so they are refused. Each can be switched on from config.yaml
 * or from env vars alone (hermes gateway/config.py), so both are checked.
 */
export const FIXED_PORT_PLATFORMS = ['webhook', 'msgraph_webhook', 'a2a', 'teams', 'bluebubbles', 'whatsapp_cloud'] as const

const truthy = (v?: string) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())
const set = (v?: string) => (v ?? '').trim() !== ''

/** Env-only ways to switch a fixed-port listener on (hermes gateway/config.py, s6 dashboard). */
const ENV_LISTENERS: Array<[string, (env: Record<string, string>) => boolean]> = [
  ['webhook', (e) => truthy(e.WEBHOOK_ENABLED) || set(e.WEBHOOK_PORT)],
  ['msgraph_webhook', (e) => truthy(e.MSGRAPH_WEBHOOK_ENABLED) || set(e.MSGRAPH_WEBHOOK_PORT)
    || set(e.MSGRAPH_WEBHOOK_CLIENT_STATE) || set(e.MSGRAPH_WEBHOOK_ACCEPTED_RESOURCES)],
  ['teams', (e) => set(e.TEAMS_PORT)],
  ['bluebubbles', (e) => set(e.BLUEBUBBLES_SERVER_URL) && set(e.BLUEBUBBLES_PASSWORD)],
  ['whatsapp_cloud', (e) => set(e.WHATSAPP_CLOUD_PHONE_NUMBER_ID) && set(e.WHATSAPP_CLOUD_ACCESS_TOKEN)],
  ['dashboard', (e) => truthy(e.HERMES_DASHBOARD)],
]

/**
 * Null when no fixed-port listener is on; otherwise why the agent cannot join.
 * Checked when the VPN is turned on. A later .env/config.yaml edit is not
 * rechecked (see the PR risk notes): the symptom is the second agent's
 * listener failing to bind, logged by that agent.
 */
export function fixedPortPlatformBlocker(configYaml: string, env: Record<string, string> = {}): string | null {
  const unreadable: string[] = []
  const on = new Set<string>()
  for (const name of FIXED_PORT_PLATFORMS) {
    const cfg = readPlatformConfig(configYaml, name)
    if (cfg.unreadable) unreadable.push(name)
    else if (cfg.enabled) on.add(name)
  }
  for (const [name, test] of ENV_LISTENERS) if (test(env)) on.add(name)
  if (unreadable.length) {
    return `Could not read platforms.${unreadable.join(', platforms.')} in this agent's config.yaml (an inline ` +
      'or unusual YAML form), so its fixed-port listeners cannot be checked. Rewrite it in block form, then retry.'
  }
  if (!on.size) return null
  return `This agent turns on ${[...on].join(', ')}, which listen on a fixed port. ` +
    'Agents on the shared VPN share one network, so a second agent with the same listener would fail ' +
    'to bind. Turn it off for this agent, or keep this agent off the shared VPN.'
}
