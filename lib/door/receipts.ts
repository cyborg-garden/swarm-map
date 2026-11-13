// Receipts: one line per decision the door made. They hold ids and sizes,
// never message text, so they can be kept and shown without leaking a
// conversation. They are the "why didn't it answer?" view. Spec 4.10.
import { appendFileSync } from 'node:fs'
import type { Decision, Event } from '../core/events.ts'
import type { SurfaceId } from '../core/policy/types.ts'

export interface Receipt {
  ts: string
  agentId: string
  policyHash: string
  event: {
    kind: Event['kind']
    surface?: SurfaceId
    room?: string
    sender?: string
    messageId?: string
    turnId?: string
    bytes?: number
  }
  verdict: Decision['verdict']
  rule: string
  why: string
  /** Counts and codes only. Never message text. */
  note?: string
}

export interface ReceiptLog {
  write(receipt: Receipt): void
  all(): Receipt[]
}

/** Keeps receipts in memory, and appends each as a JSON line to `file` when given. */
export function createReceiptLog(opts: { file?: string } = {}): ReceiptLog {
  const receipts: Receipt[] = []
  return {
    write(receipt) {
      receipts.push(receipt)
      if (opts.file) appendFileSync(opts.file, JSON.stringify(receipt) + '\n')
    },
    all: () => [...receipts],
  }
}

/** The receipt trail for one inbound message, as plain lines. */
export function explain(receipts: Receipt[], messageId: string): string[] {
  const trail = receipts.filter((r) => r.event.messageId === messageId)
  if (trail.length === 0) return ['No receipt for that message. The door never saw it.']
  return trail.map((r) => `${r.event.kind}  ${r.verdict}  ${r.rule}  ${r.why}${r.note ? `  (${r.note})` : ''}`)
}
