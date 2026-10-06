import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { buildSettingsEnvValue } from '@/lib/env-helpers'
import { resolveIdentifier, expandSignalAllowlist, expandTelegramAllowlist, expandDiscordAllowlist } from '@/lib/resolvers'
import {
  PLATFORM_VARS as DERIVED_PLATFORM_VARS,
  MENTION_GATING_VARS as DERIVED_MENTION_GATING_VARS,
  OBSERVE_UNMENTIONED_VARS as DERIVED_OBSERVE_UNMENTIONED_VARS,
  GROUP_INVITE_POLICY_VARS as DERIVED_GROUP_INVITE_POLICY_VARS,
  type PlatformVarNames as DerivedPlatformVarNames,
} from '@/lib/surfaces/derive'
import { services } from '@/lib/services'
import {
  DISCORD_THREAD_GATE_VAR,
  effectiveDiscordThreadGate,
  hasDiscordSurface,
  type ThreadGateSource,
} from '@/lib/services/discord-thread-gate'
import { adapterForRuntime } from '@/lib/services/harness'
import { isDeployBornCompose, validateExtraMounts, validateExtraEnv } from '@/lib/services/harness-compose'

function agentDataDir(harnessId: string): string {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  if (name === 'personal') return path.join(os.homedir(), '.hermes')
  return path.join(os.homedir(), `.hermes-${name}`)
}

// Value written to DISCORD_ALLOWED_CHANNELS to mean "no channel is approved".
// The Discord adapter treats an EMPTY allowlist as "no channel gate at all"
// (`if allowed_channels_raw:`), so empty cannot express a deny. A snowflake can
// never be "0", so this matches nothing and fails closed. Mapped back to an
// empty list on read so the console still shows "no channels approved".
const DISCORD_DENY_ALL_CHANNELS_SENTINEL = '0'

// Env var names that map to permission settings, per platform.
//
// `roles`, `ignoredGroups` and `allowBots` exist only for Discord today. They are
// not cosmetic extras: the adapter consults all three when deciding whether to
// execute a message, so a console that manages only `users`/`groups` cannot show
// — let alone control — who can actually command the agent.
//   - DISCORD_ALLOWED_ROLES  : OR'd with the user allowlist; the only
//                              "admin class" primitive the runtime has.
//   - DISCORD_IGNORED_CHANNELS: deny beats allow; the only channel restriction
//                              that binds a bot holding Administrator, since
//                              Administrator bypasses channel View overwrites.
//   - DISCORD_ALLOW_BOTS     : evaluated BEFORE the human allowlist and skips it
//                              entirely, so a permissive value is a fourth
//                              authorization class invisible to this console.
// Derived from the surface registry (lib/surfaces) — do not re-declare these
// maps here. registry.test.ts pins them against the former literals.
type PlatformVarNames = DerivedPlatformVarNames
const PLATFORM_VARS = DERIVED_PLATFORM_VARS

// DISCORD_ALLOW_BOTS is tri-state; anything else is rejected rather than coerced,
// because both other values skip the human allowlist.
const ALLOW_BOTS_VALUES = ['none', 'mentions', 'all'] as const
type AllowBotsValue = (typeof ALLOW_BOTS_VALUES)[number]

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
  if (!value || value === '*') return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

type SurfaceSettings = {
  allowedUsers: string[]
  adminUsers: string[]
  allowedGroups: string[]
  allowAll: boolean
  allowAllGroups: boolean
  // Discord-only (see PLATFORM_VARS). Absent for platforms that have no
  // equivalent, so clients can hide the controls rather than render dead ones.
  allowedRoles?: string[]
  ignoredGroups?: string[]
  allowBots?: AllowBotsValue
  // Read-only, GET→UI only. True when DISCORD_ALLOWED_CHANNELS is absent/empty,
  // which the runtime treats as "respond in every channel". PUT must ignore it:
  // writing it back as '*' would be a genuine widening (see the GET comment).
  groupsUnscoped?: boolean
}

// Env var names for group invite policy per platform. The single "group invite
// policy" UI toggle is written to every platform's var in the PUT write-loop, so
// each connected surface honors the same approved-only/allow-all choice. Slack's
// runtime reads SLACK_CHANNEL_POLICY (approved-only = empty SLACK_ALLOWED_CHANNELS
// means NO channels approved; allow-all = empty means respond everywhere).
// Telegram's var is enforced by the group-approval POST endpoint
// (surfaces/[platform]/groups/[groupId]) that the swarm_map_policy plugin calls.
// All three derived from the surface registry (lib/surfaces). GROUP_INVITE and
// OBSERVE_UNMENTIONED cover only the surfaces that have the var.
const GROUP_INVITE_VARS = DERIVED_GROUP_INVITE_POLICY_VARS
const MENTION_GATING_VARS = DERIVED_MENTION_GATING_VARS
const OBSERVE_UNMENTIONED_VARS = DERIVED_OBSERVE_UNMENTIONED_VARS

// Global env vars for policy settings
const COMMAND_APPROVAL_VAR = 'HERMES_APPROVAL_ADMIN_ONLY'
const DM_POLICY_VAR = 'HERMES_DM_POLICY'
const VPN_ENABLED_VAR = 'VPN_ENABLED'
const CAPSOLVER_KEY_VAR = 'CAPSOLVER_API_KEY'
const VNC_EXTERNAL_URL_VAR = 'VNC_EXTERNAL_URL'

type SettingsResponse = {
  dmPolicy: 'approved-only' | 'allow-all'
  groupInvitePolicy: 'approved-only' | 'allow-all'
  mentionGating: boolean
  // Observe unmentioned messages: agent ingests channel context it isn't
  // @mentioned in (does NOT respond — orthogonal to mentionGating). Default on.
  observeUnmentioned: boolean
  commandApprovalAdminOnly: boolean
  memoryScope: 'channel' | 'global'
  vpnEnabled: boolean
  capsolverConfigured: boolean
  // Per-harness compose resource limits. These are NOT env vars — they live in
  // the compose deploy.resources.limits, so they persist on the harness record
  // (harnesses.json) and regenerate the compose, not the .env.
  resources?: { memory?: string; cpus?: string }
  surfaces: Record<string, SurfaceSettings>
  // Optimistic-concurrency token: the .env mtime as GET observed it. Clients
  // round-trip it in PUT; a mismatch means someone else wrote settings since
  // this snapshot was loaded and the PUT is rejected with 409 instead of
  // silently reverting their change (the lost-update bug — see
  // docs/audits/hsm-settings-lost-update.md in nimbleco-egregore). Optional on
  // PUT so hand-built callers keep working; both UI clients send it.
  version?: string
  // Read-only in GET: whether DISCORD_CHANNEL_SCOPED_ACCESS is enabled on the
  // agent. Env-managed; the PUT loop never writes it.
  discordChannelScopedAccess?: boolean
  // Discord agents only: whether @mention is required inside threads the bot
  // has joined (DISCORD_THREAD_REQUIRE_MENTION). GET reports the EFFECTIVE
  // value the adapter will apply (config.yaml layers included) and which layer
  // decided it. PUT writes the .env var only when the value differs from what
  // GET would report — an echo never pins an implicit value. Separate from
  // `mentionGating`, whose global toggle never touches it.
  discordThreadMentionGating?: boolean
  discordThreadMentionSource?: ThreadGateSource // read-only
}

// The thread gate as the adapter will apply it. Reads config.yaml because two
// of the four layers live there (and one of them outranks .env).
function readDiscordThreadGate(dataDir: string, envContent: string) {
  let configYaml: string | null = null
  try { configYaml = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf-8') } catch {}
  return effectiveDiscordThreadGate({ env: envContent, configYaml })
}

// Version token for optimistic concurrency: covers BOTH stores this route
// writes — the .env (mtime; string-typed because mtimeMs is a float and JSON
// round-trips of floats invite precision surprises) and the harness overlay's
// `resources` (normalized value fingerprint, since harnesses.json has no
// per-harness mtime). Any concurrent settings write moves one of the two
// components, so a stale tab 409s instead of silently reverting it.
function settingsVersion(envPath: string, id: string): string {
  const resources = services.harness.get(id)?.resources
  const fingerprint = JSON.stringify({
    memory: resources?.memory ?? null,
    cpus: resources?.cpus ?? null,
  })
  return `${String(fs.statSync(envPath).mtimeMs)}:${fingerprint}`
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const dataDir = agentDataDir(id)
  const envPath = path.join(dataDir, '.env')

  if (!fs.existsSync(envPath)) {
    return NextResponse.json({ error: 'Agent .env not found' }, { status: 404 })
  }

  const env = parseEnvFile(envPath)
  const surfaces: Record<string, SurfaceSettings> = {}

  for (const [platform, vars] of Object.entries(PLATFORM_VARS)) {
    const usersRaw = env[vars.users]
    const groupsRaw = env[vars.groups]

    const allowAll = usersRaw === '*'
    const allowAllGroups = groupsRaw === '*'

    // Discord-only: an ABSENT/empty channel allowlist is "respond everywhere" in the
    // on_message and slash gates. Report it as its OWN read-only field —
    // deliberately NOT folded into allowAllGroups.
    //
    // Empty and '*' are NOT the same runtime state, and conflating them is a
    // fail-open: `_discord_channel_ids_allowed` returns False on empty but True on
    // '*', and `_is_allowed_user` uses it as the channel bypass for agents with no
    // user/role allowlist. Since both clients PUT back the document GET returned,
    // reporting an empty allowlist as allowAllGroups would materialize a literal '*'
    // and turn a fail-closed agent into one every guild member can command.
    const groupsUnscoped = platform === 'discord' && !groupsRaw
    const groups = platform === 'discord' && groupsRaw === DISCORD_DENY_ALL_CHANNELS_SENTINEL
      ? []
      : parseCommaList(groupsRaw)

    const users = parseCommaList(usersRaw)
    surfaces[platform] = {
      allowedUsers: users,
      adminUsers: users,  // backward compat — old plugins read this field
      allowedGroups: groups,
      allowAll,
      allowAllGroups,
    }

    if (groupsUnscoped) {
      // Read-only: PUT ignores this. It exists so the UI can say "responds in every
      // channel" without that state being echoed back as a literal '*'.
      surfaces[platform].groupsUnscoped = true
    }
    if (vars.roles) {
      surfaces[platform].allowedRoles = parseCommaList(env[vars.roles])
    }
    if (vars.ignoredGroups) {
      // NOT parseCommaList: that maps '*' to [], and '*' here is a guild-wide mute
      // honored by both the on_message and slash gates — the only kill switch that
      // binds a bot holding Administrator. Dropping it on read would erase it on
      // the next save.
      surfaces[platform].ignoredGroups = (env[vars.ignoredGroups] || '')
        .split(',').map(s => s.trim()).filter(Boolean)
    }
    if (vars.allowBots) {
      const raw = (env[vars.allowBots] || '').trim().toLowerCase()
      // Absent really is 'none' (the adapter's os.getenv default). But an
      // unrecognized value is NOT: the adapter compares against 'none' then
      // 'mentions' and lets everything else fall through to the permissive branch,
      // so report a typo as the permissive state rather than flattering it to 'none'.
      surfaces[platform].allowBots = raw === ''
        ? 'none'
        : (ALLOW_BOTS_VALUES as readonly string[]).includes(raw)
          ? (raw as AllowBotsValue)
          : 'all'
    }
  }

  // Read group invite policy back from the per-platform env vars. HSM writes the
  // single UI toggle to every var in GROUP_INVITE_VARS from the same value, so
  // they normally agree. They can only disagree on a hand-edited or older .env
  // (e.g. SIGNAL_GROUP_INVITE_POLICY present but SLACK_CHANNEL_POLICY absent).
  // In that case prefer the secure reading: report 'approved-only' if EITHER var
  // explicitly says approved-only, and only report 'allow-all' when a var says
  // allow-all AND none says approved-only. Default (no vars set) is approved-only.
  let groupInvitePolicy: 'approved-only' | 'allow-all' = 'approved-only'
  let sawApprovedOnly = false
  let sawAllowAll = false
  for (const varName of Object.values(GROUP_INVITE_VARS)) {
    const val = env[varName]
    if (val === 'approved-only') sawApprovedOnly = true
    else if (val === 'allow-all') sawAllowAll = true
  }
  if (sawAllowAll && !sawApprovedOnly) groupInvitePolicy = 'allow-all'

  // Read mention-gating from the .env the way the runtime resolves that env var,
  // so the UI can't claim "@mention only" while the agent answers everything. The
  // runtime (gateway/platforms/signal.py) gates only when the value is explicitly
  // truthy; an empty or absent value reads as false there. An empty value (KEY=)
  // is the exact gap that let a legacy agent respond to every message while this
  // showed as on — so treat anything that isn't truthy as not-gated, not just
  // 'false'. (Note: a YAML `require_mention` in the agent's gateway config
  // outranks the env var at runtime; this reads only the .env, so a YAML override
  // is not reflected here. Env-var/.env is HSM's source of truth for these.)
  const MENTION_TRUTHY = new Set(['true', '1', 'yes', 'on'])
  let mentionGating = false
  for (const varName of Object.values(MENTION_GATING_VARS)) {
    const val = env[varName]
    if (val !== undefined && MENTION_TRUTHY.has(val.trim().toLowerCase())) {
      mentionGating = true
      break
    }
  }

  // Observe unmentioned — default ON (matches the deploy template, which writes
  // the observe vars true at provision). Off only if an observe var is present
  // and explicitly falsy. Orthogonal to mentionGating (this is input/context;
  // that is the response gate). Surfaces whose adapter lacks the flag simply
  // have no var written, so they don't drag the aggregate off.
  const OBSERVE_TRUTHY = new Set(['true', '1', 'yes', 'on'])
  let observeUnmentioned = true
  for (const varName of Object.values(OBSERVE_UNMENTIONED_VARS)) {
    const val = env[varName]
    if (val !== undefined && !OBSERVE_TRUTHY.has(val.trim().toLowerCase())) {
      observeUnmentioned = false
      break
    }
  }

  // Read command approval setting — default true (admin-only) unless explicitly 'false'
  const commandApprovalAdminOnly = env[COMMAND_APPROVAL_VAR] !== 'false'

  // Memory scope — default 'channel' (per-chat isolation)
  const memoryScope: 'channel' | 'global' = env['HERMES_MEMORY_SCOPE'] === 'global' ? 'global' : 'channel'

  // DM policy — stored as its own env var, not derived from per-platform wildcards
  const dmPolicy: 'approved-only' | 'allow-all' = env[DM_POLICY_VAR] === 'allow-all' ? 'allow-all' : 'approved-only'

  // Enrich with resolved identities
  const resolvedPath = path.join(dataDir, 'resolved-identities.json')
  let resolvedIdentities: Record<string, Array<{ display: string; nativeId: string; profileName?: string }>> = {}
  try {
    resolvedIdentities = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'))
  } catch {}

  for (const [platform, surf] of Object.entries(surfaces)) {
    const resolved = resolvedIdentities[platform]
    if (resolved?.length) {
      // Display data only — carried in the separate resolvedUsers field. The
      // native IDs are deliberately NOT merged into allowedUsers anymore: both
      // UI clients PUT the whole document back, so a merged read meant every
      // GET→PUT round-trip rewrote the on-disk allowlist with values the
      // operator never typed (the read-side half of the lost-update bug).
      // GET must return the .env values as they are.
      (surf as any).resolvedUsers = resolved
    }
  }

  // VPN + CapSolver status
  const vpnEnabled = env[VPN_ENABLED_VAR] === 'true'
  const capsolverConfigured = !!env[CAPSOLVER_KEY_VAR]

  // Per-harness resource limits — persisted on the harness overlay (not env).
  const resources = services.harness.get(id)?.resources

  const response: SettingsResponse = {
    dmPolicy,
    groupInvitePolicy,
    mentionGating,
    observeUnmentioned,
    commandApprovalAdminOnly,
    memoryScope,
    vpnEnabled,
    capsolverConfigured,
    resources,
    surfaces,
    version: settingsVersion(envPath, id),
  }

  {
    const envContent = fs.readFileSync(envPath, 'utf-8')
    if (hasDiscordSurface(envContent)) {
      const gate = readDiscordThreadGate(dataDir, envContent)
      response.discordThreadMentionGating = gate.requireMention
      response.discordThreadMentionSource = gate.source
    }
  }

  // Read-only surfacing of the channel-scoped access posture (set via env, not
  // managed by this route — the PUT loop must never rewrite it).
  if (env['DISCORD_CHANNEL_SCOPED_ACCESS'] !== undefined) {
    response.discordChannelScopedAccess =
      ['true', '1', 'yes'].includes((env['DISCORD_CHANNEL_SCOPED_ACCESS'] || '').trim().toLowerCase())
  }

  return NextResponse.json(response)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const dataDir = agentDataDir(id)
  const envPath = path.join(dataDir, '.env')

  if (!fs.existsSync(envPath)) {
    return NextResponse.json({ error: 'Agent .env not found' }, { status: 404 })
  }

  const body = await request.json() as SettingsResponse

  // Optimistic concurrency: reject a write based on a stale snapshot. Without
  // this, PUT is a whole-document replace and the last writer silently reverts
  // everyone else's changes — including security policy (who may talk to an
  // agent). The token is optional so scripted callers without one keep
  // working; both UI clients send it and re-fetch on 409.
  if (body.version !== undefined) {
    const currentVersion = settingsVersion(envPath, id)
    if (body.version !== currentVersion) {
      return NextResponse.json(
        {
          error: 'Settings changed since you loaded them — reload and re-apply your edit.',
          currentVersion,
        },
        { status: 409 },
      )
    }
  }

  // Pre-write validation of the agent's persisted extraMounts/extraEnv (#222).
  //
  // Those fields are rendered into the compose ~450 lines below, and
  // renderExtraMounts/renderExtraEnv THROW on a malformed entry. By the time
  // the render runs, the .env and the resources overlay have already been
  // written — so a bad mount produced a 500 on top of partial state, AND every
  // subsequent settings PUT for that agent threw at the same line, leaving the
  // agent unreconfigurable through the API until someone hand-edited
  // harnesses.json. Same invariant the #204 guard states further down: refuse
  // BEFORE writing anything, so the refusal leaves no partial state.
  //
  // Unconditional, not gated on "would we regenerate?": a mount config that
  // cannot render is broken whether or not this particular request happens to
  // trip the regeneration branch, and 400-with-nothing-written is strictly
  // better than 500-with-half-written. There is no UI for these fields, so the
  // message has to name the file an operator must go fix.
  {
    const configured = services.harness.get(id)
    const problem =
      validateExtraMounts(configured?.extraMounts) ?? validateExtraEnv(configured?.extraEnv)
    if (problem) {
      return NextResponse.json(
        {
          error:
            "This agent's saved extra mounts/env cannot be rendered into a compose file, "
            + 'so no settings can be saved until they are fixed: ' + problem
            + '. Edit the agent entry in harnesses.json (there is no console field for these yet).',
        },
        { status: 400 },
      )
    }
  }

  // Validate the Discord authorization fields before touching the .env. Both
  // failure modes here are silent AND fail-open at runtime, so reject rather
  // than sanitize:
  //   - the adapter keeps only `.isdigit()` role entries, so a role NAME is
  //     dropped with no log; if that empties the role set on an agent with no
  //     user allowlist, the channel-scope bypass admits everyone who can see
  //     the channel.
  //   - an unrecognized DISCORD_ALLOW_BOTS is not 'none': the adapter compares
  //     against 'none' first, so a typo lands in the permissive branch.
  // Validation applies only to entries the operator is INTRODUCING. Values already
  // on disk are grandfathered: GET emits them, both clients PUT the whole document
  // back, and rejecting them would make the settings page permanently unsaveable
  // for every platform — with no console path to repair the offending value.
  const existingEnv = parseEnvFile(envPath)
  const alreadyOnDisk = (varName: string | undefined): Set<string> =>
    new Set(
      (varName ? existingEnv[varName] || '' : '')
        .split(',').map(s => s.trim()).filter(Boolean),
    )

  const discordIn = body.surfaces?.discord
  if (discordIn) {
    const knownRoles = alreadyOnDisk(PLATFORM_VARS.discord.roles)
    const badRoles = (discordIn.allowedRoles ?? [])
      .filter(r => !knownRoles.has(String(r).trim()))
      .filter(r => !/^\d+$/.test(String(r).trim()))
    if (badRoles.length > 0) {
      return NextResponse.json(
        {
          error: 'Discord roles must be numeric role IDs, not names. '
            + 'The agent silently drops non-numeric entries, which can leave the bot ungated. '
            + `Rejected: ${badRoles.join(', ')}`,
        },
        { status: 400 },
      )
    }
    // Channels are NOT numeric-only. `_discord_channel_keys_from_channel` builds the
    // gate key set from the snowflake, the bare name AND '#name', and both gates
    // intersect against it — configuring by name is supported and documented in the
    // adapter. Internal spaces are legal too (voice, stage, forum and category names
    // allow them, and the adapter matches the name verbatim). So reject only what
    // would corrupt the file or the list format: a comma splits one entry into two,
    // a newline injects a whole extra KEY=value line.
    const knownChannels = new Set([
      ...alreadyOnDisk(PLATFORM_VARS.discord.groups),
      ...alreadyOnDisk(PLATFORM_VARS.discord.ignoredGroups),
    ])
    const badChannels = [
      ...(discordIn.allowedGroups ?? []),
      ...(discordIn.ignoredGroups ?? []),
    ]
      .filter(c => !knownChannels.has(String(c).trim()))
      .filter(c => {
        const v = String(c).trim()
        // `\s#` is not cosmetic: this file is consumed as a compose `env_file`, and
        // Docker treats whitespace-then-# as an inline comment, so `mute #2` reaches
        // the container as `mute`. Verified against the compose CLI. On
        // DISCORD_IGNORED_CHANNELS that silently un-mutes the channel the operator
        // muted — a fail-open on the one deny that binds a bot holding Administrator
        // — while HSM's own parseEnvFile does no comment handling and would keep
        // displaying the full value. Bare `#name` and internal spaces stay legal.
        return v === '' || /[,\r\n]/.test(v) || /\s#/.test(v)
      })
    if (badChannels.length > 0) {
      return NextResponse.json(
        {
          error: 'Discord channels must be a snowflake ID, a channel name, or #name — '
            + 'with no commas, no newlines, and no space before a "#" (Docker reads '
            + `that as a comment and truncates the value). Rejected: ${badChannels.join(' | ')}`,
        },
        { status: 400 },
      )
    }
    if (
      discordIn.allowBots !== undefined
      && !(ALLOW_BOTS_VALUES as readonly string[]).includes(discordIn.allowBots)
    ) {
      return NextResponse.json(
        { error: `allowBots must be one of: ${ALLOW_BOTS_VALUES.join(', ')}` },
        { status: 400 },
      )
    }
  }

  let content = fs.readFileSync(envPath, 'utf-8')
  // Snapshot token for the pre-write recheck below. Taken immediately after
  // the read (both sync, so no in-process interleaving between them).
  const snapshotVersion = settingsVersion(envPath, id)
  // Kept for the no-op detection at the end: a PUT whose rendered .env is
  // byte-identical must not rewrite the file (bumping the version token for
  // nothing) and must not recreate the container (which kills in-flight work).
  const originalContent = content

  // Telegram allowlist as written to the env — captured so the policy-plane
  // admin overlay (SurfaceAdminService) can be synced after the env write.
  let telegramAllowlist: string[] | undefined

  for (const [platform, vars] of Object.entries(PLATFORM_VARS)) {
    // Optional-chained: a policy-only body legitimately has no `surfaces` key
    // at all. Bare indexing here was the crash in the 2026-07-28 error log
    // ("Cannot read properties of undefined (reading 'signal')") — and that
    // hand-built PUT had already mutated state before dying.
    const settings = body.surfaces?.[platform]
    if (!settings) continue

    // Users — empty string = no one allowed (secure default), * = allow all.
    // For Signal, expand phone numbers to also include their resolved UUID:
    // sealed-sender DMs identify the sender only by UUID, so a phone-only
    // allowlist silently rejects them (see expandSignalAllowlist).
    let allowedUsers = settings.allowedUsers
    if (platform === 'signal' && allowedUsers.length > 0) {
      allowedUsers = await expandSignalAllowlist(id, allowedUsers)
    }
    // For Discord, expand usernames to also include their resolved snowflake —
    // the runtime resolves usernames itself at on_ready, but the HSM policy
    // plane (surface-admins bootstrap → is_platform_admin) reads this env var
    // raw, so a username-only entry is an admin the policy plane can never
    // recognize (see expandDiscordAllowlist).
    if (platform === 'discord' && allowedUsers.length > 0) {
      allowedUsers = await expandDiscordAllowlist(id, allowedUsers)
    }
    // For Telegram, expand @usernames to also include their resolved numeric
    // ID — the gateway matches numeric sender IDs verbatim, so an
    // @username-only entry never matches anyone (see expandTelegramAllowlist).
    if (platform === 'telegram') {
      if (allowedUsers.length > 0) {
        allowedUsers = await expandTelegramAllowlist(id, allowedUsers)
      }
      // Only converge the admin overlay against a concrete allowlist. An
      // allow-all/empty policy writes '*' or '' here — syncing that would
      // silently wipe an explicitly-configured admin roster because of an
      // unrelated DM-policy toggle.
      if (allowedUsers.length > 0) {
        telegramAllowlist = allowedUsers
      }
    }
    const usersValue = buildSettingsEnvValue(body.dmPolicy, settings.allowAll, allowedUsers)
    const usersRegex = new RegExp(`^${vars.users}=.*$`, 'm')
    if (usersRegex.test(content)) {
      content = content.replace(usersRegex, () => `${vars.users}=${usersValue}`)
    } else {
      content = content.trimEnd() + `\n${vars.users}=${usersValue}\n`
    }

    // Groups — explicit list takes priority, then allowAllGroups → *, else empty.
    //
    // Discord inverts the meaning of empty: the adapter gates on
    // `if allowed_channels_raw:` and an empty DISCORD_ALLOWED_CHANNELS skips the
    // channel check entirely, so "no channels approved" in this console meant
    // "respond in EVERY channel" at runtime — the exact opposite of what an
    // operator clearing the list intends, and the opposite of what
    // env-helpers' "empty = no one allowed" comment promises. Discord has no
    // *_CHANNEL_POLICY var (Slack does), so the only runtime-effective way to
    // express "nowhere" is a value that no channel can match: channel ids are
    // snowflakes, never DISCORD_DENY_ALL_CHANNELS_SENTINEL.
    // Trim before joining so the written value matches what validation inspected.
    const trimmedGroups = settings.allowedGroups.map(g => String(g).trim()).filter(Boolean)
    let groupsValue = trimmedGroups.length > 0
      ? trimmedGroups.join(',')
      : settings.allowAllGroups ? '*' : ''
    // Only turn a CLEARED list into the deny sentinel, and decide that from DISK,
    // never from the request. Two reasons:
    //
    //  - An agent that was ALREADY unscoped must not be silently taken offline in
    //    every channel by a save of some unrelated setting. It also keeps
    //    `config.yaml`'s `discord.allowed_channels` fallback alive: the adapter
    //    applies it only when the env var is FALSY (`if ac is not None and not
    //    os.getenv(...)`), so writing the truthy sentinel would suppress a
    //    YAML-scoped agent's config and deny it everywhere.
    //  - The `groupsUnscoped` field GET emits cannot be trusted for this: neither
    //    client refetches after a save, so an operator who scopes an agent and then
    //    clears it again in the same page session would still be echoing
    //    groupsUnscoped:true — suppressing the sentinel and leaving the agent
    //    answering everywhere while the console shows "no channels approved".
    //
    // Reading the previous value off disk makes the invariant structural rather than
    // a contract with the client.
    if (
      platform === 'discord'
      && groupsValue === ''
      && !!existingEnv[vars.groups]
    ) {
      groupsValue = DISCORD_DENY_ALL_CHANNELS_SENTINEL
    }
    const groupsRegex = new RegExp(`^${vars.groups}=.*$`, 'm')
    if (groupsRegex.test(content)) {
      // Callback form: a literal '$&' / '$\'' in a channel name would otherwise
      // splice surrounding file content (including tokens) into the value.
      content = content.replace(groupsRegex, () => `${vars.groups}=${groupsValue}`)
    } else {
      content = content.trimEnd() + `\n${vars.groups}=${groupsValue}\n`
    }

    // Discord authorization vars. Each is written ONLY when the client sent the
    // field, so an older client that doesn't know about them leaves a
    // hand-configured value intact instead of blanking it — these are exactly the
    // settings an operator sets by hand today.
    const writeVar = (varName: string, value: string) => {
      const regex = new RegExp(`^${varName}=.*$`, 'm')
      content = regex.test(content)
        ? content.replace(regex, () => `${varName}=${value}`)
        : content.trimEnd() + `\n${varName}=${value}\n`
    }

    // Trim every entry before joining. Validation inspects `String(c).trim()`, so an
    // untrimmed write can smuggle past it: ` #b` validates as `#b` (legal) but lands
    // in the file as `a, #b`, and Docker reads whitespace-then-# as an inline comment
    // — the container receives `a,` and the muted channel is silently unmuted.
    const joinTrimmed = (values: string[]) =>
      values.map(v => String(v).trim()).filter(Boolean).join(',')

    if (vars.roles && settings.allowedRoles !== undefined) {
      writeVar(vars.roles, joinTrimmed(settings.allowedRoles))
    }
    if (vars.ignoredGroups && settings.ignoredGroups !== undefined) {
      writeVar(vars.ignoredGroups, joinTrimmed(settings.ignoredGroups))
    }
    if (vars.allowBots && settings.allowBots !== undefined) {
      writeVar(vars.allowBots, settings.allowBots)
    }
  }

  // Group invite policy — write per-platform env vars
  const groupInviteValue = body.groupInvitePolicy || 'approved-only'
  for (const [, varName] of Object.entries(GROUP_INVITE_VARS)) {
    const regex = new RegExp(`^${varName}=.*$`, 'm')
    if (regex.test(content)) {
      content = content.replace(regex, `${varName}=${groupInviteValue}`)
    } else {
      content = content.trimEnd() + `\n${varName}=${groupInviteValue}\n`
    }
  }

  // Mention-gating — write per-platform env vars
  const mentionGatingValue = body.mentionGating !== false ? 'true' : 'false'
  for (const [, varName] of Object.entries(MENTION_GATING_VARS)) {
    const regex = new RegExp(`^${varName}=.*$`, 'm')
    if (regex.test(content)) {
      content = content.replace(regex, `${varName}=${mentionGatingValue}`)
    } else {
      content = content.trimEnd() + `\n${varName}=${mentionGatingValue}\n`
    }
  }

  // Discord thread gate — written only on a real change. GET reports the
  // effective value (yaml layers included); both clients PUT the document back,
  // so writing on every save would turn an implicit yaml `false` into an
  // explicit .env opt-out that the fleet heal must then respect forever.
  if (typeof body.discordThreadMentionGating === 'boolean' && hasDiscordSurface(content)) {
    const current = readDiscordThreadGate(dataDir, content).requireMention
    if (body.discordThreadMentionGating !== current) {
      const v = body.discordThreadMentionGating ? 'true' : 'false'
      const regex = new RegExp(`^${DISCORD_THREAD_GATE_VAR}=.*$`, 'm')
      content = regex.test(content)
        ? content.replace(regex, `${DISCORD_THREAD_GATE_VAR}=${v}`)
        : content.trimEnd() + `\n${DISCORD_THREAD_GATE_VAR}=${v}\n`
    }
  }

  // Observe-unmentioned — first-class, ORTHOGONAL to mention-gating: the agent
  // ingests unmentioned channel messages as context (it still does not respond;
  // the mention gate governs the response). Default ON. Previously this was
  // coupled to mentionGating (observe=off whenever responding-to-everything),
  // which conflated input with output — decoupled here.
  const observeValue = body.observeUnmentioned !== false ? 'true' : 'false'
  for (const [, varName] of Object.entries(OBSERVE_UNMENTIONED_VARS)) {
    const regex = new RegExp(`^${varName}=.*$`, 'm')
    if (regex.test(content)) {
      content = content.replace(regex, `${varName}=${observeValue}`)
    } else {
      content = content.trimEnd() + `\n${varName}=${observeValue}\n`
    }
  }

  // Command approval — write global env var
  const commandApprovalValue = body.commandApprovalAdminOnly !== false ? 'true' : 'false'
  const commandApprovalRegex = new RegExp(`^${COMMAND_APPROVAL_VAR}=.*$`, 'm')
  if (commandApprovalRegex.test(content)) {
    content = content.replace(commandApprovalRegex, `${COMMAND_APPROVAL_VAR}=${commandApprovalValue}`)
  } else {
    content = content.trimEnd() + `\n${COMMAND_APPROVAL_VAR}=${commandApprovalValue}\n`
  }

  // DM policy — stored as its own env var so it persists correctly
  const dmPolicyValue = body.dmPolicy || 'approved-only'
  const dmPolicyRegex = new RegExp(`^${DM_POLICY_VAR}=.*$`, 'm')
  if (dmPolicyRegex.test(content)) {
    content = content.replace(dmPolicyRegex, `${DM_POLICY_VAR}=${dmPolicyValue}`)
  } else {
    content = content.trimEnd() + `\n${DM_POLICY_VAR}=${dmPolicyValue}\n`
  }

  // Memory scope
  const memoryScopeValue = body.memoryScope === 'global' ? 'global' : 'channel'
  const memoryScopeRegex = /^HERMES_MEMORY_SCOPE=.*$/m
  if (memoryScopeRegex.test(content)) {
    content = content.replace(memoryScopeRegex, `HERMES_MEMORY_SCOPE=${memoryScopeValue}`)
  } else {
    content = content.trimEnd() + `\nHERMES_MEMORY_SCOPE=${memoryScopeValue}\n`
  }

  // Did the VPN toggle actually CHANGE? GET always emits vpnEnabled and both
  // clients PUT the whole document back, so `vpnEnabled !== undefined` is true on
  // every save — including a permissions-only edit — which made compose
  // regeneration below unconditional. Compare against the .env instead, mirroring
  // how `resourcesChanged` is derived.
  const vpnWasEnabled = /^VPN_ENABLED=true$/m.test(content)
  const vpnChanged = (body as any).vpnEnabled !== undefined
    && !!(body as any).vpnEnabled !== vpnWasEnabled

  // VPN toggle + externally-reachable VNC URL for human CAPTCHA escalation
  if ((body as any).vpnEnabled !== undefined) {
    const vpnEnabled = !!(body as any).vpnEnabled
    const vpnValue = vpnEnabled ? 'true' : 'false'
    const vpnRegex = new RegExp(`^${VPN_ENABLED_VAR}=.*$`, 'm')
    if (vpnRegex.test(content)) {
      content = content.replace(vpnRegex, `${VPN_ENABLED_VAR}=${vpnValue}`)
    } else {
      content = content.trimEnd() + `\n${VPN_ENABLED_VAR}=${vpnValue}\n`
    }

    // The captcha plugin DMs this URL to a human. Port = agent port + 2000
    // (see harness-compose); host = the configured VNC bind host (loopback by
    // default — set settings.vncBindHost to a Tailscale address for remote
    // escalation). Cleared when VPN is disabled.
    const vncBindHost = services.config.getSettings().vncBindHost || '127.0.0.1'
    const harness = services.harness.get(id)
    let vncExternalUrl = ''
    if (vpnEnabled && harness?.composeFile && fs.existsSync(harness.composeFile)) {
      const existingCompose = fs.readFileSync(harness.composeFile, 'utf-8')
      const portMatch = existingCompose.match(/published:\s*(\d+)/)
      const port = portMatch ? parseInt(portMatch[1], 10) : 8642
      vncExternalUrl = `http://${vncBindHost}:${port + 2000}`
    }
    const vncRegex = new RegExp(`^${VNC_EXTERNAL_URL_VAR}=.*$`, 'm')
    if (vncRegex.test(content)) {
      content = content.replace(vncRegex, `${VNC_EXTERNAL_URL_VAR}=${vncExternalUrl}`)
    } else if (vncExternalUrl) {
      content = content.trimEnd() + `\n${VNC_EXTERNAL_URL_VAR}=${vncExternalUrl}\n`
    }
  }

  // #204 PR2 guard: a VPN/resources change regenerates the compose from the
  // STANDALONE template below — on a deploy-born compose (read_only/tmpfs/
  // google-MCP hardening from generateAgentCompose) that regeneration silently
  // strips the extras. Refuse BEFORE writing anything, so a 409 leaves no
  // partial state.
  {
    const resourcesWouldChange = body.resources !== undefined && (() => {
      const norm = (r?: { memory?: string; cpus?: string }) => `${r?.memory ?? ''}|${r?.cpus ?? ''}`
      return norm(services.harness.get(id)?.resources) !== norm(body.resources)
    })()
    if (vpnChanged || resourcesWouldChange) {
      const harness = services.harness.get(id)
      if (harness?.composeFile && fs.existsSync(harness.composeFile)) {
        const existingCompose = fs.readFileSync(harness.composeFile, 'utf-8')
        if (isDeployBornCompose(existingCompose)) {
          return NextResponse.json(
            {
              error:
                'This agent has a deploy-born compose (read_only/tmpfs/google-MCP hardening). ' +
                'Regenerating it for VPN/resource changes would silently strip that hardening — ' +
                'not supported on this harness yet. Edit the compose file directly if needed.',
            },
            { status: 409 },
          )
        }
      }
    }
  }

  const envUnchanged = content === originalContent
  if (!envUnchanged) {
    // Pre-write recheck: the 409 at the top of the handler races the async
    // allowlist resolvers (Signal RPC has a 15s timeout) — another PUT can
    // land while this one is awaiting, and this handler would then write from
    // a stale snapshot with no conflict detected. Everything from this stat to
    // the write is synchronous, so in a single-process Node server the recheck
    // closes that in-handler window completely. Applies to version-less
    // scripted callers too — a mid-flight overwrite is a conflict regardless
    // of whether the caller opted into tokens.
    if (settingsVersion(envPath, id) !== snapshotVersion) {
      return NextResponse.json(
        {
          error: 'Settings changed while this save was in flight — reload and re-apply your edit.',
          currentVersion: settingsVersion(envPath, id),
        },
        { status: 409 },
      )
    }
    fs.writeFileSync(envPath, content, { mode: 0o600 })
  }

  // Keep the policy-plane admin overlay converged with the Telegram allowlist
  // just written — the two admin stores must never diverge. Non-numeric entries
  // (raw @handles) are dropped by the sync's validation, never stored.
  if (telegramAllowlist !== undefined) {
    try {
      services.surfaceAdmins.syncFromAllowlist(id, 'telegram', telegramAllowlist)
    } catch {}
  }

  // Per-harness resource limits (compose deploy.resources.limits — NOT env vars).
  // Persist on the harness overlay and detect a change so the compose is only
  // regenerated when needed.
  let resourcesChanged = false
  if (body.resources !== undefined) {
    const norm = (r?: { memory?: string; cpus?: string }) => `${r?.memory ?? ''}|${r?.cpus ?? ''}`
    const prev = services.harness.get(id)?.resources
    resourcesChanged = norm(prev) !== norm(body.resources)
    if (resourcesChanged) {
      try { services.harness.updateConfig(id, { resources: body.resources }) } catch {}
    }
  }

  // Regenerate the compose file when the VPN toggle OR the resource limits change.
  // Both are compose-level (not env), so the .env rewrite above doesn't cover them.
  if (vpnChanged || resourcesChanged) {
    const harness = services.harness.get(id)
    if (harness?.composeFile && fs.existsSync(harness.composeFile)) {
      // Read current port from existing compose file
      const existingCompose = fs.readFileSync(harness.composeFile, 'utf-8')
      const portMatch = existingCompose.match(/published:\s*(\d+)/)
      const port = portMatch ? parseInt(portMatch[1], 10) : 8642

      // VPN state for the regenerated compose: use the toggle if it's in this
      // request, otherwise preserve the current state (from the .env we just wrote).
      const vpnForCompose = (body as any).vpnEnabled !== undefined
        ? !!(body as any).vpnEnabled
        : /^VPN_ENABLED=true$/m.test(content)

      // Resource limits for the regenerated compose: the request value if present,
      // otherwise the persisted overlay value (so a VPN-only change keeps limits).
      const effectiveResources = body.resources ?? harness.resources

      const settings = services.config.getSettings()
      const imageOrBuild = settings.useLocalBuild && settings.hermesDir
        ? (() => {
            const resolved = settings.hermesDir!.replace(/^~/, os.homedir())
            try {
              if (fs.existsSync(path.join(resolved, 'Dockerfile'))) {
                return { build: resolved }
              }
            } catch {}
            return undefined
          })()
        : undefined

      const compose = adapterForRuntime(harness.runtime).generateCompose(harness.name, port, dataDir, {
        vpnEnabled: vpnForCompose,
        imageOrBuild,
        defaultImage: settings.defaultImage,
        vncBindHost: settings.vncBindHost,
        controlBindHost: settings.controlBindHost,
        memory: effectiveResources?.memory,
        cpus: effectiveResources?.cpus,
        // Carried through every regeneration. Dropping these here is exactly
        // the bug extraMounts exists to prevent: the container comes back
        // healthy with a capability silently missing.
        extraMounts: harness.extraMounts,
        extraEnv: harness.extraEnv,
      })
      fs.writeFileSync(harness.composeFile, compose, 'utf-8')
    }
  }

  // Resolve identifiers to native IDs (best-effort). Only when the body
  // actually carried surfaces: a policy-only PUT (e.g. the Settings tab, which
  // has no surface controls and omits `surfaces` entirely) must not regenerate
  // the file from nothing — that would wipe every platform's display data.
  if (body.surfaces !== undefined) {
    const resolvedMap: Record<string, Array<{ display: string; nativeId: string; profileName?: string }>> = {}
    for (const [platform, settings] of Object.entries(body.surfaces || {})) {
      if (!settings?.allowedUsers?.length) continue
      const resolved: Array<{ display: string; nativeId: string; profileName?: string }> = []
      for (const identifier of settings.allowedUsers) {
        const result = await resolveIdentifier(id, platform, identifier)
        if (result) {
          resolved.push(result)
        } else {
          resolved.push({ display: identifier, nativeId: identifier })
        }
      }
      resolvedMap[platform] = resolved
    }
    const resolvedPath = path.join(dataDir, 'resolved-identities.json')
    try {
      fs.writeFileSync(resolvedPath, JSON.stringify(resolvedMap, null, 2), { mode: 0o600 })
    } catch {}
  }

  // Recreate the container so the updated .env (and, for VPN changes, the
  // regenerated compose) actually loads. env_file is read at container creation,
  // not on a plain restart — without this, settings changes silently no-op until
  // the next manual rebuild.
  //
  // Return restarted:true so the UI can drive its "restarting…/saved" state from
  // this flag instead of firing a second POST /restart. A second restart hits the
  // recreate's restart-lock and returns 409 "restart already in progress", which
  // the old UI surfaced as "restart failed — restart manually".
  // …but skip the recreate entirely when nothing that requires one changed:
  // identical .env and no VPN/resource change means the running container is
  // already in the desired state, and a recreate would only destroy in-flight
  // work. (This alone would have prevented the destroyed-run incidents — see
  // docs/audits/hsm-settings-lost-update.md in nimbleco-egregore.)
  let restarted = false
  if (!envUnchanged || vpnChanged || resourcesChanged) {
    try { services.harness.restart(id, 'recreate'); restarted = true } catch {}
  }

  return NextResponse.json({
    success: true,
    restarted,
    unchanged: envUnchanged && !vpnChanged && !resourcesChanged,
    // Fresh token so clients can keep editing without a refetch.
    version: settingsVersion(envPath, id),
  })
}
