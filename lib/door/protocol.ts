// The brain protocol: JSON lines over one socket between the sidecar (the
// door) and the shim that runs beside the harness in the cell. Spec 4.4, 4.5.
// This file is the whole per-harness contract. A shim translates these
// records to and from its harness's own protocol and decides nothing.
import type { AttachmentRef, RoomRef } from '../core/events.ts'
import { isToolClass } from '../core/policy/shape.ts'
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
  /**
   * Native tool names this turn may see: exactly these, no more and no fewer.
   * The door works the list out again for every turn, so it can differ from
   * the last turn in the same session. A harness that fixes its tools when
   * its process starts must be restarted by its shim when the list changes
   * (and declares `toolChange: 'restart'`).
   */
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
  /**
   * How a changed `Envelope.tools` reaches the harness. 'live': it takes a
   * tool list per turn. 'restart': its tools are fixed at process start, so
   * the shim restarts the session's process when the list changes.
   */
  toolChange: 'live' | 'restart'
  /**
   * Can one session read another's files, home or transcript? 'sealed' means
   * no, and something outside the harness enforces it. 'none' means every
   * session shares one place on disk; the door then delivers no DM to it.
   * Anything but 'sealed' is read as 'none'.
   */
  sessionIsolation: 'none' | 'sealed'
  /** The model wire format the harness speaks to the model route. See model-shapes.ts. */
  modelShape: 'openai-chat' | 'none'
}

export const HARNESSES: Capabilities['harness'][] = ['pi', 'letta-code', 'claude-sdk', 'hermes', 'openclaw', 'echo']

/** A tool name the door is willing to write down: short, and no free text. */
export const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * Why a hello's capabilities cannot be accepted, or undefined if they can.
 * Names declared here end up in receipts and the heartbeat, so they must not
 * be able to carry text: a shim is refused rather than trusted to be terse.
 */
export function capsProblem(caps: unknown): string | undefined {
  if (caps === null || typeof caps !== 'object') return 'capabilities are missing'
  const c = caps as Partial<Capabilities>
  if (!HARNESSES.includes(c.harness as never)) return 'unknown harness'
  if (typeof c.version !== 'string' || !SAFE_NAME.test(c.version)) return 'version is not a plain version string'
  if (c.toolMap === null || typeof c.toolMap !== 'object' || Array.isArray(c.toolMap)) return 'toolMap is not a map'
  for (const [name, toolClass] of Object.entries(c.toolMap)) {
    if (!SAFE_NAME.test(name)) return 'a tool name is not a plain name'
    if (!isToolClass(toolClass)) return 'a tool class is not a known class'
  }
  return undefined
}
