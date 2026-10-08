// @vitest-environment node
//
// Invariants for the surface registry. These pin the derived maps against the
// literals they replaced (so the refactor is provably behavior-preserving) AND
// encode the structural rules that keep future edits sane — a new platform, or a
// new var, that violates a class rule fails here instead of shipping as drift.
import { describe, it, expect } from 'vitest'
import { SURFACES, SURFACE_SLUGS, isSurfaceSlug, surfaceSpec } from './registry'
import { isValidIdentity } from '../services/surface-admins'
import {
  USERS_VARS,
  GROUPS_VARS,
  CONNECT_CONFIG_KEYS,
  CONNECT_ENV_MAP,
  MENTION_GATING_VARS,
  OBSERVE_UNMENTIONED_VARS,
  GROUP_INVITE_POLICY_VARS,
  PLATFORM_VARS,
  POLICY_VARS,
  PLATFORM_ENV_KEYS,
  surfaceStripVars,
  ALL_SURFACE_VARS,
} from './derive'

// ── Golden: derived maps == the literals they replaced ───────────────────────
// If any of these fail, the registry changed a value a live consumer depends on.

describe('derived maps match the pre-registry literals (byte-for-byte)', () => {
  it('USERS_VARS == ALLOWED_USERS_VARS / allowedUsersKey / PLATFORM_VARS.users', () => {
    expect(USERS_VARS).toEqual({
      signal: 'SIGNAL_ALLOWED_USERS',
      telegram: 'TELEGRAM_ALLOWED_USERS',
      mattermost: 'MATTERMOST_ALLOWED_USERS',
      discord: 'DISCORD_ALLOWED_USERS',
      slack: 'SLACK_ALLOWED_USERS',
    })
  })

  it('GROUPS_VARS == GROUP_ALLOWED_VARS / GROUP_VARS', () => {
    expect(GROUPS_VARS).toEqual({
      signal: 'SIGNAL_GROUP_ALLOWED_USERS',
      telegram: 'TELEGRAM_GROUP_ALLOWED_CHATS',
      mattermost: 'MATTERMOST_ALLOWED_CHANNELS',
      discord: 'DISCORD_ALLOWED_CHANNELS',
      slack: 'SLACK_ALLOWED_CHANNELS',
    })
  })

  it('MENTION_GATING_VARS covers all five', () => {
    expect(MENTION_GATING_VARS).toEqual({
      signal: 'SIGNAL_REQUIRE_MENTION',
      telegram: 'TELEGRAM_REQUIRE_MENTION',
      mattermost: 'MATTERMOST_REQUIRE_MENTION',
      discord: 'DISCORD_REQUIRE_MENTION',
      slack: 'SLACK_REQUIRE_MENTION',
    })
  })

  it('OBSERVE_UNMENTIONED_VARS covers exactly signal/mattermost/telegram/slack/discord', () => {
    expect(OBSERVE_UNMENTIONED_VARS).toEqual({
      signal: 'SIGNAL_OBSERVE_UNMENTIONED',
      mattermost: 'MATTERMOST_OBSERVE_UNMENTIONED',
      telegram: 'TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES',
      slack: 'SLACK_OBSERVE_UNMENTIONED',
      discord: 'DISCORD_OBSERVE_UNMENTIONED',
    })
  })

  it('GROUP_INVITE_POLICY_VARS covers exactly signal/slack/telegram', () => {
    expect(GROUP_INVITE_POLICY_VARS).toEqual({
      signal: 'SIGNAL_GROUP_INVITE_POLICY',
      slack: 'SLACK_CHANNEL_POLICY',
      telegram: 'TELEGRAM_GROUP_INVITE_POLICY',
    })
  })

  it('PLATFORM_VARS matches the settings-route shape (Discord carries the extras)', () => {
    expect(PLATFORM_VARS).toEqual({
      signal: { users: 'SIGNAL_ALLOWED_USERS', groups: 'SIGNAL_GROUP_ALLOWED_USERS' },
      telegram: { users: 'TELEGRAM_ALLOWED_USERS', groups: 'TELEGRAM_GROUP_ALLOWED_CHATS' },
      mattermost: { users: 'MATTERMOST_ALLOWED_USERS', groups: 'MATTERMOST_ALLOWED_CHANNELS' },
      discord: {
        users: 'DISCORD_ALLOWED_USERS',
        groups: 'DISCORD_ALLOWED_CHANNELS',
        roles: 'DISCORD_ALLOWED_ROLES',
        ignoredGroups: 'DISCORD_IGNORED_CHANNELS',
        allowBots: 'DISCORD_ALLOW_BOTS',
      },
      slack: { users: 'SLACK_ALLOWED_USERS', groups: 'SLACK_ALLOWED_CHANNELS' },
    })
  })

  it('POLICY_VARS == env-helpers POLICY_VARS', () => {
    expect(POLICY_VARS).toEqual({
      signal: ['SIGNAL_ALLOWED_USERS', 'SIGNAL_GROUP_ALLOWED_USERS', 'SIGNAL_REQUIRE_MENTION'],
      telegram: ['TELEGRAM_ALLOWED_USERS', 'TELEGRAM_GROUP_ALLOWED_CHATS', 'TELEGRAM_REQUIRE_MENTION'],
      mattermost: ['MATTERMOST_ALLOWED_USERS', 'MATTERMOST_ALLOWED_CHANNELS', 'MATTERMOST_REQUIRE_MENTION'],
      discord: ['DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS', 'DISCORD_REQUIRE_MENTION'],
      slack: ['SLACK_ALLOWED_USERS', 'SLACK_ALLOWED_CHANNELS', 'SLACK_REQUIRE_MENTION'],
    })
  })

  it('PLATFORM_ENV_KEYS == disconnect strip list (the fixed, consistent one)', () => {
    // NB: mattermost includes MATTERMOST_ADMIN_USERS — matching the disconnect
    // route. The harness DUPLICATE path historically omitted it (drift D4); once
    // it derives from surfaceStripVars too, a clone stops inheriting the source's
    // Mattermost admins. That is an intended consistency fix, asserted below.
    expect(PLATFORM_ENV_KEYS).toEqual({
      signal: ['SIGNAL_ACCOUNT', 'SIGNAL_HTTP_URL', 'SIGNAL_ALLOWED_USERS', 'SIGNAL_GROUP_ALLOWED_USERS'],
      telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_GROUP_ALLOWED_CHATS'],
      mattermost: ['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_ALLOWED_USERS', 'MATTERMOST_ALLOWED_CHANNELS', 'MATTERMOST_ADMIN_USERS'],
      discord: ['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS', 'DISCORD_ALLOWED_ROLES', 'DISCORD_IGNORED_CHANNELS'],
      slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_ALLOWED_USERS', 'SLACK_ALLOWED_CHANNELS'],
    })
  })
})

// ── Structural invariants: the rules that keep a new platform honest ─────────

describe('registry structural invariants', () => {
  it('every surface has the mandatory admission + behavior primitives', () => {
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      expect(s.admission.users, `${p}.admission.users`).toBeTruthy()
      expect(s.admission.groups, `${p}.admission.groups`).toBeTruthy()
      expect(s.behavior.requireMention, `${p}.behavior.requireMention`).toBeTruthy()
    }
  })

  it('every var name is prefixed with its platform (Signal profile aside)', () => {
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      const prefix = p.toUpperCase()
      const all = [
        ...s.credentials,
        ...Object.values(s.admission),
        ...Object.values(s.behavior),
      ].filter(Boolean) as string[]
      for (const v of all) {
        expect(v.startsWith(prefix + '_'), `${v} should start with ${prefix}_`).toBe(true)
      }
    }
  })

  it('no var name is reused across two surfaces', () => {
    const seen = new Map<string, string>()
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      const all = [
        ...s.credentials,
        ...Object.values(s.admission),
        ...Object.values(s.behavior),
      ].filter(Boolean) as string[]
      for (const v of all) {
        expect(seen.has(v), `${v} declared on both ${seen.get(v)} and ${p}`).toBe(false)
        seen.set(v, p)
      }
    }
  })

  it('strip list = credentials + admission, and NEVER a behavior var', () => {
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      const strip = new Set(surfaceStripVars(p))
      for (const c of s.credentials) expect(strip.has(c)).toBe(true)
      for (const a of Object.values(s.admission)) if (a) expect(strip.has(a)).toBe(true)
      // Behavior vars are KEPT on disconnect — the load-bearing rule.
      for (const b of Object.values(s.behavior)) if (b) expect(strip.has(b)).toBe(false)
    }
  })

  it('ALL_SURFACE_VARS contains every declared var and nothing else', () => {
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      const all = [
        ...s.credentials,
        ...Object.values(s.admission),
        ...Object.values(s.behavior),
      ].filter(Boolean) as string[]
      for (const v of all) expect(ALL_SURFACE_VARS.has(v)).toBe(true)
    }
    // 36 distinct vars across five surfaces: the inventory's union of 34
    // (which predated DISCORD_CHANNEL_SCOPED_ACCESS) plus that flag, plus
    // DISCORD_BOTS_REQUIRE_INLINE_MENTION (org default 2026-08-05). NB the
    // first cut of this test said 34 — but by coincidence (it was missing
    // SIGNAL_PROFILE_NAME while adding the CSA flag). Count assertions must be
    // paired with membership assertions to mean anything:
    expect(ALL_SURFACE_VARS.has('SIGNAL_PROFILE_NAME')).toBe(true)
    expect(ALL_SURFACE_VARS.has('DISCORD_CHANNEL_SCOPED_ACCESS')).toBe(true)
    expect(ALL_SURFACE_VARS.has('DISCORD_BOTS_REQUIRE_INLINE_MENTION')).toBe(true)
    // +2: SLACK_OBSERVE_UNMENTIONED + DISCORD_OBSERVE_UNMENTIONED (observe parity)
    expect(ALL_SURFACE_VARS.has('SLACK_OBSERVE_UNMENTIONED')).toBe(true)
    expect(ALL_SURFACE_VARS.has('DISCORD_OBSERVE_UNMENTIONED')).toBe(true)
    // +1: DISCORD_THREAD_REQUIRE_MENTION (mention required in threads, 2026-10-06)
    expect(ALL_SURFACE_VARS.has('DISCORD_THREAD_REQUIRE_MENTION')).toBe(true)
    expect(SURFACES.discord.behavior.threadRequireMention).toBe('DISCORD_THREAD_REQUIRE_MENTION')
    // +1: DISCORD_ALLOWED_BOT_ROLES (bot-sender role gate, fleet setting)
    expect(ALL_SURFACE_VARS.has('DISCORD_ALLOWED_BOT_ROLES')).toBe(true)
    expect(ALL_SURFACE_VARS.size).toBe(40)
  })

  it('isSurfaceSlug / surfaceSpec agree with the SURFACES keys', () => {
    expect(SURFACE_SLUGS.sort()).toEqual(['discord', 'mattermost', 'signal', 'slack', 'telegram'])
    expect(isSurfaceSlug('discord')).toBe(true)
    expect(isSurfaceSlug('mastodon')).toBe(false)
    expect(surfaceSpec('discord')?.slug).toBe('discord')
    expect(surfaceSpec('nope')).toBeUndefined()
  })
})

// ── Identity-regex unification (drift D8 — resolved) ─────────────────────────
// The legacy sites that validated the "same" native id with their own bounds
// (surface-admins.isValidIdentity's per-platform switch, the resolvers' skip
// checks) now SOURCE registry.identity.nativePattern. These assertions pin the
// agreement: isValidIdentity must accept exactly what the canonical pattern
// accepts (modulo its structural guards), for every platform, so a registry
// edit is the only way to change what counts as a native id.

describe('identity-regex unification (D8): isValidIdentity == canonical pattern', () => {
  const samples: Record<string, { valid: string[]; invalid: string[] }> = {
    signal: {
      valid: ['+6421234567', '6421234567', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'],
      invalid: ['+123', 'aaaaaaaa-bbbb-cccc', '@handle'],
    },
    telegram: {
      valid: ['123456789', '-1001234567'],
      invalid: ['1'.repeat(21), '@juniper', '--1'],
    },
    mattermost: {
      valid: ['abcdefghijklmnopqrstuvwxyz'],
      invalid: ['abcdefghijklmnopqrstuvwxy', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    },
    discord: {
      valid: ['123456789012345', '123456789012345678', '123456789012345678901'],
      // '12345' is the load-bearing case: the old hand-rolled switch bound
      // (5–25) accepted it; the canonical 15–21 rejects it.
      invalid: ['12345', '1234567890123456789012', 'vincent'],
    },
    slack: {
      valid: ['U012ABCDEF', 'W012ABCDEF'],
      invalid: ['X012ABCDEF', 'u012abcdef'],
    },
  }

  it('accepts and rejects identically across every platform', () => {
    for (const p of SURFACE_SLUGS) {
      const pattern = SURFACES[p].identity.nativePattern
      for (const id of samples[p].valid) {
        expect(pattern.test(id), `${p} canonical should accept ${id}`).toBe(true)
        expect(isValidIdentity(p, id), `isValidIdentity(${p}) should accept ${id}`).toBe(true)
      }
      for (const id of samples[p].invalid) {
        expect(pattern.test(id), `${p} canonical should reject ${id}`).toBe(false)
        expect(isValidIdentity(p, id), `isValidIdentity(${p}) should reject ${id}`).toBe(false)
      }
    }
  })

  it('every platform has samples (a new surface must extend this table)', () => {
    expect(Object.keys(samples).sort()).toEqual([...SURFACE_SLUGS].sort())
  })

  it('unknown platform stays fail-closed (no spec → invalid)', () => {
    expect(isValidIdentity('whatsapp', '123456789012345678')).toBe(false)
  })

  it('no nativePattern carries flags (`.test` must be stateless: no `g`/`y`)', () => {
    for (const p of SURFACE_SLUGS) {
      expect(SURFACES[p].identity.nativePattern.flags, `${p} pattern flags`).toBe('')
    }
  })
})

// ── Connect wire protocol (CONNECT_ENV_MAP) ──────────────────────────────────
describe('connect wire map derives every credential var', () => {
  it('golden: wire map == the buildConnectEnvVars switch it replaced', () => {
    expect(CONNECT_ENV_MAP).toEqual({
      signal: [
        { envVar: 'SIGNAL_ACCOUNT', configKey: 'phone' },
        { envVar: 'SIGNAL_HTTP_URL', configKey: 'url', default: 'http://host.docker.internal:8080' },
        { envVar: 'SIGNAL_PROFILE_NAME', configKey: 'profileName', optional: true },
      ],
      telegram: [{ envVar: 'TELEGRAM_BOT_TOKEN', configKey: 'token' }],
      mattermost: [
        { envVar: 'MATTERMOST_URL', configKey: 'url' },
        { envVar: 'MATTERMOST_TOKEN', configKey: 'token' },
      ],
      discord: [{ envVar: 'DISCORD_BOT_TOKEN', configKey: 'token' }],
      slack: [
        { envVar: 'SLACK_BOT_TOKEN', configKey: 'botToken' },
        { envVar: 'SLACK_APP_TOKEN', configKey: 'appToken' },
      ],
    })
  })

  it('every credential var appears exactly once, as a non-optional entry', () => {
    for (const p of SURFACE_SLUGS) {
      const credentialEntries = CONNECT_ENV_MAP[p].filter((e) => !e.optional)
      expect(
        credentialEntries.map((e) => e.envVar),
        `${p} credential coverage`,
      ).toEqual(SURFACES[p].credentials)
    }
  })

  it('optional entries are behavior vars, never credentials or admission', () => {
    for (const p of SURFACE_SLUGS) {
      const s = SURFACES[p]
      const behaviorVars = Object.values(s.behavior)
      for (const e of CONNECT_ENV_MAP[p].filter((e) => e.optional)) {
        expect(behaviorVars, `${p} optional entry ${e.envVar}`).toContain(e.envVar)
        expect(ALL_SURFACE_VARS.has(e.envVar)).toBe(true)
      }
    }
  })

  it('wire keys are unique within each platform (payload keys cannot collide)', () => {
    for (const p of SURFACE_SLUGS) {
      const keys = CONNECT_ENV_MAP[p].map((e) => e.configKey)
      expect(new Set(keys).size, `${p} configKey collision`).toBe(keys.length)
    }
  })

  it('CONNECT_CONFIG_KEYS covers exactly the credential universe (no orphans)', () => {
    const allCredentials = SURFACE_SLUGS.flatMap((p) => SURFACES[p].credentials).sort()
    expect(Object.keys(CONNECT_CONFIG_KEYS).sort()).toEqual(allCredentials)
  })
})
