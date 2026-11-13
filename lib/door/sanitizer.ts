// Secret redaction for text crossing the door. Spec 4.7.
//
// Inbound: scrub secrets someone pasted, before the harness sees them.
// Outbound: redact anything secret-shaped before it is posted. The door
// treats a throw here differently by direction: outbound fails closed
// (nothing is posted), and so does inbound (the message is dropped), each
// with a receipt.
import type { RoomRef } from '../core/events.ts'
import type { Posture } from '../core/policy/types.ts'

export interface Sanitizer {
  run(direction: 'inbound' | 'outbound', text: string, ctx: { posture: Posture; room: RoomRef }):
    { text: string; findings: { pattern: string; count: number }[] }
}

// Pattern sources are split so this file never holds a string the repo's own
// secret scanner would stop on. Order matters: narrower shapes first.
const PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'private-key', re: new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----[\\s\\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)', 'g') },
  { id: 'anthropic-key', re: new RegExp('\\bsk-' + 'ant-[A-Za-z0-9_-]{16,}', 'g') },
  { id: 'api-key', re: new RegExp('\\bsk-' + '[A-Za-z0-9_-]{20,}', 'g') },
  { id: 'github-token', re: new RegExp('\\b(gh[pousr]_' + '[A-Za-z0-9]{30,}|github_pat_' + '[A-Za-z0-9_]{20,})', 'g') },
  { id: 'slack-token', re: new RegExp('\\bxox[baprs]-' + '[A-Za-z0-9-]{10,}', 'g') },
  { id: 'aws-access-key', re: new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b', 'g') },
  { id: 'notion-token', re: new RegExp('\\bntn_' + '[A-Za-z0-9]{20,}', 'g') },
]

/**
 * `extraSecrets` are exact strings the sidecar itself holds (the real model
 * key, a chat token). They are redacted wherever they appear, whatever their shape.
 */
export function createSanitizer(opts: { extraSecrets?: string[] } = {}): Sanitizer {
  const held = (opts.extraSecrets ?? []).filter((s) => s.length >= 8)
  return {
    run(_direction, text) {
      const counts = new Map<string, number>()
      const hit = (id: string): void => { counts.set(id, (counts.get(id) ?? 0) + 1) }
      let out = text
      for (const secret of held) {
        if (!out.includes(secret)) continue
        out = out.split(secret).map((part, i) => { if (i > 0) hit('held-secret'); return part }).join('[redacted:held-secret]')
      }
      for (const { id, re } of PATTERNS) {
        out = out.replace(re, () => { hit(id); return `[redacted:${id}]` })
      }
      return { text: out, findings: [...counts].map(([pattern, count]) => ({ pattern, count })) }
    },
  }
}
