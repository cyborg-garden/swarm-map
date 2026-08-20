# Surface permissions: the model and the rules

The single source of truth for per-surface permission knowledge is
[`lib/surfaces/registry.ts`](../lib/surfaces/registry.ts). This doc states the
model it encodes and the rules for changing it. The invariants are enforced by
`lib/surfaces/registry.test.ts` — drift is a failing build, not a convention.

## Admission vs privilege

Every surface has two distinct concepts. Conflating them (labeling the
allowlist "Admins") caused a real silent-bot incident:

- **Admission** — who the bot answers, and where. Declared in Swarm Map,
  rendered to `{PLATFORM}_ALLOWED_USERS` / group-allowlist vars in the agent
  `.env`, **enforced by the agent runtime**. On Discord admission is a union:
  user allowlist ∪ role allowlist ∪ pairing ∪ (opt-in,
  `DISCORD_CHANNEL_SCOPED_ACCESS`) anyone in an approved channel or its
  threads. Discord channel lists (`DISCORD_ALLOWED_CHANNELS`,
  `DISCORD_IGNORED_CHANNELS`, free-response) also accept **category**
  snowflakes: a category id matches every channel in the category, evaluated
  by the adapter at message time (hermes-agent-mt#160) — so a ring like
  "the Greenhouse" is one entry, and channels created inside it later are
  covered without a re-render. ID-only; category names are never matched.
- **Privilege** — who can approve gated tools (`is_platform_admin`). Lives in
  the `surfaceAdmins` overlay (`harnesses.json`), served live by
  `GET /api/harnesses/:id/surfaces/:platform/admins/:userId`. **Bootstrap
  rule:** until an explicit admin list is set, the overlay answers from the
  admission allowlist.

## The three var classes (lifecycle is decided by class, not per var)

| Class | Examples | On disconnect | On duplicate |
|---|---|---|---|
| `credentials` | bot tokens, `SIGNAL_ACCOUNT` | stripped | stripped |
| `admission` | allowlists, roles, ignored channels, `MATTERMOST_ADMIN_USERS` | stripped (identity-bound to the account/guild) | stripped |
| `behavior` | `*_REQUIRE_MENTION`, `DISCORD_ALLOW_BOTS`, invite policy, `DISCORD_CHANNEL_SCOPED_ACCESS`, `SIGNAL_PROFILE_NAME` | **kept** | **kept** |

Behavior vars are kept because nothing reseeds their *values* on reconnect —
stripping them silently changed agent behavior across a disconnect/reconnect
cycle.

## What lives in Swarm Map vs the surface

- **Swarm Map declares policy**: allowlists, channel approvals, flags, admin
  overlays — auditable, versioned (settings PUT uses an optimistic-concurrency
  token; stale writes 409), rendered to env.
- **Surfaces interpret natively**: the adapter evaluates role membership, guild
  scoping, thread parentage at message time. Swarm Map never calls a platform
  to judge a message. (Future role-managed control = Swarm Map declares which
  role ids count; the runtime evaluates membership.)
- **Identity lists store native ids.** Username entry is a UI convenience that
  must expand to native ids at write time via `lib/resolvers` (signal → UUID,
  telegram → numeric, discord → snowflake; authorization-grade matching:
  unique usernames only, ambiguity refuses).

## Rules for changes

1. **New var?** Add it to the registry with a class. Writing a surface var not
   in `ALL_SURFACE_VARS` should be treated as a bug.
2. **New platform?** One registry entry gives you: settings management, policy
   defaults, disconnect/duplicate stripping, admin bootstrap, and the invariant
   suite. UI labels/dialogs are the remaining manual sites (Phase 2).
3. **Never widen by omission.** Empty/absent semantics differ per platform
   (Discord empty channels = no gate; the `'0'` sentinel exists for deny-all).
   Registry comments are the record of these exceptions.
4. **API stability:** the plugin contract (`admins/:userId`, `groups/:groupId`
   GET shapes `{is_admin}`/`{allowed}`, status always 200; the ungated
   middleware exemptions; `adminUsers` compat field in settings GET; the
   README-published fleet API) is frozen. Everything UI-only may evolve.

## Known deferred items

- ~~`isValidIdentity` and the resolver skip-patterns use slightly different
  native-id bounds than `registry.identity.nativePattern`~~ — **done (Phase
  2b)**: every legacy site now sources the canonical pattern; the visible
  behavior change is Discord tightening from a loose 5–25-digit bound to the
  canonical 15–21 (real snowflakes are 17–20, so stored allowlists are
  unaffected). Unknown platforms stay fail-closed. Agreement is asserted in
  `registry.test.ts`.
- Connect-path `ensurePolicyDefaults` seeds `DISCORD_ALLOWED_CHANNELS=` (empty
  = no channel gate) while deploy seeds `'0'` (deny) — drift D1, a real
  fail-open on the connect path, tracked for its own fix (security behavior
  change, decided separately).
- The plugin calls the API with the bare agent slug while the admin overlay
  matches `h_<id>` exactly, so explicit admin lists are invisible to agents
  (fallback to bootstrap). Needs an id-normalization fix in
  `surface-admins.ts`.
