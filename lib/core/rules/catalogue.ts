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
    klass: 'security', kind: 'control-plane', reads: ['schema', 'hash'], enforcer: 'control-plane', tests: [] },
  { id: 'ctl.applied', statement: 'Swarm Map can tell which version of the policy is live.',
    klass: 'security', kind: 'control-plane', reads: ['hash', 'version'], enforcer: 'door', tests: [] },
  { id: 'ctl.receipts', statement: 'Every decision leaves a receipt.',
    klass: 'security', kind: 'control-plane', reads: ['agentId'], enforcer: 'door', tests: [] },

  { id: 'adm.surface', statement: 'A surface that is switched off hears nothing.',
    klass: 'security', kind: 'wall', reads: [`${S}.enabled`], enforcer: 'door', tests: [] },
  { id: 'adm.users', statement: 'Only listed people, or holders of a listed role, are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`], enforcer: 'door', tests: [] },
  { id: 'adm.rooms', statement: 'Only listed rooms are heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: [] },
  { id: 'adm.rooms.ignore', statement: 'An ignored room beats every allow.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: [] },
  { id: 'adm.anyone-in-room', statement: 'Anyone in an approved room may speak, when that is switched on.',
    klass: 'security', kind: 'wall', reads: [`${S}.anyoneInAllowedRoom`], enforcer: 'door', tests: [] },
  { id: 'adm.empty-is-closed', statement: 'An empty list admits nobody.',
    klass: 'security', kind: 'wall', reads: [`${S}.users`, `${S}.rooms`, `${S}.dm.users`], enforcer: 'door', tests: [] },

  { id: 'dm.closed', statement: 'Direct messages are off.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], enforcer: 'door', tests: [] },
  { id: 'dm.allowlist', statement: 'Only listed people may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`, `${S}.dm.users`], enforcer: 'door', tests: [] },
  { id: 'dm.open', statement: 'Anyone may send a direct message.',
    klass: 'security', kind: 'wall', reads: [`${S}.dm.mode`], enforcer: 'door', tests: [] },

  { id: 'addr.mention', statement: 'In a room, the agent answers only when it is addressed.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: [] },
  { id: 'addr.threads', statement: 'Threads need a mention too.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.threadsRequireMention`], enforcer: 'door', tests: [] },
  { id: 'addr.free-rooms', statement: 'Named rooms need no mention.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.rooms`], enforcer: 'door', tests: [] },
  { id: 'addr.observe', statement: 'Unaddressed text is kept as context and never answered.',
    klass: 'behaviour', kind: 'wall', reads: [`${S}.observeUnmentioned`], enforcer: 'door', tests: [] },

  { id: 'bots.mode', statement: 'Other bots are ignored, heard when they address the agent, or always heard.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.mode`], enforcer: 'door', tests: [] },
  { id: 'bots.inline-mention', statement: 'From a bot, a reply-ping is not a mention.',
    klass: 'security', kind: 'wall', reads: [`${S}.bots.inlineMentionOnly`], enforcer: 'door', tests: [] },
  { id: 'bots.no-self', statement: 'The agent never answers itself.',
    klass: 'security', kind: 'wall', reads: [], enforcer: 'door', tests: [] },

  { id: 'priv.admins', statement: 'The admin list is separate from admission.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], enforcer: 'door', tests: [] },
  { id: 'priv.no-forged-identity', statement: 'Message text and display names cannot raise privilege.',
    klass: 'security', kind: 'wall', reads: [`${S}.admins`], enforcer: 'door', tests: [] },

  { id: 'tools.lists', statement: 'A tool runs only if its class is allowed and not denied.',
    klass: 'security', kind: 'guardrail', reads: ['tools.allow', 'tools.deny'], enforcer: 'gate', tests: [] },
  { id: 'tools.posture', statement: 'Public agents lose shell, file, code-exec and chat-admin tools.',
    klass: 'security', kind: 'guardrail', reads: ['posture'], enforcer: 'gate', tests: [] },
  { id: 'tools.unknown', statement: 'An unclassified tool is denied on a public agent.',
    klass: 'security', kind: 'guardrail', reads: ['posture', 'tools.allow'], enforcer: 'gate', tests: [] },

  { id: 'budget.cap', statement: 'Monthly spend is capped.',
    klass: 'security', kind: 'wall', reads: ['budget.monthlyUsd', 'budget.onExceed'], enforcer: 'model-route', tests: [] },

  { id: 'out.still-allowed', statement: 'A reply is dropped if the policy changed mid-turn.',
    klass: 'security', kind: 'wall', reads: [`${S}.rooms`, `${S}.dm.mode`, `${S}.enabled`], enforcer: 'door', tests: [] },
]
