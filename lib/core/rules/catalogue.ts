// The rule catalogue: one entry per promise the platform makes. Spec 4.2.
//
// These are the rules every harness is held to, so nothing here is about one
// harness. A rule is listed only once something enforces it and a test proves
// it, and the proof comes in two parts that are kept apart:
//
// - `tests`: proof that holds whatever the harness is. Ids of the form
//   `D:<scenario id>` (a file in conformance/scenarios), `P:<name>` (a door
//   test titled `[P:<name>]`) or `U:<name>` (a unit test of shared code titled
//   `[U:<name>]`). A test of one harness's shim is refused here.
// - `checks`: the shim checks (conformance/suites/checks.ts) a harness has to
//   pass for the rule to hold with that harness in the loop. Their result is
//   per harness and version: it is the `rules` list in that harness's matrix
//   file, built from a run. No matrix, or a check that did not run, means the
//   rule is not claimed for that harness.
//
// What only one harness's shim promises (how Pi's gate announces itself, how
// Pi is told who is speaking) lives with that runtime: lib/runtimes/<id>/rules.ts.
//
// The catalogue guard test fails on a rule with no test, a test id that does
// not exist, a test of one harness, and a check id that does not exist.
import type { SurfaceId } from '../policy/types.ts'

export interface Rule {
  id: string
  /** One plain sentence, shown in the UI. */
  statement: string
  klass: 'security' | 'behaviour'
  kind: 'wall' | 'guardrail' | 'control-plane'
  /** PolicyRecord paths this rule reads. */
  reads: string[]
  /** The chat surfaces the rule holds on. */
  surfaces: SurfaceId[] | 'all'
  enforcer: 'door' | 'model-route' | 'gate' | 'memory' | 'substrate' | 'control-plane'
  /** Harness-neutral proof. Never a test of one harness. */
  tests: string[]
  /** Shim checks that prove the harness's part. Empty when the rule needs nothing from the harness. */
  checks: string[]
}

const S = 'surfaces.*'

export const RULES: Rule[] = [
  { id: 'ctl.valid', statement: 'A record that fails validation is never applied.',
    klass: 'security', kind: 'control-plane', reads: ['schema', 'agentId', 'version', 'hash'], surfaces: 'all', enforcer: 'control-plane', tests: ['U:validate', 'U:fail-closed', 'P:fake-only'], checks: [] },

  // "No restart" means the agent and its door. A harness whose tools are fixed
  // when its process starts has that one session's process restarted by its
  // shim when the tool list changes (Capabilities.toolChange). The door's half
  // is the heartbeat hash; "tools included" is each harness's to show (C15, C15t).
  { id: 'ctl.applied', statement: 'Swarm Map can tell which version of the policy is live, and a change applies from the next message on, tools included, without restarting the agent.',
    klass: 'security', kind: 'control-plane', reads: ['hash', 'version'], surfaces: 'all', enforcer: 'door', tests: ['P:heartbeat-hash'], checks: ['C15', 'C15t'] },
  { id: 'ctl.receipts', statement: 'Every decision leaves a receipt, and a receipt never holds message text or anything else the harness wrote.',
    klass: 'security', kind: 'control-plane', reads: ['agentId'], surfaces: 'all', enforcer: 'door', tests: ['P:receipts'], checks: [] },
  { id: 'ctl.brain-token', statement: 'A harness that does not present the token for its cell is refused.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:hello-token'], checks: [] },

  { id: 'adm.surface', statement: 'A surface that is switched off hears nothing.',
    klass: 'security', kind: 'wall', reads: [`${S}.enabled`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.surface/switched-off'], checks: [] },
  { id: 'adm.users', statement: 'Only listed people, or holders of a listed role, are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.users/role-holder', 'D:adm.users/stranger-in-room'], checks: [] },
  { id: 'adm.rooms', statement: 'Only listed rooms are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.rooms/category', 'D:adm.rooms/unlisted-room'], checks: [] },
  { id: 'adm.rooms.ignore', statement: 'An ignored room beats every allow.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.rooms.ignore/ignore-beats-allow'], checks: [] },
  { id: 'adm.anyone-in-room', statement: 'Anyone in an approved room may speak, when that is switched on.',
    klass: 'security', kind: 'wall', reads: [`${S}.anyoneInAllowedRoom`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.anyone-in-room/stranger-welcome'], checks: [] },
  { id: 'adm.empty-is-closed', statement: 'An empty list admits nobody.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`, `${S}.rooms`, `${S}.dm.users`], surfaces: 'all', enforcer: 'door', tests: ['D:adm.empty-is-closed/no-dm-users', 'D:adm.empty-is-closed/no-rooms', 'D:adm.empty-is-closed/no-users'], checks: [] },

  { id: 'dm.closed', statement: 'Direct messages are off.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], surfaces: 'all', enforcer: 'door', tests: ['D:dm.closed/dm-refused'], checks: [] },
  { id: 'dm.allowlist', statement: 'Only listed people may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`, `${S}.dm.users`], surfaces: 'all', enforcer: 'door', tests: ['D:dm.allowlist/listed-dm', 'D:dm.allowlist/stranger-dm'], checks: [] },
  { id: 'dm.open', statement: 'Anyone may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], surfaces: 'all', enforcer: 'door', tests: ['D:dm.open/anyone'], checks: [] },

  { id: 'addr.mention', statement: 'In a room, the agent answers only when it is addressed.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], surfaces: 'all', enforcer: 'door', tests: ['D:addr.mention/unaddressed'], checks: [] },
  { id: 'addr.threads', statement: 'Threads need a mention too.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.threadsRequireMention`], surfaces: 'all', enforcer: 'door', tests: ['D:addr.threads/thread-needs-mention'], checks: [] },
  { id: 'addr.free-rooms', statement: 'Named rooms need no mention.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], surfaces: 'all', enforcer: 'door', tests: ['D:addr.free-rooms/no-mention-needed'], checks: [] },
  { id: 'addr.observe', statement: 'Unaddressed text is kept as context and never answered.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.observeUnmentioned`], surfaces: 'all', enforcer: 'door', tests: ['D:addr.observe/overheard', 'P:observe'], checks: ['C2'] },

  { id: 'bots.mode', statement: 'Other bots are ignored, heard when they address the agent, or always heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.mode`], surfaces: 'all', enforcer: 'door', tests: ['D:bots.mode/bot-ignored', 'D:bots.mode/bot-must-address'], checks: [] },
  { id: 'bots.inline-mention', statement: 'From a bot, a reply-ping is not a mention.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.inlineMentionOnly`], surfaces: 'all', enforcer: 'door', tests: ['D:bots.inline-mention/reply-ping'], checks: [] },
  { id: 'bots.no-self', statement: 'The agent never answers itself.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['D:bots.no-self/own-message'], checks: [] },

  { id: 'priv.admins', statement: 'The admin list is separate from admission.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], surfaces: 'all', enforcer: 'door', tests: ['D:priv.admins/admin-not-admitted', 'D:priv.admins/listed-admin'], checks: [] },
  // The door's half: privilege comes from the sender id the surface reported.
  // The harness's half (text that claims to be an admin changes no tool
  // verdict) is C13, which no harness has run yet. Until one does, the rule is
  // claimed for the door only.
  { id: 'priv.no-forged-identity', statement: 'Message text and display names cannot raise privilege.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], surfaces: 'all', enforcer: 'door', tests: ['D:priv.no-forged-identity/claims-admin'], checks: ['C13'] },

  { id: 'tools.lists', statement: 'A tool runs only if its class is allowed and not denied.',
    klass: 'security', kind: 'guardrail', reads: ['tools.allow', 'tools.deny'], surfaces: 'all', enforcer: 'gate', tests: ['D:tools.lists/deny-wins', 'D:tools.lists/not-allowed'], checks: ['C4', 'C4a', 'C4+'] },
  // C4p shows the guardrail: the gate says no to a public agent. The wall behind it is C10
  // (the gate removed, in a sealed cell), so the rule is claimed for no harness until C10 runs.
  { id: 'tools.posture', statement: 'Public agents lose shell, file, code-exec and chat-admin tools.',
    klass: 'security', kind: 'guardrail', reads: ['posture'], surfaces: 'all', enforcer: 'gate', tests: ['D:tools.posture/public-loses-chat-admin', 'D:tools.posture/public-loses-code-exec', 'D:tools.posture/public-loses-file-read', 'D:tools.posture/public-loses-file-write', 'D:tools.posture/public-loses-shell', 'U:tools-posture'], checks: ['C4p', 'C10'] },
  { id: 'tools.unknown', statement: 'An unclassified tool is denied on a public agent.',
    klass: 'security', kind: 'guardrail', reads: ['posture', 'tools.allow'], surfaces: 'all', enforcer: 'gate', tests: ['D:tools.unknown/unmapped-on-public'], checks: ['C7'] },

  // Both model-route rules hold only for a harness whose model wire format has
  // a ModelShape (lib/door/model-shapes.ts). One exists: OpenAI chat-completions.
  // A harness that speaks the Anthropic Messages API has neither rule yet.
  // Both are walls, and the route is only half of each. C12 and C8p show the
  // route does its part. That the harness has no other way to a model (C9) or
  // to a key (C8) needs a sealed cell, so neither rule is claimed without one.
  { id: 'budget.cap', statement: 'Monthly spend is capped, for a harness that talks to its model in the OpenAI chat format.',
    klass: 'security', kind: 'wall', reads: ['budget.monthlyUsd', 'budget.onExceed'], surfaces: 'all', enforcer: 'model-route', tests: ['D:budget.cap/spent', 'D:budget.cap/warn-only', 'U:budget-meter', 'U:budget-unmetered', 'U:budget-parallel', 'U:budget-ledger', 'U:model-shape'], checks: ['C12', 'C9'] },

  { id: 'keys.model-route', statement: 'The harness holds a placeholder. Only the sidecar holds the real model key. This holds for a harness that talks to its model in the OpenAI chat format.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'model-route', tests: ['U:key-swap', 'U:model-shape'], checks: ['C8p', 'C8'] },

  { id: 'out.still-allowed', statement: 'A reply is dropped if the policy changed mid-turn.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`, `${S}.dm.mode`, `${S}.enabled`], surfaces: 'all', enforcer: 'door', tests: ['D:out.still-allowed/dm-closed', 'D:out.still-allowed/room-removed', 'D:out.still-allowed/turn-dead'], checks: [] },

  { id: 'turn.one-reply', statement: 'A turn gets at most one reply, and only once the harness says it is finished.',
    klass: 'behaviour', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:one-reply'], checks: ['C1'] },
  { id: 'turn.known', statement: 'Anything the harness sends for a turn the door did not open is dropped.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:unknown-turn'], checks: [] },
  { id: 'turn.no-harness', statement: 'A message is not delivered while no harness is connected, and the receipt says so.',
    klass: 'behaviour', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:no-harness'], checks: [] },
  { id: 'tools.no-verdict', statement: 'A tool with no verdict in time does not run.',
    klass: 'security', kind: 'guardrail', reads: [], surfaces: 'all', enforcer: 'gate', tests: ['P:no-verdict-is-no', 'P:tool-verdict'], checks: ['C5', 'C5v'] },

  { id: 'mem.dm-isolated', statement: 'A direct message is only delivered to a harness that keeps each session\'s files apart.',
    klass: 'security', kind: 'wall', reads: ['memory.dmIsolated'], surfaces: 'all', enforcer: 'door', tests: ['P:dm-isolated'], checks: [] },

  // What the harness says about its own memory decides this (Capabilities.nativeMemory), so the
  // rule names no shim check: the door keeps it for any harness that declares such a memory.
  { id: 'mem.one-scope', statement: 'A harness that keeps one memory for the whole agent is given one room, or one person\'s direct messages, and no more.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`, `${S}.dm.mode`, `${S}.dm.users`], surfaces: 'all', enforcer: 'door', tests: ['U:one-scope', 'P:one-scope'], checks: [] },

  { id: 'san.in', statement: 'Pasted secrets are scrubbed before the harness sees them.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:scrub-in'], checks: [] },
  { id: 'san.out', statement: 'Secrets are redacted before a reply is posted, and a failed check posts nothing.',
    klass: 'security', kind: 'wall', reads: [], surfaces: 'all', enforcer: 'door', tests: ['P:redact-out', 'P:out-fails-closed'], checks: [] },
]
