// @vitest-environment node
//
// A tool call as the door and the gate see it: its hash, how it is shown to a
// person, and whether a path stays in the scratch folder.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rng } from '../../../conformance/gen.ts'
import { callHash, confine, MAX_SHOWN_CHARS, readShown, showInput, type PathLookup } from '../tools/call.ts'

const shown = (input: unknown, max?: number): string => {
  const r = showInput(input, max)
  if ('problem' in r) throw new Error(r.problem)
  return r.text
}

describe('the hash of a tool call', () => {
  it('[U:call-hash] is the same however the keys are ordered, and differs when anything in the call differs', () => {
    const base = callHash('bash', { command: 'ls', timeout: 60 })
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(callHash('bash', { timeout: 60, command: 'ls' })).toBe(base)
    for (const [tool, input] of [
      ['bash', { command: 'ls ', timeout: 60 }], ['bash', { command: 'ls', timeout: 61 }], ['bash', { command: 'ls' }],
      ['sh', { command: 'ls', timeout: 60 }], ['bash', { command: 'ls', timeout: 60, extra: null }], ['bash', { command: 'ls​', timeout: 60 }],
    ] as const) expect(callHash(tool, input), JSON.stringify(input)).not.toBe(base)
  })

  it('[U:call-hash] does not let the tool name and the input run together', () => {
    expect(callHash('a', { b: 1 })).not.toBe(callHash('a{"b":1}', undefined))
    expect(callHash('bash', 'x')).not.toBe(callHash('bash', ['x']))
  })
})

describe('a call written down for a person', () => {
  it('[U:call-shown] is plain printable text that pings nobody and cannot break out of its block', () => {
    const text = shown({ command: 'echo @everyone <@123> `rm` ‮gnp.exe\u0007 café 😀\nnext' })
    expect(text).toMatch(/^[\x20-\x7e]+$/)
    for (const ch of ['@', '<', '`']) expect(text).not.toContain(ch)
    expect(text).toContain('\\u0040everyone')
    expect(text).toContain('\\u202e')
  })

  it('[U:call-shown] reads back as exactly the call, so what is shown is what is hashed', () => {
    const r = rng(20261116)
    const alphabet = ['a', 'Z', '0', ' ', '"', '\\', '/', '@', '<', '>', '`', '\n', '\t', '\u0000', '\u001b', 'é', '​', '‮', '😀', '\ud800', '$', '{', '}', '&']
    const word = (): string => Array.from({ length: r.int(12) }, () => r.pick(alphabet)).join('')
    const value = (depth: number): unknown => {
      const kind = r.int(depth > 2 ? 4 : 6)
      if (kind === 0) return word()
      if (kind === 1) return r.int(1000) - 500
      if (kind === 2) return r.bool()
      if (kind === 3) return null
      if (kind === 4) return Array.from({ length: r.int(4) }, () => value(depth + 1))
      return Object.fromEntries(Array.from({ length: r.int(4) }, () => [word(), value(depth + 1)]))
    }
    for (let i = 0; i < 400; i++) {
      const input = value(0)
      const text = shown(input, 100_000)
      expect(text).toMatch(/^[\x20-\x7e]*$/)
      expect(/[@<`]/.test(text)).toBe(false)
      expect(callHash('t', readShown(text))).toBe(callHash('t', input))
    }
  })

  it('[U:call-shown] refuses a call that is too long to show whole, and one that cannot be written down', () => {
    const fits = { command: 'x'.repeat(MAX_SHOWN_CHARS - 14) }
    expect(shown(fits)).toHaveLength(MAX_SHOWN_CHARS)
    expect(showInput({ command: 'x'.repeat(MAX_SHOWN_CHARS - 13) })).toEqual({ problem: 'the call is too long to show in full' })
    // An escape counts for what it is written as, not for the one character it stands for.
    expect(showInput({ command: '@'.repeat(300) })).toEqual({ problem: 'the call is too long to show in full' })
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(showInput(loop)).toEqual({ problem: 'the call cannot be written down' })
    expect(showInput({ n: BigInt(1) })).toEqual({ problem: 'the call cannot be written down' })
  })
})

describe('a path given to a file tool', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarmlab-confine-')))
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'work')
  mkdirSync(path.join(root, 'sub'), { recursive: true })
  writeFileSync(path.join(root, 'sub', 'inside.txt'), 'in')
  writeFileSync(path.join(base, 'outside.txt'), 'out')
  mkdirSync(path.join(base, 'elsewhere'))
  symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'link-to-file'))
  symlinkSync(path.join(base, 'elsewhere'), path.join(root, 'link-to-dir'))
  symlinkSync(path.join(base, 'not-there-yet.txt'), path.join(root, 'link-to-nowhere'))
  symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'))
  symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'))
  symlinkSync(path.join(root, 'sub'), path.join(root, 'link-inside'))
  symlinkSync(root, path.join(base, 'alias'))

  const fs: PathLookup = {
    realpath: (p) => realpathSync(p),
    exists: (p) => { try { lstatSync(p); return true } catch { return false } },
  }
  const where = (given: unknown, at: string = root) => confine(at, given, fs)

  it('[U:workspace-path] is handed back as a full, plain path when it stays inside', () => {
    expect(where('sub/inside.txt')).toEqual({ path: path.join(root, 'sub', 'inside.txt') })
    expect(where(path.join(root, 'sub', 'inside.txt'))).toEqual({ path: path.join(root, 'sub', 'inside.txt') })
    expect(where('')).toEqual({ path: root })
    expect(where('.')).toEqual({ path: root })
    expect(where('sub/../sub/./new.txt')).toEqual({ path: path.join(root, 'sub', 'new.txt') })
    expect(where('new-dir/deeper/new.txt')).toEqual({ path: path.join(root, 'new-dir', 'deeper', 'new.txt') })
    // A link that stays inside is followed, and what is handed back is where it leads.
    expect(where('link-inside/inside.txt')).toEqual({ path: path.join(root, 'sub', 'inside.txt') })
    // A name that only looks special is a name.
    expect(where('~/x')).toEqual({ path: path.join(root, '~', 'x') })
    // The folder may itself be reached through a link.
    expect(where('sub/inside.txt', path.join(base, 'alias'))).toEqual({ path: path.join(root, 'sub', 'inside.txt') })
  })

  it.each([
    ['two dots', '../outside.txt'],
    ['two dots past a folder', 'sub/../../outside.txt'],
    ['a full path', path.join(base, 'outside.txt')],
    ['the folder above', '..'],
    ['the root of the disk', '/'],
    ['a folder whose name only starts the same', path.join(base, 'work-other', 'x')],
    ['a link to a file outside', 'link-to-file'],
    ['a link to a folder outside', 'link-to-dir/new.txt'],
    ['a link back up and out', 'link-inside/../../outside.txt'],
  ])('[U:workspace-path] is refused when it leaves by %s', (_how, given) => {
    expect(where(given)).toEqual({ problem: 'the path is outside the scratch folder' })
  })

  it('[U:workspace-path] is refused when it goes through a link that leads nowhere, or round in a loop', () => {
    expect(where('link-to-nowhere')).toEqual({ problem: 'the path goes through a link that cannot be followed' })
    expect(where('link-to-nowhere/x')).toEqual({ problem: 'the path goes through a link that cannot be followed' })
    expect(where('loop-a')).toEqual({ problem: 'the path goes through a link that cannot be followed' })
    expect(existsSync(path.join(base, 'not-there-yet.txt'))).toBe(false)
  })

  it('[U:workspace-path] is refused when it is not a path, or there is no scratch folder', () => {
    for (const given of [undefined, null, 7, {}, ['x'], 'a\0b']) expect(where(given)).toEqual({ problem: 'that is not a path' })
    for (const at of ['', 'relative/work', path.join(base, 'no-such-folder'), undefined as never]) {
      expect(confine(at, 'x', fs)).toEqual({ problem: 'there is no scratch folder' })
    }
  })
})
