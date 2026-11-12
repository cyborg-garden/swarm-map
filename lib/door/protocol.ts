// The brain protocol: JSON lines over one socket between the sidecar (the
// door) and the shim that runs beside the harness in the cell. Spec 4.4, 4.5.
// This file is the whole per-harness contract. A shim translates these
// records to and from its harness's own protocol and decides nothing.
import type { AttachmentRef, RoomRef } from '../core/events.ts'
import type { SurfaceId, ToolClass } from '../core/policy/types.ts'

export const PROTOCOL_VERSION = 1

export interface ObservedLine { sender: string; text: string; ts: string }

/** What the harness is given for one turn. */
export interface Envelope {
  id: string
  turnId: string
  sessionKey: string
  surface: SurfaceId
  room: RoomRef
  sender: { id: string; display: string; isBot: boolean }
  text: string
  attachments: AttachmentRef[]
  context: { roster?: string[]; observed?: ObservedLine[]; memory?: string; rulesNote?: string }
  /** Native tool names this turn may see. */
  tools: string[]
  whenBusy: 'queue' | 'steer'
  deadlineMs: number
}

export interface Usage { model: string; inTokens: number; outTokens: number; usd: number }

export type ToShim =
  | { t: 'turn'; env: Envelope }
  | { t: 'tool_verdict'; callId: string; allow: boolean; reason?: string }
  | { t: 'cancel'; turnId: string }
  | { t: 'reset'; sessionKey: string }
  | { t: 'shutdown' }

export type FromShim =
  | { t: 'hello'; token: string; protocol: 1; caps: Capabilities }
  | { t: 'tool_request'; callId: string; turnId: string; tool: string; input: unknown }
  | { t: 'tool_done'; callId: string; ok: boolean; summary: string }
  | { t: 'delta'; turnId: string; text: string }
  | { t: 'reply'; turnId: string; text: string; attachments: AttachmentRef[] }
  | { t: 'settled'; turnId: string; usage?: Usage }
  | { t: 'error'; turnId?: string; message: string }
  | { t: 'health'; ok: boolean }

export interface Capabilities {
  harness: 'pi' | 'letta-code' | 'claude-sdk' | 'hermes' | 'openclaw' | 'echo'
  version: string
  /** Has native chat channels. Must be off in door mode. */
  ownsChat: boolean
  toolVeto: 'pre-call' | 'none'
  /** Can hold a call while an admin answers. */
  approvalRoundTrip: boolean
  /** Every tool it can call, classified. A name missing here is class 'unknown'. */
  toolMap: Record<string, ToolClass>
  /** Model traffic can be pointed at the sidecar. */
  modelBaseUrl: boolean
  mcpClient: boolean
  nativeMemory: 'none' | 'off-able' | 'always-on'
  sessions: 'one-per-process' | 'many'
  steer: boolean
  resume: boolean
  usage: 'reported' | 'route-only'
  streaming: boolean
}
