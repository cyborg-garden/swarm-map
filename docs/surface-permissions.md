# Surface permissions: the model and the rules

Everything Swarm Map knows about a chat surface's permission vars lives in one file,
[`lib/surfaces/registry.ts`](../lib/surfaces/registry.ts). This doc states the
model it encodes and the rules for changing it.
`lib/surfaces/registry.test.ts` enforces the invariants, so drift fails the build.

This page covers Hermes agents. Door agents keep their rules in their own record; see
[the first door agent in the dashboard](lab/dashboard-slice.md).

## Admission vs privilege

Every surface has two separate concepts. Keep them apart: an allowlist labeled
"Admins" once left a bot silent for the people it was meant to answer.

- **Admission** is who the bot answers, and where. Swarm Map declares it and
  renders it to `{PLATFORM}_ALLOWED_USERS` and the group allowlist vars in the
  agent's `.env`. **The agent runtime enforces it.** On Discord admission is a
  union of the user allowlist, the role allowlist, pairing, and (opt-in, with
  `DISCORD_CHANNEL_SCOPED_ACCESS`) anyone in an approved channel or its
  threads. Discord channel lists (`DISCORD_ALLOWED_CHANNELS`,
  `DISCORD_IGNORED_CHANNELS`, free-response) also accept **category**
  snowflakes. A category id matches every channel in the category, and the
  adapter checks it per message (hermes-agent-mt#160). So a category like
  "Members" is one entry, and channels created inside it later are covered
  without a re-render. Ids only: category names are never matched.
- **Privilege** is who can approve gated tools (`is_platform_admin`). It lives in
  the `surfaceAdmins` overlay (`harnesses.json`) and is served live by
  `GET /api/harnesses/:id/surfaces/:platform/admins/:userId`. That route takes
  the agent's id (`h_<name>`) or its bare name, which is what the policy plugin
  sends as `HERMES_AGENT_NAME`. **Bootstrap rule:** until an explicit admin list
  is set, the overlay answers from the admission allowlist.

- **DMs.** On Discord, `DISCORD_DM_ALLOWED_USERS` (hermes-agent-mt#200) narrows
  DMs on top of admission. Unset or empty means nobody; `*` turns the gate off.
  New agents start closed. A first connect seeds it from explicit admins, or the
  admins named at connect, never from the whole allowlist. Later connects leave
  it, and every other Discord or Signal list, exactly as they are. An explicit
  admin change moves it, and recreates the container, only if it equalled the
  previous explicit admins. Empty counts as equal when there were none, so a
  chosen first list opens a closed agent, unless that list is just the
  allowlist, which also holds channel users. Otherwise it stays, and the
  response says so. The response also warns about a listed admin the allowlist
  would refuse. Allowlist edits and settings saves never touch it, and Swarm Map
  never writes `*`.
  On Signal, `SIGNAL_ALLOWED_USERS` is the DM list. New agents start with it set
  to their admins, or `0` (nobody), because the adapter reads unset as `*` and
  empty as open mode. Admin changes do not rewrite it, because it can hold DM
  users who are not admins.

## The three var classes (lifecycle is decided by class, not per var)

| Class | Examples | On disconnect | On duplicate |
|---|---|---|---|
| `credentials` | bot tokens, `SIGNAL_ACCOUNT` | stripped | stripped |
| `admission` | allowlists, roles, ignored channels, `MATTERMOST_ADMIN_USERS`, `DISCORD_DM_ALLOWED_USERS` | stripped (tied to the account or guild) | stripped |
| `behavior` | `*_REQUIRE_MENTION`, `DISCORD_ALLOW_BOTS`, invite policy, `DISCORD_CHANNEL_SCOPED_ACCESS`, `SIGNAL_PROFILE_NAME` | **kept** | **kept** |

Behavior vars are kept because nothing reseeds their *values* on reconnect.
Stripping them would change an agent's behavior across a disconnect and
reconnect.

## What lives in Swarm Map vs the surface

- **Swarm Map declares policy**: allowlists, channel approvals, flags and admin
  overlays. It is auditable and versioned (settings PUT uses an
  optimistic-concurrency token, and a stale write gets 409), and it is rendered
  to env.
- **Surfaces interpret it natively.** The adapter evaluates role membership,
  guild scoping and thread parentage at message time. Swarm Map never calls a
  platform to judge a message. (For role-managed control in future, Swarm Map
  would declare which role ids count, and the runtime would evaluate
  membership.)
- **Identity lists store native ids.** Typing a username is a UI convenience.
  It must expand to native ids at write time through `lib/resolvers` (Signal →
  UUID, Telegram → numeric id, Discord → snowflake). Matching is
  authorization-grade: unique usernames only, and an ambiguous one is refused.

## Rules for changes

1. **New var?** Add it to the registry with a class. Writing a surface var not
   in `ALL_SURFACE_VARS` should be treated as a bug.
2. **New platform?** One registry entry gives you settings management, policy
   defaults, disconnect and duplicate stripping, admin bootstrap, and the
   invariant suite. UI labels and dialogs (`components/surfaces/`) still need
   their own changes.
3. **Never widen by omission.** Empty and absent mean different things per
   platform (Discord empty channels = no gate; the `'0'` sentinel exists to
   deny all). Registry comments record these exceptions.
4. **API stability.** The plugin contract is frozen: the `admins/:userId` and
   `groups/:groupId` GET shapes (`{is_admin}` and `{allowed}`, status always
   200), the middleware exemptions that let agents call them without the
   operator cookie, the `adminUsers` compat field in settings GET, and the fleet
   API published in the README. Anything UI-only may change.

## Settled items

- `isValidIdentity` and the resolvers' skip patterns now use the registry's
  `identity.nativePattern`. The visible change: Discord ids tightened from a
  loose 5–25 digits to 15–21 (real snowflakes are 17–20, so stored allowlists
  are unaffected). Unknown platforms stay fail-closed. `registry.test.ts`
  asserts the agreement.
- The connect path (`ensurePolicyDefaults`) and the deploy template both seed
  `DISCORD_ALLOWED_CHANNELS=0`. The connect path used to seed it empty, which
  meant no channel gate.
- The admin route resolves the bare agent name the plugin sends to the same
  agent as its `h_<id>`, so explicit admin lists reach the agent.
