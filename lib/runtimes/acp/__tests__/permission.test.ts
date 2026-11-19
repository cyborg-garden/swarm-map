// @vitest-environment node
//
// The pure half of the ACP client: which option answers a permission request,
// and what the door is shown for a call.
import { describe, expect, it } from 'vitest'
import { classifyCall, insideFolder, outcomeAllows, pickOutcome, type PermissionOption, type PermissionOutcome } from '../permission.ts'

const KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always', 'something_else']

/** A seeded generator, so a failure can be run again. */
function rng(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
}
function randomOptions(r: () => number): PermissionOption[] {
  const n = Math.floor(r() * 6)
  return Array.from({ length: n }, (_, i) => ({ optionId: `o${i}`, kind: KINDS[Math.floor(r() * KINDS.length)] }))
}

/** The property: never an "always" option, and a yes only where an allow_once was offered and the door said yes. */
function violations(pick: (options: PermissionOption[], allow: boolean) => PermissionOutcome, seed = 7, runs = 2000): string[] {
  const r = rng(seed)
  const out: string[] = []
  for (let i = 0; i < runs; i++) {
    const options = randomOptions(r)
    const allow = r() < 0.5
    const got = pick(options, allow)
    const kind = got.outcome === 'selected' ? options.find((o) => o.optionId === got.optionId)?.kind : undefined
    if (kind === 'allow_always' || kind === 'reject_always') out.push(`picked ${kind}`)
    if (outcomeAllows(options, got) && !allow) out.push('a no was answered as a yes')
    if (allow && got.outcome === 'selected' && kind !== 'allow_once') out.push(`a yes was answered with ${kind}`)
  }
  return out
}

describe('pickOutcome', () => {
  it('[U:acp-once-only] over 2,000 random option lists, never picks an always option and never turns a no into a yes', () => {
    expect(violations(pickOutcome)).toEqual([])
  })

  it('[U:acp-once-only] must-fail: a picker that prefers "always" for a yes is caught by the same property', () => {
    const lax = (options: PermissionOption[], allow: boolean): PermissionOutcome => {
      const o = options.find((x) => x.kind === (allow ? 'allow_always' : 'reject_once')) ?? options.find((x) => x.kind === 'allow_once')
      return o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' }
    }
    expect(violations(lax).length).toBeGreaterThan(0)
  })

  it('[U:acp-once-only] with no once-option for the answer, it is cancelled', () => {
    expect(pickOutcome([{ optionId: 'a', kind: 'allow_always' }], true)).toEqual({ outcome: 'cancelled' })
    expect(pickOutcome([{ optionId: 'r', kind: 'reject_always' }], false)).toEqual({ outcome: 'cancelled' })
    expect(pickOutcome('not a list', true)).toEqual({ outcome: 'cancelled' })
  })
})

describe('classifyCall', () => {
  const kinds = { execute: 'bash', read: 'read', edit: 'edit' } as const
  const work = '/scratch'

  it('[U:acp-unclassified] refuses any kind the adapter does not map, and a kind ACP does not name', () => {
    for (const kind of ['other', 'fetch', 'search', 'think', 'delete', 'move', 'switch_mode', 'made-up', undefined]) {
      expect(classifyCall({ kind, rawInput: { command: 'ls' } }, kinds, work).ok, String(kind)).toBe(false)
    }
  })

  it('[U:acp-shell-input] a shell call is shown as its command, and its time limit if it has one; nothing else it carries', () => {
    expect(classifyCall({ kind: 'execute', rawInput: { command: 'ls', description: 'x', cwd: '/scratch/sub' } }, kinds, work))
      .toEqual({ ok: true, tool: 'bash', kind: 'execute', input: { command: 'ls' } })
    expect(classifyCall({ kind: 'execute', rawInput: { command: 'ls', timeout: 5 } }, kinds, work))
      .toEqual({ ok: true, tool: 'bash', kind: 'execute', input: { command: 'ls', timeout: 5 } })
    expect(classifyCall({ kind: 'execute', rawInput: {} }, kinds, work).ok).toBe(false)
  })

  it('[U:acp-scratch-folder] a path outside the folder anywhere in the call refuses it', () => {
    expect(classifyCall({ kind: 'edit', rawInput: { filepath: 'a.txt', files: [{ filePath: 'b', movePath: '/etc/x' }] } }, kinds, work).ok).toBe(false)
    expect(classifyCall({ kind: 'execute', rawInput: { command: 'ls', workdir: '/' } }, kinds, work).ok).toBe(false)
    expect(classifyCall({ kind: 'read', rawInput: {} }, kinds, work, { rawInput: { filePath: '/scratch/../etc' } }).ok).toBe(false)
    expect(insideFolder(work, '/scratch')).toBe(true)
    expect(insideFolder(work, '/scratch/a/../b')).toBe(true)
    expect(insideFolder(work, '/scratchpad')).toBe(false)
    expect(insideFolder(work, '..')).toBe(false)
  })
})
