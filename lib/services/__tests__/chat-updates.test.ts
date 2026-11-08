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

import { readChatUpdateLevel, spliceChatUpdateLevel, applyChatUpdatesToHarness, readHarnessChatUpdates, hasPlatformOverride } from '../chat-updates'
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
    const bare = OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: off').replace('interim_assistant_messages: true', 'interim_assistant_messages: false\n  long_running_notifications: no')
    expect(readChatUpdateLevel(bare)).toBe('quiet')
    expect(readChatUpdateLevel(bare.replace('tool_progress: off', 'tool_progress: "off"'))).toBe('quiet')
    expect(readChatUpdateLevel(bare.replace('tool_progress: off', 'tool_progress: false'))).toBe('quiet')
  })

  it('reports custom for a mix no level writes', () => {
    expect(readChatUpdateLevel(OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: verbose'))).toBe('custom')
    expect(readChatUpdateLevel(OLD_TEMPLATE.replace('interim_assistant_messages: true', 'interim_assistant_messages: false'))).toBe('custom')
  })

  it('reads absent keys as hermes\'s Discord defaults (every step)', () => {
    expect(readChatUpdateLevel('model:\n  provider: x\n')).toBe('all')
    // Live shapes: only one of the keys set.
    expect(readChatUpdateLevel('display:\n  interim_assistant_messages: true\n')).toBe('all')
    expect(readChatUpdateLevel('display:\n  tool_progress: all\n')).toBe('all')
  })

  it('counts long_running_notifications: generic as on, as hermes does', () => {
    expect(readChatUpdateLevel(OLD_TEMPLATE.replace('  streaming: true', '  streaming: true\n  long_running_notifications: generic'))).toBe('all')
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
      OLD_TEMPLATE.replace('tool_progress: all', 'tool_progress: "off"')
        .replace('interim_assistant_messages: true', 'interim_assistant_messages: false')
        .replace('  streaming: true', '  streaming: true\n  long_running_notifications: false'),
    )
    expect(readChatUpdateLevel(out)).toBe('quiet')
  })

  it('is byte-identical on a no-op save', () => {
    const full = OLD_TEMPLATE.replace('  streaming: true', '  streaming: true\n  long_running_notifications: true')
    expect(splice(full, 'all')).toBe(full)
    // An absent key is written out, even when it matches hermes's default:
    // the defaults differ per surface, and the level must hold on all of them.
    expect(splice(OLD_TEMPLATE, 'all')).toBe(full)
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
    expect(out).toBe('display:\n  compact: false\n  tool_progress: "off"\n  interim_assistant_messages: false\n  long_running_notifications: false\n\nagent:\n  max_turns: 60\n')
  })

  it('appends a display section when there is none', () => {
    const out = splice('model:\n  provider: x\n', 'quiet')
    expect(out).toBe('model:\n  provider: x\n\ndisplay:\n  tool_progress: "off"\n  interim_assistant_messages: false\n  long_running_notifications: false\n')
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

// The display block on mare, read on the Mini 2026-11-09 (trimmed).
const MARE_DISPLAY = [
  'display:',
  '  compact: false',
  "  personality: ''",
  '  user_message_preview:',
  '    first_lines: 2',
  '    last_lines: 2',
  '  interim_assistant_messages: true',
  '  tool_progress_command: false',
  '  platforms:',
  '    telegram:',
  '      streaming: true',
  '    discord:',
  '      streaming: false',
  '  runtime_footer:',
  '    enabled: false',
  '    fields:',
  '      - model',
  '      - context_pct',
  '  tool_progress: all',
  '  long_running_notifications: true',
  '',
].join('\n')

describe('per-platform overrides', () => {
  it('is false for the live mare shape (platforms only sets streaming)', () => {
    expect(hasPlatformOverride(MARE_DISPLAY)).toBe(false)
    expect(hasPlatformOverride(MARE_DISPLAY.replace('  platforms:', '  tool_progress_overrides: {}\n  platforms:'))).toBe(false)
  })

  it('flags a per-platform tool_progress, interim or heartbeat value', () => {
    for (const key of ['tool_progress: all', 'interim_assistant_messages: true', 'long_running_notifications: true']) {
      expect(hasPlatformOverride(MARE_DISPLAY.replace('      streaming: false', `      ${key}`)), key).toBe(true)
    }
  })

  it('flags a non-empty tool_progress_overrides, inline or block', () => {
    expect(hasPlatformOverride(MARE_DISPLAY.replace('  platforms:', '  tool_progress_overrides: {discord: all}\n  platforms:'))).toBe(true)
    expect(hasPlatformOverride(MARE_DISPLAY.replace('  platforms:', '  tool_progress_overrides:\n    discord: all\n  platforms:'))).toBe(true)
  })

  it('setting a level leaves a nested override in place and still reports it', () => {
    const withOverride = MARE_DISPLAY.replace('      streaming: false', '      tool_progress: all')
    const out = splice(withOverride, 'quiet')
    expect(readChatUpdateLevel(out)).toBe('quiet')
    expect(hasPlatformOverride(out)).toBe(true)
  })

  it('splices the live mare shape cleanly', () => {
    const out = splice(MARE_DISPLAY, 'quiet')
    expect(readChatUpdateLevel(out)).toBe('quiet')
    expect(out.split('\n').filter((l) => l.includes('tool_progress:')).length).toBe(1)
    expect(out).toContain('      - context_pct')
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
    expect(r).toEqual({ ok: true, unchanged: false, level: 'quiet', overridden: false })
    expect(readHarnessChatUpdates('h_test')).toEqual({ ok: true, level: 'quiet', overridden: false })
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({ what: 'harness.chat-updates.update', meta: { from: 'all', to: 'quiet' } }))
  })

  it('does not touch the file or audit when nothing changes', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), OLD_TEMPLATE.replace('  streaming: true', '  streaming: true\n  long_running_notifications: true'))
    const r = applyChatUpdatesToHarness('h_test', 'all', { who: 'test' })
    expect(r).toEqual({ ok: true, unchanged: true, level: 'all', overridden: false })
    expect(auditAppend).not.toHaveBeenCalled()
  })

  it('rejects an unknown level before reading anything', () => {
    expect(applyChatUpdatesToHarness('h_test', 'loud', { who: 'test' })).toMatchObject({ ok: false, status: 400 })
  })

  it('never creates config.yaml', () => {
    expect(applyChatUpdatesToHarness('h_test', 'quiet', { who: 'test' })).toMatchObject({ ok: false, status: 404 })
    expect(fs.existsSync(path.join(tmpDir, 'config.yaml'))).toBe(false)
  })

  it('returns a failure instead of throwing when the file cannot be written', () => {
    const cfg = path.join(tmpDir, 'config.yaml')
    fs.writeFileSync(cfg, OLD_TEMPLATE)
    fs.chmodSync(cfg, 0o444)
    try {
      expect(applyChatUpdatesToHarness('h_test', 'quiet', { who: 'test' })).toMatchObject({ ok: false, status: 500 })
      expect(fs.readFileSync(cfg, 'utf-8')).toBe(OLD_TEMPLATE)
    } finally {
      fs.chmodSync(cfg, 0o644)
    }
  })

  it('404s an unknown harness', () => {
    expect(applyChatUpdatesToHarness('h_nope', 'quiet', { who: 'test' })).toMatchObject({ ok: false, status: 404 })
  })
})
