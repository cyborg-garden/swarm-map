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
  | 'chat_post' | 'chat_admin' | 'memory' | `mcp:${string}` | 'unknown'

export interface RoomRule {
  match: { room: string } | { category: string }
  mode: 'mention' | 'free' | 'ignore'
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
  perRoom?: Record<string, { allow?: ToolClass[]; ask?: ToolClass[]; deny?: ToolClass[] }>
  browserGuard: 'off' | 'public-hosts-only'
}

export interface KeyGrant {
  ref: string
  kind: 'model' | 'broker' | 'sidecar-tool' | 'env'
  hosts: string[]
  rooms?: string[]
}

export interface EgressPolicy {
  default: 'deny'
  hosts: { host: string; methods?: string[] }[]
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
