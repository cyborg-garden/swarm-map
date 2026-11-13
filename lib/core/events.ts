// What decide() is asked about, and what it answers. Spec section 4.3.
import type { SurfaceId, ToolClass } from './policy/types.ts'

export interface RoomRef {
  id: string
  kind: 'dm' | 'group' | 'channel' | 'thread'
  parentId?: string
  categoryId?: string
}

export interface Principal {
  id: string
  display: string
  isBot: boolean
  isSelf: boolean
  roles: string[]
}

export interface AttachmentRef { id: string; name: string; bytes: number }

export type MemoryScope =
  | { kind: 'agent' }
  | { kind: 'room'; surface: SurfaceId; room: string }
  | { kind: 'person'; surface: SurfaceId; room: string; userId: string }
  | { kind: 'team' }

export interface InboundEvent {
  kind: 'inbound'
  surface: SurfaceId
  room: RoomRef
  sender: Principal
  isDm: boolean
  /** The platform says the agent was pinged. A reply-ping counts here. */
  mention: boolean
  /** The agent's name is written in the text itself. */
  inlineMention: boolean
  replyToAgent: boolean
  text: string
  attachments: AttachmentRef[]
}

export type Event =
  | InboundEvent
  | { kind: 'outbound'; surface: SurfaceId; room: RoomRef; turnId?: string; text: string }
  | { kind: 'invite'; surface: SurfaceId; room: RoomRef; inviter: Principal }
  | { kind: 'tool'; surface?: SurfaceId; room: RoomRef; actor: Principal; toolClass: ToolClass
      /** For the caller's own records. decide() never puts it in `why`: it can be harness-supplied text. */
      toolName: string; argsDigest: string }
  | { kind: 'memory'; op: 'read' | 'write'; scope: MemoryScope; room: RoomRef }
  | { kind: 'model'; provider: string; model: string }
  | { kind: 'egress'; host: string; method: string }

/** Live data the caller fetched. decide() does no I/O. */
export interface Facts {
  rolesOf?: Record<string, string[]>
  paired?: string[]
  spentUsdThisMonth?: number
  botTurnsInARow?: number
  turnLive?: boolean
}

export type Verdict = 'deliver' | 'observe' | 'drop' | 'allow' | 'ask' | 'deny'

export interface Decision {
  verdict: Verdict
  /** Catalogue id of the deciding rule. */
  rule: string
  /** One plain sentence. */
  why: string
  privilege: 'admin' | 'member' | 'guest'
  /** Set by the door from the event, never by the model. */
  sessionKey?: string
  trace: { rule: string; outcome: 'pass' | 'fail' | 'n/a' }[]
  policyHash: string
}
