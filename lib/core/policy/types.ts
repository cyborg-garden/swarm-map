// PolicyRecord: the one record that says who an agent may hear and answer,
// what it may do, and which keys it may use. Stored by Swarm Map, never in a
// harness file. Spec: docs/lab/primitives.md section 4.1.
//
// Erasable-only TypeScript (no enums, no parameter properties) with explicit
// `.ts` imports, so plain Node 24 can run this tree with no build step.

/** 'fake' is the scripted test room. validatePolicy() rejects it unless `testing` is set. */
export type SurfaceId = 'discord' | 'signal' | 'slack' | 'telegram' | 'mattermost' | 'fake'
export type Posture = 'private' | 'team' | 'public'
export type PrincipalRef = { kind: 'user' | 'role'; id: string }
export type ToolClass =
  | 'shell' | 'file_read' | 'file_write' | 'code_exec' | 'browser' | 'network'
  | 'chat_post' | 'chat_admin' | 'memory' | 'search' | `mcp:${string}` | 'unknown'

export interface RoomRule {
  match: { room: string } | { category: string }
  mode: 'mention' | 'free' | 'ignore'
  /**
   * Anyone who can post in this room is heard here, as a guest, as with `anyoneInAllowedRoom` for
   * one room. Such a room always needs a mention, its threads too, and loses the tools a public
   * agent loses (decide.ts). Left out, false.
   */
  anyone?: boolean
}

export interface SurfacePolicy {
  enabled: boolean
  /** Which bot identity. The token lives in the key store, never here. */
  account: string
  // Admission: who and where
  users: PrincipalRef[]
  anyoneInAllowedRoom: boolean
  /** First match wins; 'ignore' beats everything. */
  rooms: RoomRule[]
  dm: { mode: 'closed' | 'allowlist' | 'pairing' | 'open'; users: PrincipalRef[] }
  bots: {
    mode: 'none' | 'mentions' | 'all'
    inlineMentionOnly: boolean
    roles: string[]
    /**
     * The only bots that are heard, by id. Empty or left out: `mode` alone
     * decides. Non-empty: a bot that is not named is dropped whatever `mode`
     * says, and a named one is still subject to `mode` and the loop limit.
     */
    ids?: string[]
    maxAlternatingTurns: number
  }
  invites: { mode: 'closed' | 'admins' | 'allowlisted' | 'open' }
  // Behaviour
  threadsRequireMention: boolean
  observeUnmentioned: boolean
  // Privilege, kept apart from admission on purpose
  admins: PrincipalRef[]
  approverRoles: string[]
}

export interface ToolPolicy {
  allow: ToolClass[]
  /** Needs an admin's yes in the room. */
  ask: ToolClass[]
  deny: ToolClass[]
  /**
   * Fewer tools in one room, by room id (a thread reads its parent's). Only ever narrows: with
   * `allow` or `ask` given, a class on neither is refused in that room; `deny` refuses; `ask` makes
   * a class the agent has wait for a yes there. A class the lists above do not give is never given.
   */
  perRoom?: Record<string, { allow?: ToolClass[]; ask?: ToolClass[]; deny?: ToolClass[] }>
  /**
   * The command policy for the shell (core/tools/command-policy.ts). Left out, every shell call is
   * decided by the lists above alone. Set, a command whose every part is on `allow` runs without a
   * yes, and one with anything on `block` (or clearly destructive) never runs.
   */
  commands?: { allow: string[]; block: string[] }
  browserGuard: 'off' | 'public-hosts-only'
}

export interface KeyGrant {
  ref: string
  kind: 'model' | 'broker' | 'sidecar-tool' | 'env'
  hosts: string[]
  rooms?: string[]
}

export interface EgressPolicy {
  /**
   * `deny`: a web fetch reaches only the hosts below. `public`: any public address, with every
   * other check of the door's unchanged (GET only, no credential, private addresses refused).
   */
  default: 'deny' | 'public'
  /**
   * The hosts a web fetch through the door may reach (lib/core/tools/web.ts). A host is matched
   * exactly. With `paths`, only those path prefixes on it, by whole segments. Only GET is ever made.
   */
  hosts: { host: string; methods?: string[]; paths?: string[] }[]
  blockPrivateRanges: true
}

export interface MemoryPolicy {
  threadsPoolIntoParent: boolean
  dmIsolated: true
  team: { dm: 'none' | 'read'; group: 'none' | 'read' | 'read-write'; public: 'none' | 'read' }
  store: { kind: 'git-markdown'; repo: string }
}

export interface PolicyRecord {
  schema: 1
  /** Swarm Map id, not a container name. */
  agentId: string
  /** Bumps on every save. */
  version: number
  /** sha256 of the canonical JSON of every other field. The sidecar echoes it back. */
  hash: string
  posture: Posture
  mode: 'door' | 'native'
  surfaces: Partial<Record<SurfaceId, SurfacePolicy>>
  tools: ToolPolicy
  keys: KeyGrant[]
  egress: EgressPolicy
  memory: MemoryPolicy
  session: { groupShared: boolean; resetAtLocalHour?: number; timezone: string }
  budget?: { monthlyUsd: number; onExceed: 'refuse' | 'warn' }
}
