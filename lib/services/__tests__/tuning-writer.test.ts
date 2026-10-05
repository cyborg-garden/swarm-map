/**
 * Tests for the tuning writer — the guarded path that edits a handful of
 * numeric keys (memory length, turn budget, compression) inside an agent's
 * config.yaml.
 *
 * The properties that matter on a live fleet:
 *  - only column-0 sections count (a nested `memory:` under platforms: or a
 *    `max_turns:` under goals: is never touched),
 *  - a no-op save is byte-identical,
 *  - a value the runtime would reject never reaches disk,
 *  - a file with duplicate sections is refused, not guessed at.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpDir = ''
const mockGet = vi.fn((id: string) =>
  id === 'h_test' ? { id: 'h_test', name: 'test', serviceName: 'hermes-test' } : undefined
)

vi.mock('@/lib/services', () => ({
  services: {
    harness: { get: (id: string) => mockGet(id) },
    audit: { append: vi.fn() },
  },
}))

vi.mock('@/lib/services/harness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/harness')>('@/lib/services/harness')
  return { ...actual, guessDataDir: vi.fn(() => tmpDir) }
})

import { readTuning, spliceTuning, applyTuningToHarness, TUNING_SPEC } from '../tuning-writer'
import { generateDefaultConfig } from '@/lib/templates/config-yaml'
import { FLEET_SHAPES } from './fleet-shapes'
import { services } from '@/lib/services'

const LIVE = [
  '# Hermes agent config',
  'model:',
  '  provider: openrouter',
  '  default: z-ai/glm-5.3',
  '',
  'compression:',
  '  enabled: true',
  '  threshold: 0.50   # fraction of context',
  '  protect_last_n: 20',
  '',
  'memory:',
  '  memory_enabled: true',
  '  memory_char_limit: 2200',
  '  user_char_limit: 1375',
  '',
  'agent:',
  '  max_turns: 60',
  '',
  'goals:',
  '  max_turns: 20',
  '',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '    memory:',
  '      memory_char_limit: 99',
  '',
].join('\n')

describe('readTuning', () => {
  it('reads only top-level sections', () => {
    expect(readTuning(LIVE)).toEqual({
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      maxTurns: 60,
      compressionThreshold: 0.5,
      protectLastN: 20,
    })
  })

  it('reports absent keys as null (the runtime default applies)', () => {
    expect(readTuning('model:\n  default: x\n')).toEqual({
      memoryCharLimit: null,
      userCharLimit: null,
      maxTurns: null,
      compressionThreshold: null,
      protectLastN: null,
    })
  })

  it('every runtime default in the spec is inside its own range', () => {
    for (const s of TUNING_SPEC) {
      expect(s.runtimeDefault).toBeGreaterThanOrEqual(s.min)
      expect(s.runtimeDefault).toBeLessThanOrEqual(s.max)
    }
  })
})

describe('spliceTuning', () => {
  it('a no-op edit is byte-identical', () => {
    const r = spliceTuning(LIVE, { memoryCharLimit: 2200, maxTurns: 60, compressionThreshold: 0.5 })
    expect(r).toEqual({ ok: true, text: LIVE })
  })

  it('a no-op edit over every fleet shape and the template is byte-identical', () => {
    const files = [...Object.values(FLEET_SHAPES), generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-6' })]
    for (const f of files) {
      const r = spliceTuning(f, readTuningAsEdits(f))
      expect(r).toEqual({ ok: true, text: f })
    }
  })

  it('changes only the targeted line, keeping the trailing comment', () => {
    const r = spliceTuning(LIVE, { memoryCharLimit: 6000, userCharLimit: 2000, compressionThreshold: 0.6 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const before = LIVE.split('\n')
    const after = r.text.split('\n')
    expect(after.length).toBe(before.length)
    const changed = after.flatMap((l, i) => (l !== before[i] ? [l] : []))
    expect(changed).toEqual([
      '  threshold: 0.6   # fraction of context',
      '  memory_char_limit: 6000',
      '  user_char_limit: 2000',
    ])
    // The nested platforms.discord.memory block and goals.max_turns are untouched.
    expect(r.text).toContain('      memory_char_limit: 99')
    expect(r.text).toContain('goals:\n  max_turns: 20')
    expect(readTuning(r.text).memoryCharLimit).toBe(6000)
  })

  it('inserts a missing key at the end of its section, at the section indent', () => {
    const src = 'memory:\n    memory_enabled: true\n\nagent:\n  verbose: false\n'
    const r = spliceTuning(src, { userCharLimit: 2000 })
    expect(r).toEqual({ ok: true, text: 'memory:\n    memory_enabled: true\n    user_char_limit: 2000\n\nagent:\n  verbose: false\n' })
  })

  it('appends a missing section after one blank line', () => {
    const r = spliceTuning('model:\n  default: x\n\n', { maxTurns: 120 })
    expect(r).toEqual({ ok: true, text: 'model:\n  default: x\n\nagent:\n  max_turns: 120\n' })
  })

  it('keeps CRLF line endings', () => {
    const src = 'memory:\r\n  memory_char_limit: 2200\r\n'
    const r = spliceTuning(src, { memoryCharLimit: 5000 })
    expect(r).toEqual({ ok: true, text: 'memory:\r\n  memory_char_limit: 5000\r\n' })
  })

  it('refuses a duplicate top-level section', () => {
    const r = spliceTuning('memory:\n  memory_char_limit: 1\nmemory:\n  memory_char_limit: 2\n', { memoryCharLimit: 3000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })

  it('refuses a flow-form section rather than rewriting it', () => {
    const src = 'memory: {memory_char_limit: 2200}\n'
    const r = spliceTuning(src, { memoryCharLimit: 3000 })
    expect(r.ok).toBe(false)
  })

  it.each([
    [{ memoryCharLimit: 100 }],
    [{ memoryCharLimit: 999999 }],
    [{ memoryCharLimit: 2200.5 }],
    [{ maxTurns: 0 }],
    [{ compressionThreshold: 1.5 }],
    [{ protectLastN: Number.NaN }],
    [{ memoryCharLimit: '6000' as unknown as number }],
  ])('rejects an out-of-range or malformed value %j', (edit) => {
    const r = spliceTuning(LIVE, edit)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  // Audit 2026-10-05: each of these used to "succeed" while the runtime read
  // something else, or produced YAML the agent cannot load.
  it.each([
    ['a duplicated key (YAML keeps the last copy)', 'memory:\n  memory_char_limit: 2200\n  memory_char_limit: 4000\n'],
    ['a list body', 'memory:\n  - memory_char_limit\n'],
    ['a key with no space after the colon', 'memory:\n  memory_char_limit:5000\n'],
    ['a value on the next line', 'memory:\n  memory_char_limit:\n    5000\n'],
    ['a quoted header beside the plain one', 'memory:\n  memory_enabled: true\n"memory":\n  user_char_limit: 1\n'],
    ['a quoted header alone', '"memory":\n  memory_enabled: true\n'],
    ['a byte-order mark', '﻿memory:\n  memory_enabled: true\n'],
  ])('refuses %s with 409 instead of writing', (_label, src) => {
    const r = spliceTuning(src, { memoryCharLimit: 3000 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(409)
  })

  it('reads the last copy of a duplicated key, as YAML does', () => {
    expect(readTuning('memory:\n  memory_char_limit: 2200\n  memory_char_limit: 4000\n').memoryCharLimit).toBe(4000)
  })

  it('null removes the key so the runtime default applies', () => {
    const r = spliceTuning(LIVE, { userCharLimit: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toBe(LIVE.replace('  user_char_limit: 1375\n', ''))
    expect(readTuning(r.text).userCharLimit).toBeNull()
  })

  it('null on an absent key is a no-op', () => {
    const src = 'memory:\n  memory_enabled: true\n'
    expect(spliceTuning(src, { userCharLimit: null })).toEqual({ ok: true, text: src })
  })

  // Audit round 2: an empty `memory:` loads as None and silently disables
  // hermes memory, so removing a section's last key removes the section.
  it('removing the last key of a section removes the section', () => {
    const src = 'model: x\n\nmemory:\n  # tuned 2026-10\n  memory_char_limit: 3000\n\nagent:\n  verbose: false\n'
    expect(spliceTuning(src, { memoryCharLimit: null })).toEqual({ ok: true, text: 'model: x\n\nagent:\n  verbose: false\n' })
  })

  it('set then clear round-trips to the original file', () => {
    const src = 'model:\n  default: x\n'
    const set = spliceTuning(src, { maxTurns: 120 })
    expect(set.ok).toBe(true)
    if (!set.ok) return
    expect(spliceTuning(set.text, { maxTurns: null })).toEqual({ ok: true, text: src })
  })

  it('refuses a quoted value that continues onto later lines', () => {
    const src = 'agent:\n  system_prompt: "be brief\n  max_turns: 7"\n  foo: 1\n'
    const r = spliceTuning(src, { maxTurns: 10 })
    expect(r.ok).toBe(false)
  })

  it('accepts closed quoted values, including escapes', () => {
    const src = 'agent:\n  a: "x \\" y"\n  b: \'it\'\'s\'\n  max_turns: 7\n'
    expect(spliceTuning(src, { maxTurns: 10 })).toEqual({ ok: true, text: src.replace('max_turns: 7', 'max_turns: 10') })
  })

  it('finds a key written with a space before the colon', () => {
    const src = 'agent:\n  max_turns : 5\n'
    expect(readTuning(src).maxTurns).toBe(5)
    expect(spliceTuning(src, { maxTurns: 9 })).toEqual({ ok: true, text: 'agent:\n  max_turns: 9\n' })
  })

  it('rounds float noise before writing', () => {
    const r = spliceTuning(LIVE, { compressionThreshold: 0.1 + 0.2 })
    expect(r.ok && r.text).toContain('  threshold: 0.3   # fraction of context')
  })

  it('rejects an unknown key', () => {
    const r = spliceTuning(LIVE, { approvals: 1 } as never)
    expect(r.ok).toBe(false)
  })
})

describe('applyTuningToHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-tuning-writer-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const cfg = () => path.join(tmpDir, 'config.yaml')

  it('writes, audits, and reads back', () => {
    fs.writeFileSync(cfg(), LIVE)
    const r = applyTuningToHarness('h_test', { memoryCharLimit: 6000 }, { who: 'api' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.values.memoryCharLimit).toBe(6000)
    expect(readTuning(fs.readFileSync(cfg(), 'utf-8')).memoryCharLimit).toBe(6000)
    expect(services.audit.append).toHaveBeenCalledTimes(1)
  })

  it('a no-op save does not touch the file or the audit log', () => {
    fs.writeFileSync(cfg(), LIVE)
    const mtime = fs.statSync(cfg()).mtimeMs
    const r = applyTuningToHarness('h_test', { memoryCharLimit: 2200 }, { who: 'api' })
    expect(r).toMatchObject({ ok: true, unchanged: true })
    expect(fs.statSync(cfg()).mtimeMs).toBe(mtime)
    expect(services.audit.append).not.toHaveBeenCalled()
  })

  it('refuses with 409 when the file changed since the caller read it', () => {
    fs.writeFileSync(cfg(), LIVE)
    const r = applyTuningToHarness('h_test', { memoryCharLimit: 6000 }, { who: 'api', expected: { memoryCharLimit: 5000 } })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(fs.readFileSync(cfg(), 'utf-8')).toBe(LIVE)
  })

  it('404s on a missing config.yaml rather than creating one', () => {
    const r = applyTuningToHarness('h_test', { memoryCharLimit: 6000 }, { who: 'api' })
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(fs.existsSync(cfg())).toBe(false)
  })

  it('404s on an unknown harness', () => {
    expect(applyTuningToHarness('nope', { maxTurns: 10 }, { who: 'api' })).toMatchObject({ ok: false, status: 404 })
  })
})

function readTuningAsEdits(text: string) {
  const v = readTuning(text)
  return Object.fromEntries(Object.entries(v).filter(([, n]) => n !== null)) as Record<string, number>
}
