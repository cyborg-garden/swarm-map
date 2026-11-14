// @vitest-environment node
//
// The sanitizer's patterns, one at a time. The door tests only ever paste one
// kind of secret, so without this any other pattern could be deleted unseen.
import { describe, expect, it } from 'vitest'
import { toRoom } from '../../core/normalise.ts'
import { createSanitizer } from '../sanitizer.ts'

const ctx = { posture: 'team' as const, room: toRoom('r-general') }
// Minted here so no secret-shaped string is ever committed.
const SHAPES: [string, string][] = [
  ['private-key', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIabc\n-----END ' + 'RSA PRIVATE KEY-----'],
  ['private-key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3Blbn, and then the paste was cut off'],
  ['anthropic-key', ['sk', 'ant', 'api03', 'A1b2'.repeat(6)].join('-')],
  ['api-key', 'sk-' + 'proj' + 'Z9y8'.repeat(6)],
  ['github-token', 'ghp_' + 'q7W3'.repeat(9)],
  ['github-token', 'github_' + 'pat_' + '11AB'.repeat(8)],
  ['slack-token', ['xoxb', '1234567890', 'abcdefghijkl'].join('-')],
  ['aws-access-key', 'AKIA' + 'ABCDEFGH'.repeat(2)],
  ['notion-token', 'ntn' + '_' + 'n0Ti'.repeat(8)],
]

describe('sanitizer patterns', () => {
  it.each(SHAPES)('[U:sanitizer] %s is redacted, in both directions, and named in the findings', (id, secret) => {
    const sanitizer = createSanitizer()
    for (const direction of ['inbound', 'outbound'] as const) {
      const out = sanitizer.run(direction, `before ${secret} after`, ctx)
      expect(out.text).not.toContain(secret.split('\n')[0])
      expect(out.text).toContain(`[redacted:${id}]`)
      expect(out.text.startsWith('before ')).toBe(true)
      expect(out.findings).toEqual([{ pattern: id, count: 1 }])
    }
  })

  it('[U:sanitizer] a secret the sidecar holds is redacted whatever its shape, and counted each time', () => {
    const out = createSanitizer({ extraSecrets: ['plain-looking-value'] }).run('outbound', 'a plain-looking-value b plain-looking-value', ctx)
    expect(out.text).toBe('a [redacted:held-secret] b [redacted:held-secret]')
    expect(out.findings).toEqual([{ pattern: 'held-secret', count: 2 }])
  })

  it('[U:sanitizer] positive control: ordinary text is left alone', () => {
    const text = 'the task-force met at skiing lodge 42; see ghp for notes'
    expect(createSanitizer().run('outbound', text, ctx)).toEqual({ text, findings: [] })
  })
})
