/**
 * Fleet-wide Discord approver role for dangerous-command (DCG) approval.
 *
 * The Hermes Discord adapter (hermes-agent-mt#175) lets anyone holding a role
 * listed in `platforms.discord.extra.approver_roles` click Allow/Deny on a
 * dangerous-command prompt, alongside the people in `allow_admin_from`. The
 * role is checked live, from the member data Discord sends with each click,
 * in the server the prompt was posted in. So granting or removing the Discord
 * role takes effect at once; only changing WHICH role needs a config write.
 *
 * This module is that write. The `discordApproverRoles` setting holds the role
 * IDs; `syncDiscordApproverRoles` puts them into every Discord agent's
 * config.yaml. `discordApproverPosture` reports, never writes.
 *
 * What it does NOT do, on purpose:
 *   - touch `allow_admin_from` (the ID list keeps working as before) or
 *     `require_admin_for_exec_approval` (the gate stays a per-agent choice);
 *   - create a `platforms.discord.extra` block that is not there;
 *   - write .env DISCORD_APPROVER_ROLES — the adapter only uses it when the
 *     yaml is silent, and every fleet agent sets the yaml key.
 *
 * Adapter precedence for approver_roles (gateway/config.py):
 *   1. top-level `discord:` block — bridged into extra with extra.update(),
 *      so it OVERRIDES platforms.discord.extra. Reported as `shadowed`.
 *   2. top-level `platforms.discord.extra.approver_roles` — what we write.
 *   3. .env DISCORD_APPROVER_ROLES (setdefault, only when 1 and 2 are absent).
 *
 * Empty list = nobody approves by role (written as `approver_roles: ''`).
 * `null` / unset setting = swarm-map does not manage the key at all.
 */

import fs from 'fs'
import path from 'path'
import { hasDiscordSurface, readYamlScalar } from './discord-thread-gate'

export const APPROVER_ROLES_KEY = 'approver_roles'

/** A Discord snowflake. Each role lands verbatim inside a quoted YAML scalar. */
export const ROLE_ID_RE = /^[0-9]{15,21}$/

/** True when `v` is a list of role IDs safe to write (the settings patch rule, rechecked at write time). */
export function isApproverRoleList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((r) => typeof r === 'string' && ROLE_ID_RE.test(r))
}

export type ApproverWriteStatus = 'updated' | 'unchanged' | 'no-extra-block' | 'shadowed' | 'unsupported'

// ── YAML locating (text-only, exact key paths; see readYamlScalar) ───────────

type Found = { idx: number; indent: number; rest: string; blockEnd: number }

const KEY_RE = /^(['"]?)([^'":#\-\s][^:]*?)\1:(?:\s+(.*))?$/

function isBlank(line: string): boolean {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Find `key:` as a direct child of the block [start,end). null = absent, 'dup' = more than one. */
function findKey(lines: string[], start: number, end: number, parentIndent: number, key: string): Found | null | 'dup' {
  let childIndent = -1
  for (let i = start; i < end; i++) {
    if (isBlank(lines[i])) continue
    childIndent = indentOf(lines[i])
    break
  }
  if (childIndent <= parentIndent) return null
  let found: Found | null = null
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (isBlank(line) || indentOf(line) !== childIndent) continue
    const m = line.slice(childIndent).match(KEY_RE)
    if (!m || m[2] !== key) continue
    if (found) return 'dup'
    let blockEnd = i + 1
    while (blockEnd < end && (isBlank(lines[blockEnd]) || indentOf(lines[blockEnd]) > childIndent)) blockEnd++
    // Trailing blank/comment lines belong to whatever follows, not this key.
    while (blockEnd > i + 1 && isBlank(lines[blockEnd - 1])) blockEnd--
    found = { idx: i, indent: childIndent, rest: (m[3] ?? '').trim(), blockEnd }
  }
  return found
}

/** Walk an exact key path from the top level. */
function findPath(lines: string[], keys: string[]): Found | null | 'dup' {
  let start = 0
  let end = lines.length
  let parentIndent = -1
  let hit: Found | null = null
  for (const key of keys) {
    const f = findKey(lines, start, end, parentIndent, key)
    if (f === null || f === 'dup') return f
    hit = f
    start = f.idx + 1
    end = f.blockEnd
    parentIndent = f.indent
  }
  return hit
}

function stripComment(v: string): string {
  return v.startsWith("'") || v.startsWith('"') ? v : v.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
}

function unquote(v: string): string {
  const q = v[0]
  if ((q === "'" || q === '"') && v.length >= 2) {
    const close = v.indexOf(q, 1)
    return close === -1 ? v.slice(1) : v.slice(1, close)
  }
  return v
}

/** Role entries from an approver_roles value (inline scalar, flow list, or block list). */
function parseRoles(lines: string[], f: Found): string[] {
  const rest = stripComment(f.rest).trim()
  let items: string[]
  if (rest === '' || rest === '~' || /^null$/i.test(rest)) {
    items = lines
      .slice(f.idx + 1, f.blockEnd)
      .filter((l) => !isBlank(l))
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => unquote(stripComment(l.slice(2).trim()).trim()))
  } else if (rest.startsWith('[')) {
    items = rest.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s.trim()))
  } else {
    items = [unquote(rest)]
  }
  return items.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
}

/** The approver roles a config.yaml sets under platforms.discord.extra. */
export function readApproverRoles(yaml: string): { found: boolean; roles: string[] } {
  const lines = yaml.split(/\r?\n/)
  const f = findPath(lines, ['platforms', 'discord', 'extra', APPROVER_ROLES_KEY])
  if (!f || f === 'dup') return { found: false, roles: [] }
  return { found: true, roles: parseRoles(lines, f) }
}

/**
 * Set platforms.discord.extra.approver_roles to exactly `roles`. Only that key
 * changes; every other line, including allow_admin_from and the nested
 * `platforms:` block real configs carry under display:, is left as is.
 */
export function setApproverRolesYaml(yaml: string, roles: readonly string[]): { status: ApproverWriteStatus; yaml: string } {
  // settings.json is read back unvalidated; a hand edit must not inject YAML.
  if (!isApproverRoleList(roles)) throw new Error('approver roles must be Discord role IDs')
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n'
  const lines = yaml.split(/\r?\n/)

  // The top-level discord: block overrides extra — writing extra would be a lie.
  const top = findPath(lines, ['discord'])
  if (top === 'dup') return { status: 'unsupported', yaml }
  if (top) {
    const shadow = findKey(lines, top.idx + 1, top.blockEnd, top.indent, APPROVER_ROLES_KEY)
    if (shadow === 'dup' || shadow) return { status: 'shadowed', yaml }
  }

  const extra = findPath(lines, ['platforms', 'discord', 'extra'])
  if (extra === 'dup') return { status: 'unsupported', yaml }
  if (!extra) return { status: 'no-extra-block', yaml }
  if (stripComment(extra.rest).trim() !== '') return { status: 'unsupported', yaml } // flow style

  const existing = findKey(lines, extra.idx + 1, extra.blockEnd, extra.indent, APPROVER_ROLES_KEY)
  if (existing === 'dup') return { status: 'unsupported', yaml }

  if (existing) {
    const current = parseRoles(lines, existing)
    if (current.length === roles.length && current.every((r, i) => r === roles[i])) {
      return { status: 'unchanged', yaml }
    }
    const line = `${' '.repeat(existing.indent)}${APPROVER_ROLES_KEY}: '${roles.join(',')}'`
    lines.splice(existing.idx, existing.blockEnd - existing.idx, line)
  } else {
    let childIndent = extra.indent + 2
    for (let i = extra.idx + 1; i < extra.blockEnd; i++) {
      if (!isBlank(lines[i])) { childIndent = indentOf(lines[i]); break }
    }
    lines.splice(extra.idx + 1, 0, `${' '.repeat(childIndent)}${APPROVER_ROLES_KEY}: '${roles.join(',')}'`)
  }
  return { status: 'updated', yaml: lines.join(eol) }
}

// ── fleet sync (the writer) + posture (report only) ──────────────────────────

export type ApproverTarget = { name: string; dataDir: string }

export type ApproverSkipReason = 'no-env' | 'no-discord' | 'no-config' | Exclude<ApproverWriteStatus, 'updated' | 'unchanged'>

export type ApproverSyncResult = {
  updated: string[]
  unchanged: string[]
  skipped: { name: string; reason: ApproverSkipReason }[]
  failed: string[]
}

function discordConfig(t: ApproverTarget): { yaml: string; yamlPath: string } | ApproverSkipReason {
  let env: string
  try {
    env = fs.readFileSync(path.join(t.dataDir, '.env'), 'utf-8')
  } catch {
    return 'no-env'
  }
  if (!hasDiscordSurface(env)) return 'no-discord'
  const yamlPath = path.join(t.dataDir, 'config.yaml')
  try {
    return { yaml: fs.readFileSync(yamlPath, 'utf-8'), yamlPath }
  } catch {
    return 'no-config'
  }
}

/**
 * Write `roles` into every Discord agent's config.yaml. Never throws. Running
 * agents keep their old value until their next restart.
 */
export function syncDiscordApproverRoles(targets: ApproverTarget[], roles: readonly string[]): ApproverSyncResult {
  const result: ApproverSyncResult = { updated: [], unchanged: [], skipped: [], failed: [] }
  for (const t of targets) {
    try {
      const cfg = discordConfig(t)
      if (typeof cfg === 'string') {
        result.skipped.push({ name: t.name, reason: cfg })
        continue
      }
      const next = setApproverRolesYaml(cfg.yaml, roles)
      if (next.status === 'unchanged') result.unchanged.push(t.name)
      else if (next.status !== 'updated') result.skipped.push({ name: t.name, reason: next.status })
      else {
        // writeFileSync on an existing path keeps its mode.
        fs.writeFileSync(cfg.yamlPath, next.yaml)
        result.updated.push(t.name)
      }
    } catch (err) {
      result.failed.push(t.name)
      console.error(`[discord-approver-roles] failed for ${t.name}:`, err)
    }
  }
  return result
}

export type ApproverPostureRow = {
  name: string
  status: 'ok' | 'drift' | 'unmanaged' | ApproverSkipReason
  roles?: string[]
  /** require_admin_for_exec_approval is on — without it the buttons are open to every allowed user. */
  gateOn?: boolean
}

export type ApproverPosture = {
  desired: string[] | null
  drift: string[]
  agents: ApproverPostureRow[]
}

/** REPORT ONLY — each Discord agent's approver roles against the setting. */
export function discordApproverPosture(targets: ApproverTarget[], desired: readonly string[] | null): ApproverPosture {
  const agents: ApproverPostureRow[] = []
  for (const t of targets) {
    const cfg = discordConfig(t)
    if (typeof cfg === 'string') {
      if (cfg !== 'no-env' && cfg !== 'no-discord') agents.push({ name: t.name, status: cfg })
      continue
    }
    const gate = readYamlScalar(cfg.yaml, ['platforms', 'discord', 'extra', 'require_admin_for_exec_approval'])
    const gateOn = gate.found && (gate.value === true || String(gate.value).toLowerCase() === 'true')
    const { roles } = readApproverRoles(cfg.yaml)
    let status: ApproverPostureRow['status']
    if (desired === null) status = 'unmanaged'
    else {
      const w = setApproverRolesYaml(cfg.yaml, desired).status
      status = w === 'unchanged' ? 'ok' : w === 'updated' ? 'drift' : w
    }
    agents.push({ name: t.name, status, roles, gateOn })
  }
  return {
    desired: desired === null ? null : [...desired],
    drift: agents.filter((a) => a.status === 'drift').map((a) => a.name),
    agents,
  }
}
