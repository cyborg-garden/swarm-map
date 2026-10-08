import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Harness } from '@/lib/types'
import type { Storage } from './storage'
import type { AuditService } from './audit'
import { SURFACE_SLUGS as REGISTRY_SLUGS, isSurfaceSlug, surfaceSpec } from '@/lib/surfaces/registry'
import {
  USERS_VARS as DERIVED_USERS_VARS,
  GROUPS_VARS as DERIVED_GROUPS_VARS,
  GROUP_INVITE_POLICY_VARS as DERIVED_GROUP_INVITE_POLICY_VARS,
} from '@/lib/surfaces/derive'

const HARNESSES_FILE = 'harnesses.json'

// Per-platform DM-allowlist env var. This is the BOOTSTRAP admin set: when a
// surface has no explicit admin list, its admins default to whoever is in the
// DM allowlist (the "_is_approval_admin" / approved-user convention). Keeping
// this as the default is what guarantees no regression — an agent with no role
// config behaves exactly as it did before this store existed.
// All derived from the surface registry (lib/surfaces). These used to be three
// hand-maintained maps; GROUP_INVITE_POLICY_VARS in particular carried a "must
// stay in step with the settings route" comment because it was a second copy.
const ALLOWED_USERS_VARS = DERIVED_USERS_VARS
const GROUP_ALLOWED_VARS = DERIVED_GROUPS_VARS
const GROUP_INVITE_POLICY_VARS = DERIVED_GROUP_INVITE_POLICY_VARS

export const SUPPORTED_SURFACES: string[] = [...REGISTRY_SLUGS]

export function isSupportedSurface(platform: string): boolean {
  return isSurfaceSlug(platform)
}

// Resolve an agent's data dir from its harness id — same convention the settings
// and policy routes use (hermes-personal lives at ~/.hermes, others at
// ~/.hermes-<name>).
export function agentDataDir(harnessId: string): string {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  if (name === 'personal') return path.join(os.homedir(), '.hermes')
  return path.join(os.homedir(), `.hermes-${name}`)
}

// Validate a native identity key before it enters the store. This is auth
// surface: reject anything that could break comma-list matching, inject into
// storage, or smuggle control characters. We do NOT accept '*' as an admin
// identity — a wildcard admin is never a legitimate explicit entry.
export function isValidIdentity(platform: string, raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const id = raw.trim()
  if (!id || id.length > 128) return false
  // Structural: no separators/whitespace/control chars that would corrupt the
  // stored list or the exact-match compare the plugin performs.
  if (/[\s,;=\n\r\t]/.test(id)) return false
  if (id === '*') return false
  // Shape check: the CANONICAL native-id pattern from the surface registry
  // (registry.identity.nativePattern) — this used to be a hand-maintained
  // per-platform switch whose Discord bound had drifted loose (5–25 digits vs
  // the canonical 15–21; drift D8, now unified). An unknown platform has no
  // spec and is invalid — fail-closed, exactly like the old switch default.
  return surfaceSpec(platform)?.identity.nativePattern.test(id) ?? false
}

function parseEnvFile(envPath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key) result[key] = value
    }
  } catch {}
  return result
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

export type AdminSource = 'explicit' | 'allowlist'

export type AdminList = {
  platform: string
  admins: string[]
  source: AdminSource
  // True when the DM allowlist is a wildcard ('*'). A wildcard means "anyone may
  // DM me", NOT "everyone is an admin" — so it yields ZERO default admins
  // (fail-closed). Surfaced so the UI can explain why the admin set is empty.
  allowAllDm: boolean
}

/**
 * Per-harness, per-surface admin/role store — the policy plane the
 * swarm_map_policy plugin already queries but that had no server side (its
 * GET .../admins/{user_id} route 404'd, failing is_admin closed for everyone).
 *
 * Explicit admin lists live on the harness overlay (harnesses.json) so they are
 * HSM-side policy served live — no container recreate. When a surface has no
 * explicit list, admins default to that surface's DM allowlist read from the
 * agent .env (no regression).
 *
 * Security posture:
 * - isAdmin fails closed: unknown user / unreadable store / unsupported surface
 *   / wildcard allowlist → NOT admin.
 * - Mutations are transport-gated: root proxy.ts (PR #139) requires a
 *   valid operator-session cookie on every PUT/POST/PATCH/DELETE, and agent
 *   containers cannot obtain that cookie. That is the security boundary.
 * - setAdmins additionally checks `actor` against the CURRENT admin set
 *   (explicit, or bootstrap = DM allowlist). This is defense-in-depth plus
 *   semantic authz — it records/verifies WHICH surface identity performed the
 *   change and still blocks self-escalation if the transport gate is ever
 *   disabled (kill-switch) — and identities are validated before they enter
 *   the store.
 */
export class SurfaceAdminService {
  constructor(
    private storage: Storage,
    private audit?: AuditService,
  ) {}

  // Read the raw persisted overlays directly (NOT via HarnessService.list(),
  // which shells out to Docker discovery — far too heavy for the per-message
  // is-admin hot path).
  private readOverlays(): Partial<Harness>[] {
    return this.storage.read<Partial<Harness>[]>(HARNESSES_FILE, [])
  }

  // Agents call the policy API with their bare slug (HERMES_AGENT_NAME, e.g.
  // "seraph-doer") while harnesses.json ids are "h_seraph_doer". agentDataDir()
  // already tolerates both, but the overlay lookup matched by exact id — so an
  // agent-side call silently missed every EXPLICIT admin list and fell back to
  // the allowlist bootstrap. Normalize before matching.
  private canonicalHarnessId(idOrSlug: string): string {
    return idOrSlug.startsWith('h_') ? idOrSlug : `h_${idOrSlug.replace(/-/g, '_')}`
  }

  private explicitAdmins(harnessId: string, platform: string): string[] | undefined {
    const canonical = this.canonicalHarnessId(harnessId)
    const overlay = this.readOverlays().find((h) => h.id === canonical)
    const list = overlay?.surfaceAdmins?.[platform]
    return Array.isArray(list) ? list : undefined
  }

  // The bootstrap admin set: the surface's DM allowlist from the agent .env.
  private allowlistAdmins(harnessId: string, platform: string): { admins: string[]; allowAllDm: boolean } {
    const varName = ALLOWED_USERS_VARS[platform]
    if (!varName) return { admins: [], allowAllDm: false }
    const env = parseEnvFile(path.join(agentDataDir(harnessId), '.env'))
    const raw = env[varName]
    if (raw === '*') return { admins: [], allowAllDm: true }
    return { admins: parseCommaList(raw), allowAllDm: false }
  }

  /**
   * Resolve the effective admin list for a surface: the explicit list if one is
   * set, otherwise the DM-allowlist bootstrap set.
   */
  listAdmins(harnessId: string, platform: string): AdminList {
    if (!isSupportedSurface(platform)) {
      return { platform, admins: [], source: 'allowlist', allowAllDm: false }
    }
    const explicit = this.explicitAdmins(harnessId, platform)
    if (explicit !== undefined) {
      return { platform, admins: [...explicit], source: 'explicit', allowAllDm: false }
    }
    const { admins, allowAllDm } = this.allowlistAdmins(harnessId, platform)
    return { platform, admins, source: 'allowlist', allowAllDm }
  }

  /**
   * Is `userId` an admin on `platform` for this harness? Fail-closed on every
   * unknown/malformed/unsupported input. A wildcard DM allowlist does NOT make
   * everyone an admin.
   */
  isAdmin(harnessId: string, platform: string, userId: string): boolean {
    if (!harnessId || !platform || !userId) return false
    if (!isSupportedSurface(platform)) return false
    const target = userId.trim()
    if (!target) return false
    try {
      return this.listAdmins(harnessId, platform).admins.includes(target)
    } catch {
      return false
    }
  }

  /**
   * Replace the explicit admin list for a surface.
   *
   * Transport authorization happens BEFORE this code runs: the operator-cookie
   * middleware (proxy.ts, PR #139) gates every mutating /api request, so
   * only a logged-in dashboard operator can reach this at all.
   *
   * Actor check (defense-in-depth + semantic attribution): `actor` must ALREADY
   * be an admin for this surface — either in the current explicit list, or,
   * before any explicit list exists, in the DM allowlist (the bootstrap set).
   * This ties the change to a concrete surface identity for the audit log and
   * keeps self-escalation blocked even if the transport gate is disabled via
   * its kill-switch (HSM_OPERATOR_TOKEN unset).
   *
   * Returns a discriminated result rather than throwing so the route can map it
   * to the right HTTP status.
   */
  setAdmins(
    harnessId: string,
    platform: string,
    admins: unknown,
    actor: string,
  ):
    | { ok: true; admins: string[] }
    | { ok: false; status: 400 | 403; error: string } {
    if (!isSupportedSurface(platform)) {
      return { ok: false, status: 400, error: `Unsupported platform: ${platform}` }
    }
    if (!Array.isArray(admins)) {
      return { ok: false, status: 400, error: 'admins must be an array' }
    }
    if (typeof actor !== 'string' || !actor.trim()) {
      return { ok: false, status: 400, error: 'actor is required' }
    }
    // Authorize BEFORE validating the new list, so the endpoint never reveals
    // anything to an unauthorized caller.
    if (!this.isAdmin(harnessId, platform, actor.trim())) {
      return { ok: false, status: 403, error: 'actor is not an admin for this surface' }
    }
    // Validate + dedupe every identity.
    const cleaned: string[] = []
    const seen = new Set<string>()
    for (const entry of admins) {
      if (!isValidIdentity(platform, entry)) {
        return { ok: false, status: 400, error: `Invalid ${platform} identity: ${String(entry)}` }
      }
      const id = (entry as string).trim()
      if (!seen.has(id)) {
        seen.add(id)
        cleaned.push(id)
      }
    }

    // Persist onto the harness overlay (read-modify-write the raw array — the
    // single persisted shape; HarnessService tolerates partial overlays).
    const overlays = this.readOverlays()
    const idx = overlays.findIndex((h) => h.id === this.canonicalHarnessId(harnessId))
    if (idx !== -1) {
      const existing = overlays[idx].surfaceAdmins ?? {}
      overlays[idx] = { ...overlays[idx], surfaceAdmins: { ...existing, [platform]: cleaned } }
    } else {
      overlays.push({ id: harnessId, surfaceAdmins: { [platform]: cleaned } })
    }
    this.storage.write(HARNESSES_FILE, overlays)

    this.audit?.append({
      who: actor.trim(),
      what: `surface-admins:set:${platform}`,
      target: harnessId,
      meta: { count: cleaned.length },
    })

    return { ok: true, admins: cleaned }
  }

  /**
   * Keep the explicit admin overlay converged with the surface's DM allowlist
   * after an OPERATOR write to the ALLOWED_USERS env var (surface connect or
   * settings PUT).
   *
   * Why: the two admin stores can diverge — the overlay is HSM-side policy
   * served live, while ALLOWED_USERS is the bootstrap set. If an operator
   * rewrites the allowlist while a stale explicit overlay exists, the policy
   * plane keeps answering from the stale list. This replaces the explicit list
   * with the valid identities from the new allowlist — but ONLY when an
   * explicit list already exists. With no explicit list, listAdmins already
   * reads the allowlist live (bootstrap default), so there is nothing to sync
   * and writing one would change the setAdmins bootstrap-actor semantics.
   *
   * No actor check: this is not a surface-identity mutation — it runs inside
   * operator-transport-gated routes (proxy.ts) as a side effect of the env
   * write the operator just made. Invalid entries (wildcards, unresolved
   * @handles) are dropped, never stored.
   */
  syncFromAllowlist(harnessId: string, platform: string, allowlist: string[]): void {
    if (!isSupportedSurface(platform)) return
    const overlays = this.readOverlays()
    const idx = overlays.findIndex((h) => h.id === this.canonicalHarnessId(harnessId))
    const existing = idx !== -1 ? overlays[idx].surfaceAdmins?.[platform] : undefined
    if (!Array.isArray(existing)) return // no explicit list → bootstrap default already tracks the env

    const cleaned: string[] = []
    const seen = new Set<string>()
    for (const entry of allowlist) {
      if (!isValidIdentity(platform, entry)) continue
      const id = entry.trim()
      if (!seen.has(id)) {
        seen.add(id)
        cleaned.push(id)
      }
    }

    overlays[idx] = {
      ...overlays[idx],
      surfaceAdmins: { ...overlays[idx].surfaceAdmins, [platform]: cleaned },
    }
    this.storage.write(HARNESSES_FILE, overlays)

    this.audit?.append({
      who: 'operator',
      what: `surface-admins:sync:${platform}`,
      target: harnessId,
      meta: { count: cleaned.length },
    })
  }

  /**
   * Is `groupId` allowed on `platform` for this harness? Mirrors the existing
   * /policy?action=group-check logic, exposed at the REST path the plugin's
   * is_group_allowed() calls. Fail-closed; wildcard '*' means all groups.
   */
  isGroupAllowed(harnessId: string, platform: string, groupId: string): boolean {
    if (!harnessId || !platform || !groupId) return false
    const varName = GROUP_ALLOWED_VARS[platform]
    if (!varName) return false
    try {
      const env = parseEnvFile(path.join(agentDataDir(harnessId), '.env'))
      const raw = env[varName]
      if (raw === '*') return true
      return parseCommaList(raw).includes(groupId.trim())
    } catch {
      return false
    }
  }

  /**
   * Group-invite enforcement for the swarm_map_policy plugin: the agent was
   * just added to `groupId` by `addedByUserId` — approve or reject the invite.
   *
   * - Policy 'allow-all': anyone may add the agent → approved; the group is
   *   appended to the allowlist so the agent actually responds there.
   * - Policy 'approved-only' (or unset — the secure default): approved only
   *   when `addedByUserId` is an admin (isAdmin, fail-closed), in which case
   *   the group is appended to the allowlist.
   * - A '*' allowlist or an already-listed group approves without a write
   *   (updated: false — no container recreate needed).
   *
   * `groupId` is structurally validated before it touches the .env (same
   * injection guard rationale as isValidIdentity — a comma/newline in the value
   * would corrupt the allowlist or inject env lines).
   *
   * The caller (route) recreates the container when `updated` is true, matching
   * every other env-writing route.
   */
  approveGroupInvite(
    harnessId: string,
    platform: string,
    groupId: string,
    addedByUserId: string,
  ):
    | { ok: true; approved: true; updated: boolean }
    | { ok: true; approved: false; reason: string }
    | { ok: false; status: 400; error: string } {
    const varName = GROUP_ALLOWED_VARS[platform]
    if (!varName) {
      return { ok: false, status: 400, error: `Unsupported platform: ${platform}` }
    }
    // Structural guard before the value touches the .env: no whitespace/control
    // chars (line injection), no comma (list separator), no comment/quote chars,
    // no '$'/backtick (String.replace replacement patterns + shell expansion).
    // '=' is deliberately allowed — Signal group IDs are base64 ('=' padding),
    // and only the FIRST '=' on a line splits key from value.
    const group = typeof groupId === 'string' ? groupId.trim() : ''
    if (!group || group.length > 128 || group === '*' || /[\s,;#'"$`]/.test(group)) {
      return { ok: false, status: 400, error: 'Invalid group id' }
    }
    const actor = typeof addedByUserId === 'string' ? addedByUserId.trim() : ''
    if (!actor || actor.length > 128) {
      return { ok: false, status: 400, error: 'addedByUserId is required (max 128 chars)' }
    }

    const envPath = path.join(agentDataDir(harnessId), '.env')
    if (!fs.existsSync(envPath)) {
      return { ok: false, status: 400, error: 'Agent .env not found' }
    }
    const env = parseEnvFile(envPath)

    // Unset defaults to approved-only — the secure default everywhere else.
    const policyVar = GROUP_INVITE_POLICY_VARS[platform]
    const policy = policyVar ? env[policyVar] : undefined
    if (policy !== 'allow-all' && !this.isAdmin(harnessId, platform, actor)) {
      return {
        ok: true,
        approved: false,
        reason: 'group invite policy is approved-only and the inviting user is not an admin',
      }
    }

    const raw = env[varName]
    if (raw === '*' || parseCommaList(raw).includes(group)) {
      return { ok: true, approved: true, updated: false }
    }

    // Append the group to the allowlist line (create it if absent).
    const value = [...parseCommaList(raw), group].join(',')
    let content = fs.readFileSync(envPath, 'utf-8')
    const regex = new RegExp(`^${varName}=.*$`, 'm')
    if (regex.test(content)) {
      // Replacer function: the value must be inserted literally — a bare string
      // here would expand `$&`/`` $` ``-style replacement patterns and splice
      // surrounding .env content into the line.
      content = content.replace(regex, () => `${varName}=${value}`)
    } else {
      content = content.trimEnd() + `\n${varName}=${value}\n`
    }
    fs.writeFileSync(envPath, content, { mode: 0o600 })

    this.audit?.append({
      who: actor,
      what: `surface-groups:approve:${platform}`,
      target: harnessId,
      meta: { groupId: group },
    })

    return { ok: true, approved: true, updated: true }
  }
}
