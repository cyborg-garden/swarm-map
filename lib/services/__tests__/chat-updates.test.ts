/**
 * Tests for chat updates — the one setting for how much of an agent's working
 * shows in chat (config.yaml display.tool_progress +
 * display.interim_assistant_messages).
 *
 * What matters on a live fleet:
 *  - only the top-level display: keys change; a nested display.platforms
 *    block and every other line are left alone,
 *  - a no-op save is byte-identical,
 *  - the level is read the way hermes normalises it (bare `off` is a YAML
 *    boolean),
 *  - new agents start quiet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpDir = ''
const mockGet = vi.fn((id: string) =>
  id === 'h_test' ? { id: 'h_test', name: 'test', serviceName: 'hermes-test' } : undefined
)
const auditAppend = vi.fn()

vi.mock('@/lib/services', () => ({
  services: {
    harness: { get: (id: string) => mockGet(id) },
    audit: { append: (...a: unknown[]) => auditAppend(...a) },
  },
}))

vi.mock('@/lib/services/harness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/harness')>('@/lib/services/harness')
  return { ...actual, guessDataDir: vi.fn(() => tmpDir) }
})

import { readChatUpdateLevel, spliceChatUpdateLevel, applyChatUpdatesToHarness, readHarnessChatUpdates } from '../chat-updates'
import { generateDefaultConfig } from '@/lib/templates/config-yaml'
import { FLEET_SHAPES } from './fleet-shapes'

// The display block every agent deployed before this change carries.
const OLD_TEMPLATE = [
  'model:',
  '  provider: openrouter',
  '',
  '# --- Display ---',
  'display:',
  '  compact: false',
  '  tool_progress: all',
  '  interim_assistant_messages: true',
  '  streaming: true',
  '',
  'platform_toolsets:',
  '  discord: [hermes-discord]',
  '',
].join('\n')

function splice(text: string, level: 'quiet' | 'some' | 'all'): string {
  const r = spliceChatUpdateLevel(text, level)
  if (!r.ok) throw new Error(r.error)
  return r.text
}

describe('readChatUpdateLevel', () => {
  it('reads the old template as all', () => {
    expect(readChatUpdateLevel(OLD_TEMPLATE)).toBe('all')
  })

  it('treats bare off and quoted "off" alike, as hermes does', () => {
    const bare = OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: off').replace('interim_assistant_messages: true', 'interim_assistant_messages: false')
    expect(readChatUpdateLevel(bare)).toBe('quiet')
    expect(readChatUpdateLevel(bare.replace('tool_progress: off', 'tool_progress: "off"'))).toBe('quiet')
    expect(readChatUpdateLevel(bare.replace('tool_progress: off', 'tool_progress: false'))).toBe('quiet')
  })

  it('reports custom for a mix no level writes', () => {
    expect(readChatUpdateLevel(OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: verbose'))).toBe('custom')
    expect(readChatUpdateLevel(OLD_TEMPLATE.replace('interim_assistant_messages: true', 'interim_assistant_messages: false'))).toBe('custom')
  })

  it('reports null when neither key is set', () => {
    expect(readChatUpdateLevel('model:\n  provider: x\n')).toBeNull()
  })

  it('ignores a nested display.platforms override when reading the global level', () => {
    const nested = OLD_TEMPLATE.replace(
      '  streaming: true',
      '  streaming: true\n  platforms:\n    discord:\n      tool_progress: new',
    )
    expect(readChatUpdateLevel(nested)).toBe('all')
  })
})

describe('spliceChatUpdateLevel', () => {
  it('rewrites only the two values', () => {
    const out = splice(OLD_TEMPLATE, 'quiet')
    expect(out).toBe(
      OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: "off"').replace('interim_assistant_messages: true', 'interim_assistant_messages: false'),
    )
    expect(readChatUpdateLevel(out)).toBe('quiet')
  })

  it('is byte-identical on a no-op save', () => {
    expect(splice(OLD_TEMPLATE, 'all')).toBe(OLD_TEMPLATE)
    const quiet = splice(OLD_TEMPLATE, 'quiet')
    expect(splice(quiet, 'quiet')).toBe(quiet)
  })

  it('round-trips every level', () => {
    for (const level of ['quiet', 'some', 'all'] as const) {
      expect(readChatUpdateLevel(splice(OLD_TEMPLATE, level))).toBe(level)
    }
  })

  it('adds the keys to an existing display section that lacks them', () => {
    const out = splice('display:\n  compact: false\n\nagent:\n  max_turns: 60\n', 'quiet')
    expect(out).toBe('display:\n  compact: false\n  tool_progress: "off"\n  interim_assistant_messages: false\n\nagent:\n  max_turns: 60\n')
  })

  it('appends a display section when there is none', () => {
    const out = splice('model:\n  provider: x\n', 'quiet')
    expect(out).toBe('model:\n  provider: x\n\ndisplay:\n  tool_progress: "off"\n  interim_assistant_messages: false\n')
    expect(readChatUpdateLevel(out)).toBe('quiet')
  })

  it('leaves a nested display.platforms block untouched', () => {
    const nested = OLD_TEMPLATE.replace(
      '  streaming: true',
      '  streaming: true\n  platforms:\n    discord:\n      tool_progress: new',
    )
    const out = splice(nested, 'quiet')
    expect(out).toContain('      tool_progress: new')
    expect(out).toContain('  tool_progress: "off"')
  })

  it('refuses a duplicated display section', () => {
    const r = spliceChatUpdateLevel(OLD_TEMPLATE + 'display:\n  compact: true\n', 'quiet')
    expect(r.ok).toBe(false)
  })

  it('works on every real fleet shape', () => {
    for (const [name, text] of Object.entries(FLEET_SHAPES)) {
      const r = spliceChatUpdateLevel(text, 'quiet')
      expect(r.ok, name).toBe(true)
      if (r.ok) expect(readChatUpdateLevel(r.text), name).toBe('quiet')
    }
  })
})

describe('deploy template', () => {
  it('starts new agents quiet', () => {
    const cfg = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-6' })
    expect(readChatUpdateLevel(cfg)).toBe('quiet')
  })
})

describe('applyChatUpdatesToHarness', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-updates-'))
    auditAppend.mockClear()
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('writes the level and audits it', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), OLD_TEMPLATE)
    const r = applyChatUpdatesToHarness('h_test', 'quiet', { who: 'test' })
    expect(r).toEqual({ ok: true, unchanged: false, level: 'quiet' })
    expect(readHarnessChatUpdates('h_test')).toEqual({ ok: true, level: 'quiet' })
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({ what: 'harness.chat-updates.update', meta: { from: 'all', to: 'quiet' } }))
  })

  it('does not touch the file or audit when nothing changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), OLD_TEMPLATE)
    const r = applyChatUpdatesToHarness('h_test', 'all', { who: 'test' })
    expect(r).toEqual({ ok: true, unchanged: true, level: 'all' })
    expect(auditAppend).not.toHaveBeenCalled()
  })

  it('rejects an unknown level before reading anything', () => {
    expect(applyChatUpdatesToHarness('h_test', 'loud', { who: 'test' })).toMatchObject({ ok: false, status: 400 })
  })

  it('never creates config.yaml', () => {
    expect(applyChatUpdatesToHarness('h_test', 'quiet', { who: 'test' })).toMatchObject({ ok: false, status: 404 })
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
  })

  it('404s an unknown harness', () => {
    expect(applyChatUpdatesToHarness('h_nope', 'quiet', { who: 'test' })).toMatchObject({ ok: false, status: 404 })
  })
})
