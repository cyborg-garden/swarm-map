// The rule catalogue: one entry per promise the platform makes. Spec 4.2.
//
// A rule is listed here only once something enforces it and a test proves it.
// `tests` holds ids of the form `D:<scenario id>` (a file in
// conformance/scenarios), `P:<name>` (a door test titled `[P:<name>]`) or
// `U:<name>` (a unit test titled `[U:<name>]`). The catalogue guard test fails
// on a rule with no test, and on a test id that does not exist.

export interface Rule {
  id: string
  /** One plain sentence, shown in the UI. */
  statement: string
  klass: 'security' | 'behaviour'
  kind: 'wall' | 'guardrail' | 'control-plane'
  /** PolicyRecord paths this rule reads. */
  reads: string[]
  enforcer: 'door' | 'model-route' | 'gate' | 'memory' | 'substrate' | 'control-plane'
  tests: string[]
}

const S = 'surfaces.*'

export const RULES: Rule[] = [
  { id: 'ctl.valid', statement: 'A record that fails validation is never applied.',
    klass: 'security', kind: 'control-plane', reads: ['schema', 'agentId', 'version', 'hash'], enforcer: 'control-plane', tests: ['U:validate', 'U:fail-closed', 'P:fake-only'] },

  // "No restart" means the agent and its door. A harness whose tools are fixed
  // when its process starts has that one session's process restarted by its
  // shim when the tool list changes (Capabilities.toolChange).
  { id: 'ctl.applied', statement: 'Swarm Map can tell which version of the policy is live, and a change applies from the next message on, tools included, without restarting the agent.',
    klass: 'security', kind: 'control-plane', reads: ['hash', 'version'], enforcer: 'door', tests: ['P:heartbeat-hash', 'U:pi-shim'] },
  { id: 'ctl.receipts', statement: 'Every decision leaves a receipt, and a receipt never holds message text or anything else the harness wrote.',
    klass: 'security', kind: 'control-plane', reads: ['agentId'], enforcer: 'door', tests: ['P:receipts'] },
  { id: 'ctl.brain-token', statement: 'A harness that does not present the token for its cell is refused.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:hello-token'] },

  { id: 'adm.surface', statement: 'A surface that is switched off hears nothing.',
    klass: 'security', kind: 'wall', reads: [`${S}.enabled`], enforcer: 'door', tests: ['D:adm.surface/switched-off'] },
  { id: 'adm.users', statement: 'Only listed people, or holders of a listed role, are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`], enforcer: 'door', tests: ['D:adm.users/role-holder', 'D:adm.users/stranger-in-room'] },
  { id: 'adm.rooms', statement: 'Only listed rooms are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: ['D:adm.rooms/category', 'D:adm.rooms/unlisted-room'] },
  { id: 'adm.rooms.ignore', statement: 'An ignored room beats every allow.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: ['D:adm.rooms.ignore/ignore-beats-allow'] },
  { id: 'adm.anyone-in-room', statement: 'Anyone in an approved room may speak, when that is switched on.',
    klass: 'security', kind: 'wall', reads: [`${S}.anyoneInAllowedRoom`], enforcer: 'door', tests: ['D:adm.anyone-in-room/stranger-welcome'] },
  { id: 'adm.empty-is-closed', statement: 'An empty list admits nobody.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`, `${S}.rooms`, `${S}.dm.users`], enforcer: 'door', tests: ['D:adm.empty-is-closed/no-dm-users', 'D:adm.empty-is-closed/no-rooms', 'D:adm.empty-is-closed/no-users'] },

  { id: 'dm.closed', statement: 'Direct messages are off.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], enforcer: 'door', tests: ['D:dm.closed/dm-refused'] },
  { id: 'dm.allowlist', statement: 'Only listed people may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`, `${S}.dm.users`], enforcer: 'door', tests: ['D:dm.allowlist/listed-dm', 'D:dm.allowlist/stranger-dm'] },
  { id: 'dm.open', statement: 'Anyone may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], enforcer: 'door', tests: ['D:dm.open/anyone'] },

  { id: 'addr.mention', statement: 'In a room, the agent answers only when it is addressed.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: ['D:addr.mention/unaddressed'] },
  { id: 'addr.threads', statement: 'Threads need a mention too.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.threadsRequireMention`], enforcer: 'door', tests: ['D:addr.threads/thread-needs-mention'] },
  { id: 'addr.free-rooms', statement: 'Named rooms need no mention.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: ['D:addr.free-rooms/no-mention-needed'] },
  { id: 'addr.observe', statement: 'Unaddressed text is kept as context and never answered.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.observeUnmentioned`], enforcer: 'door', tests: ['D:addr.observe/overheard', 'P:observe'] },

  { id: 'bots.mode', statement: 'Other bots are ignored, heard when they address the agent, or always heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.mode`], enforcer: 'door', tests: ['D:bots.mode/bot-ignored', 'D:bots.mode/bot-must-address'] },
  { id: 'bots.inline-mention', statement: 'From a bot, a reply-ping is not a mention.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.inlineMentionOnly`], enforcer: 'door', tests: ['D:bots.inline-mention/reply-ping'] },
  { id: 'bots.no-self', statement: 'The agent never answers itself.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: ['D:bots.no-self/own-message'] },

  { id: 'priv.admins', statement: 'The admin list is separate from admission.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], enforcer: 'door', tests: ['D:priv.admins/admin-not-admitted', 'D:priv.admins/listed-admin'] },
  { id: 'priv.no-forged-identity', statement: 'Message text and display names cannot raise privilege.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], enforcer: 'door', tests: ['D:priv.no-forged-identity/claims-admin', 'U:pi-preamble'] },

  { id: 'tools.lists', statement: 'A tool runs only if its class is allowed and not denied.',
    klass: 'security', kind: 'guardrail', reads: ['tools.allow', 'tools.deny'], enforcer: 'gate', tests: ['D:tools.lists/deny-wins', 'D:tools.lists/not-allowed'] },
  { id: 'tools.posture', statement: 'Public agents lose shell, file, code-exec and chat-admin tools.',
    klass: 'security', kind: 'guardrail', reads: ['posture'], enforcer: 'gate', tests: ['D:tools.posture/public-loses-chat-admin', 'D:tools.posture/public-loses-code-exec', 'D:tools.posture/public-loses-file-read', 'D:tools.posture/public-loses-file-write', 'D:tools.posture/public-loses-shell', 'U:tools-posture'] },
  { id: 'tools.unknown', statement: 'An unclassified tool is denied on a public agent.',
    klass: 'security', kind: 'guardrail', reads: ['posture', 'tools.allow'], enforcer: 'gate', tests: ['D:tools.unknown/unmapped-on-public'] },

  // Both model-route rules hold only for a harness whose model wire format has
  // a ModelShape (lib/door/model-shapes.ts). One exists: OpenAI chat-completions.
  // A harness that speaks the Anthropic Messages API has neither rule yet.
  { id: 'budget.cap', statement: 'Monthly spend is capped, for a harness that talks to its model in the OpenAI chat format.',
    klass: 'security', kind: 'wall', reads: ['budget.monthlyUsd', 'budget.onExceed'], enforcer: 'model-route', tests: ['D:budget.cap/spent', 'D:budget.cap/warn-only', 'U:budget-meter', 'U:budget-unmetered', 'U:budget-parallel', 'U:budget-ledger', 'U:model-shape'] },

  { id: 'keys.model-route', statement: 'The harness holds a placeholder. Only the sidecar holds the real model key. This holds for a harness that talks to its model in the OpenAI chat format.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'model-route', tests: ['U:key-swap', 'U:model-shape'] },

  { id: 'out.still-allowed', statement: 'A reply is dropped if the policy changed mid-turn.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`, `${S}.dm.mode`, `${S}.enabled`], enforcer: 'door', tests: ['D:out.still-allowed/dm-closed', 'D:out.still-allowed/room-removed', 'D:out.still-allowed/turn-dead'] },

  { id: 'turn.one-reply', statement: 'A turn gets at most one reply, and only once the harness says it is finished.',
    klass: 'behaviour', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:one-reply'] },
  { id: 'turn.known', statement: 'Anything the harness sends for a turn the door did not open is dropped.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:unknown-turn'] },
  { id: 'turn.no-harness', statement: 'A message is not delivered while no harness is connected, and the receipt says so.',
    klass: 'behaviour', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:no-harness'] },
  { id: 'tools.no-verdict', statement: 'A tool with no verdict in time does not run.',
    klass: 'security', kind: 'guardrail', reads: [], enforcer: 'gate', tests: ['P:no-verdict-is-no', 'P:tool-verdict', 'U:pi-gate'] },
  { id: 'tools.gate-loaded', statement: 'A harness whose tool gate has not said it is loaded is sent no turn.',
    klass: 'security', kind: 'guardrail', reads: [], enforcer: 'gate', tests: ['U:pi-gate-ready', 'U:must-fail'] },

  { id: 'mem.dm-isolated', statement: 'A direct message is only delivered to a harness that keeps each session\'s files apart.',
    klass: 'security', kind: 'wall', reads: ['memory.dmIsolated'], enforcer: 'door', tests: ['P:dm-isolated'] },

  { id: 'san.in', statement: 'Pasted secrets are scrubbed before the harness sees them.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:scrub-in'] },
  { id: 'san.out', statement: 'Secrets are redacted before a reply is posted, and a failed check posts nothing.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: ['P:redact-out', 'P:out-fails-closed'] },
]
