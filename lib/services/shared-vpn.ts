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

/** [start, end) of the `hermes-<name>` service block, or null. */
function serviceBounds(lines: string[], agentName: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trimEnd() === `  hermes-${agentName}:`)
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^ {0,3}\S/.test(lines[end])) end++
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
      while (end < to && /^ {5,}\S/.test(lines[end])) end++
      return [i, end]
    }
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
  if (keySpan(lines, start + 1, end, 'networks')) {
    throw new Error(`shared VPN: hermes-${agentName} has a service-level networks: key, which network_mode: container forbids`)
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
      out.push(STASH + lines[i].slice(4))
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
      out.push('    ' + l.slice(STASH.length))
      continue
    }
    out.push(l)
  }
  const result = [...lines.slice(0, start), ...out, ...lines.slice(end)].join('\n')
  if (result.includes(MARK) || composeSharedVpnState(result, agentName) !== 'off') {
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
export function readApiServerConfig(configYaml: string): { enabled: boolean; port?: number } {
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
    if (indent === childIndent && /^\s+api_server:[ \t]*(#.*)?$/.test(l)) {
      entry = i
      entryIndent = indent
      break
    }
  }
  if (entry < 0) return { enabled: false }
  let enabled = false
  let port: number | undefined
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
      if (en) enabled = /^(true|yes|on)$/i.test(en[1].trim())
      if (/^extra:\s*$/.test(val)) {
        inExtra = true
        extraIndent = indent
      }
    } else {
      const p = val.match(/^port:\s*['"]?(\d+)['"]?$/)
      if (p) port = parseInt(p[1], 10)
    }
  }
  return port === undefined ? { enabled } : { enabled, port }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Null when the agent's API server, if it runs at all, will listen on `port`
 * inside the shared namespace; otherwise why not.
 *
 * Mirrors hermes' gateway: env API_SERVER_PORT is applied over config.yaml only
 * when API_SERVER_ENABLED is truthy or API_SERVER_KEY is set; otherwise a port
 * in `platforms.api_server.extra.port` wins and env is only the fallback. So
 * the one shape the compose pin cannot fix is "enabled in config.yaml with an
 * explicit extra.port" — every such agent would bind that same port.
 */
export function apiServerPortBlocker(opts: {
  configYaml: string
  env: Record<string, string>
  port: number
}): string | null {
  const { configYaml, env, port } = opts
  const envOverrides = TRUTHY.has((env.API_SERVER_ENABLED ?? '').trim().toLowerCase())
    || (env.API_SERVER_KEY ?? '').trim() !== ''
  if (envOverrides) return null
  const cfg = readApiServerConfig(configYaml)
  if (!cfg.enabled || cfg.port === undefined || cfg.port === port) return null
  return `This agent's config.yaml enables the API server on port ${cfg.port} ` +
    `(platforms.api_server.extra.port). Agents on the shared VPN share one network, so each needs ` +
    `its own port — remove that port line (the shared VPN then assigns ${port}) or set it to ${port}.`
}
