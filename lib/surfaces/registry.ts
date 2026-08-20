// lib/surfaces/registry.ts
//
// SINGLE SOURCE OF TRUTH for per-surface permission knowledge.
//
// Before this file, the same fact — "Discord's user allowlist is
// DISCORD_ALLOWED_USERS", "these vars get stripped on disconnect", "this is a
// behavioral preference, not an identity" — was restated in a dozen maps across
// the settings route, env-helpers, surface-admins, the policy route, the
// connect/disconnect routes and the deploy templates. They drifted: two creation
// paths seeded opposite Discord channel defaults; the duplicate-strip list
// omitted a Mattermost admin var the disconnect-strip list had; a var could be
// read in one place and never written in another.
//
// Every per-platform var-name map is now DERIVED from this registry (see
// ./derive.ts), and invariant tests (registry.test.ts) turn any future drift
// into a failing build instead of a silent incident.
//
// ── The permission model this encodes ────────────────────────────────────────
//
// Each surface's vars fall into three CLASSES, and the class decides lifecycle:
//
//   credentials  — connection secrets/config. Meaningless without the surface;
//                  STRIPPED on disconnect.
//   admission    — WHO the bot answers and WHERE (users, groups/channels, and on
//                  Discord roles + ignored channels). Identity-bound to the
//                  connected account/guild; STRIPPED on disconnect.
//   behavior     — HOW the bot responds (mention-gating, observe-unmentioned,
//                  bot-author policy, group-invite policy). Harmless without a
//                  token and NOT reseeded on reconnect, so KEPT on disconnect —
//                  stripping them silently changed agent behavior across a
//                  disconnect/reconnect cycle.
//
// "Admission" is deliberately distinct from "admin privilege". This file governs
// admission (the {P}_ALLOWED_USERS allowlist the runtime enforces). Admin
// privilege is the separate surfaceAdmins overlay, which merely BOOTSTRAPS from
// the admission allowlist until an explicit admin list is set. Conflating the two
// ("Admins" labeling the allowlist field) caused the silent-bot incident that
// motivated this registry. See
// memory/knowledge/decisions/2026-08-03-admission-vs-privilege-surface-permissions.md
// in nimbleco-egregore.

export type SurfaceSlug = 'signal' | 'telegram' | 'mattermost' | 'discord' | 'slack'

export type SurfaceSpec = {
  slug: SurfaceSlug
  label: string

  // Connection secrets/config. Stripped on disconnect. Order is the stored
  // order for the disconnect strip list.
  credentials: string[]

  // Who/where the bot answers. Stripped on disconnect (identity-bound).
  admission: {
    users: string // {P}_ALLOWED_USERS — every surface has one
    groups: string // group/channel allowlist — every surface has one
    roles?: string // Discord only — OR'd with the user allowlist
    ignoredGroups?: string // Discord only — deny beats allow
    adminUsers?: string // Mattermost only — surface-native admin list
  }

  // How the bot responds + presentation preferences. KEPT on disconnect
  // (behavioral, not identity — harmless without a token, and nothing reseeds
  // their values on reconnect).
  behavior: {
    requireMention: string // every surface has one
    observeUnmentioned?: string // signal / mattermost / telegram / slack / discord
    allowBots?: string // Discord only — tri-state, evaluated before the allowlist
    botsRequireInlineMention?: string // Discord only — bot senders must carry a literal inline @mention (reply-pings don't count)
    groupInvitePolicy?: string // signal / slack / telegram — who may add the bot
    channelScopedAccess?: string // Discord only — approved-channel admission
    profileName?: string // Signal only — display-name preference, re-applied on connect
  }

  // Native-identity shape for the users allowlist: a value already in this form
  // is a resolved id (skip username resolution). This is the CANONICAL pattern
  // and the ONLY one: surface-admins.isValidIdentity and the resolvers' skip
  // checks all source it (unification asserted in registry.test.ts). Signal is
  // the one nuance — phones match here but still resolve (sealed-sender UUID);
  // see isSignalUuid in lib/resolvers/index.ts.
  identity: {
    nativePattern: RegExp
    hasResolver: boolean // a username→native-id resolver exists in lib/resolvers
  }
}

export const SURFACES: Record<SurfaceSlug, SurfaceSpec> = {
  signal: {
    slug: 'signal',
    label: 'Signal',
    credentials: ['SIGNAL_ACCOUNT', 'SIGNAL_HTTP_URL'],
    admission: {
      users: 'SIGNAL_ALLOWED_USERS',
      groups: 'SIGNAL_GROUP_ALLOWED_USERS',
    },
    behavior: {
      requireMention: 'SIGNAL_REQUIRE_MENTION',
      observeUnmentioned: 'SIGNAL_OBSERVE_UNMENTIONED',
      groupInvitePolicy: 'SIGNAL_GROUP_INVITE_POLICY',
      // Deliberately NOT a credential: today's disconnect keeps it, and it is a
      // display preference the connect wizard re-applies, not an identity.
      profileName: 'SIGNAL_PROFILE_NAME',
    },
    identity: {
      // Phone (+64…) or a Signal UUID.
      nativePattern:
        /^(\+?[0-9]{5,20}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
      hasResolver: true,
    },
  },

  telegram: {
    slug: 'telegram',
    label: 'Telegram',
    credentials: ['TELEGRAM_BOT_TOKEN'],
    admission: {
      users: 'TELEGRAM_ALLOWED_USERS',
      // Telegram breaks the naming convention: GROUP_ALLOWED_CHATS, not
      // GROUP_ALLOWED_USERS/ALLOWED_CHANNELS. This is exactly why the registry
      // stores explicit names rather than templating `${P}_${ROLE}`.
      groups: 'TELEGRAM_GROUP_ALLOWED_CHATS',
    },
    behavior: {
      requireMention: 'TELEGRAM_REQUIRE_MENTION',
      observeUnmentioned: 'TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES',
      groupInvitePolicy: 'TELEGRAM_GROUP_INVITE_POLICY',
    },
    identity: {
      // Numeric user id (positive) or group id (negative).
      nativePattern: /^-?[0-9]{1,20}$/,
      hasResolver: true,
    },
  },

  mattermost: {
    slug: 'mattermost',
    label: 'Mattermost',
    credentials: ['MATTERMOST_URL', 'MATTERMOST_TOKEN'],
    admission: {
      users: 'MATTERMOST_ALLOWED_USERS',
      groups: 'MATTERMOST_ALLOWED_CHANNELS',
      adminUsers: 'MATTERMOST_ADMIN_USERS',
    },
    behavior: {
      requireMention: 'MATTERMOST_REQUIRE_MENTION',
      observeUnmentioned: 'MATTERMOST_OBSERVE_UNMENTIONED',
    },
    identity: {
      // 26-char base32-ish id.
      nativePattern: /^[a-z0-9]{26}$/,
      hasResolver: true,
    },
  },

  discord: {
    slug: 'discord',
    label: 'Discord',
    credentials: ['DISCORD_BOT_TOKEN'],
    admission: {
      users: 'DISCORD_ALLOWED_USERS',
      // Channel lists accept CATEGORY snowflakes too (hermes-agent-mt#160):
      // a category id matches every channel in that category, evaluated by
      // the adapter per message — channels created later are covered without
      // a re-render. ID-only; category names are never matched.
      groups: 'DISCORD_ALLOWED_CHANNELS',
      roles: 'DISCORD_ALLOWED_ROLES',
      ignoredGroups: 'DISCORD_IGNORED_CHANNELS',
    },
    behavior: {
      requireMention: 'DISCORD_REQUIRE_MENTION',
      observeUnmentioned: 'DISCORD_OBSERVE_UNMENTIONED',
      allowBots: 'DISCORD_ALLOW_BOTS',
      botsRequireInlineMention: 'DISCORD_BOTS_REQUIRE_INLINE_MENTION',
      channelScopedAccess: 'DISCORD_CHANNEL_SCOPED_ACCESS',
    },
    identity: {
      // Snowflake. Canonical bound 15–21 (real snowflakes are 17–20 + drift).
      nativePattern: /^[0-9]{15,21}$/,
      hasResolver: true,
    },
  },

  slack: {
    slug: 'slack',
    label: 'Slack',
    credentials: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    admission: {
      users: 'SLACK_ALLOWED_USERS',
      groups: 'SLACK_ALLOWED_CHANNELS',
    },
    behavior: {
      requireMention: 'SLACK_REQUIRE_MENTION',
      observeUnmentioned: 'SLACK_OBSERVE_UNMENTIONED',
      groupInvitePolicy: 'SLACK_CHANNEL_POLICY',
    },
    identity: {
      // User id like U012ABCDEF (or W… for enterprise).
      nativePattern: /^[UW][A-Z0-9]{6,20}$/,
      hasResolver: false,
    },
  },
}

export const SURFACE_SLUGS = Object.keys(SURFACES) as SurfaceSlug[]

export function isSurfaceSlug(value: string): value is SurfaceSlug {
  return Object.prototype.hasOwnProperty.call(SURFACES, value)
}

export function surfaceSpec(platform: string): SurfaceSpec | undefined {
  return isSurfaceSlug(platform) ? SURFACES[platform] : undefined
}
