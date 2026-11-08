import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { readScalar, sectionBody, spliceScalars, tuningDataDir } from '@/lib/services/tuning-writer'
import { CHAT_UPDATE_LEVELS, LEVEL_KEYS, isChatUpdateLevel, type ChatUpdateLevel } from '@/lib/chat-update-levels'

export { CHAT_UPDATE_LEVELS, DEFAULT_CHAT_UPDATE_LEVEL, isChatUpdateLevel, type ChatUpdateLevel } from '@/lib/chat-update-levels'

/**
 * Chat updates: how much of an agent's working shows up in chat.
 *
 * One level, written as three keys in config.yaml's `display:` section
 * (lib/chat-update-levels.ts LEVEL_KEYS):
 *   quiet → tool_progress "off", interim_assistant_messages false,
 *           long_running_notifications false. Only questions, approval
 *           prompts and the final answer. Hermes sends clarify and approval
 *           prompts on their own path, so none of these keys hides them.
 *   some  → "new", true, true
 *   all   → "all", true, true
 *
 * "off" is quoted: bare `off` is a YAML 1.1 boolean. Hermes copes with that,
 * but the quoted form reads the same to every parser.
 *
 * Hermes reads `display.platforms.<platform>.<key>` and
 * `display.tool_progress_overrides.<platform>` BEFORE these top-level keys,
 * so the reader reports `overridden` when any are present; the level shown
 * is then not what that surface does. The writer leaves them alone.
 *
 * Known edge cases, left as they are because no generated config has them:
 * a quoted empty or "null" value reads as unset (hermes reads it as a
 * string), and a per-platform `null` is flagged as an override (hermes
 * skips it). Both only affect what the card says, never what is written.
 *
 * Hermes re-reads config.yaml when it changes, so a new level applies from
 * the agent's next message with no restart.
 */

const KEY = { toolProgress: 'tool_progress', interim: 'interim_assistant_messages', heartbeat: 'long_running_notifications' } as const

// Same normalisation hermes applies (gateway/display_config.py _normalise).
// An empty, `null` or `~` value is "not set" to hermes (it falls back to the
// surface default), not false.
const isUnset = (raw: string | null): raw is null => raw === null || ['', 'null', '~'].includes(raw.trim().toLowerCase())

function normToolProgress(raw: string | null): string | null {
  if (isUnset(raw)) return null
  const v = raw.trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(v)) return 'off'
  if (['true', '1', 'yes', 'on'].includes(v)) return 'all'
  return ['new', 'all', 'verbose', 'log'].includes(v) ? v : 'all'
}

function normBool(raw: string | null, alsoTrue: string[] = []): boolean | null {
  if (isUnset(raw)) return null
  return ['true', '1', 'yes', 'on', 'raw', 'verbose', ...alsoTrue].includes(raw.trim().toLowerCase())
}

/**
 * True when display: carries a per-platform value for any of the three keys
 * (under `platforms:`, or a non-empty `tool_progress_overrides`), which
 * hermes applies instead of the top-level level.
 */
export function hasPlatformOverride(text: string): boolean {
  const body = sectionBody(text, 'display')
  if (!body) return false
  const content = body.filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
  if (content.length === 0) return false
  const top = content[0].length - content[0].trimStart().length
  const keys = new Set<string>(Object.values(KEY))
  // A key written inline, e.g. `discord: {tool_progress: all}` or
  // `platforms: {discord: {tool_progress: all}}`.
  const inlineKey = new RegExp(`[{,]\\s*["']?(${Object.values(KEY).join('|')})["']?\\s*:`)
  let parent = ''
  for (const l of content) {
    const indent = l.length - l.trimStart().length
    const m = l.trimStart().match(/^([\w-]+)\s*:\s*(.*)$/)
    if (indent <= top) {
      parent = m?.[1] ?? ''
      const v = (m?.[2] ?? '').replace(/\s+#.*$/, '').trim()
      if (parent === 'tool_progress_overrides' && !['', '{}', 'null', '~'].includes(v)) return true
      if (parent === 'platforms' && inlineKey.test(v)) return true
      continue
    }
    if (parent === 'tool_progress_overrides') return true
    if (parent === 'platforms' && m && (keys.has(m[1]) || inlineKey.test(m[2].replace(/\s+#.*$/, '')))) return true
  }
  return false
}

export type ChatUpdateReading = ChatUpdateLevel | 'custom' | 'unset'
export type ChatUpdateState = { level: ChatUpdateReading; overridden: boolean }

/**
 * The level config.yaml expresses. 'custom' = a mix no level writes.
 * 'unset' = at least one of the three keys is absent: hermes then uses its
 * per-surface defaults (every step on Discord, almost nothing on Signal), so
 * the file alone does not say what the agent does.
 */
export function readChatUpdateLevel(text: string): ChatUpdateReading {
  const tp = normToolProgress(readScalar(text, 'display', KEY.toolProgress))
  const interim = normBool(readScalar(text, 'display', KEY.interim))
  const heartbeat = normBool(readScalar(text, 'display', KEY.heartbeat), ['generic'])
  if (tp === null || interim === null || heartbeat === null) return 'unset'
  for (const level of CHAT_UPDATE_LEVELS) {
    const k = LEVEL_KEYS[level]
    if (tp === k.toolProgress && interim === k.interim && heartbeat === k.heartbeat) return level
  }
  return 'custom'
}

export function readChatUpdateState(text: string): ChatUpdateState {
  return { level: readChatUpdateLevel(text), overridden: hasPlatformOverride(text) }
}

export function spliceChatUpdateLevel(text: string, level: ChatUpdateLevel) {
  const k = LEVEL_KEYS[level]
  return spliceScalars(text, [
    { section: 'display', key: KEY.toolProgress, value: `"${k.toolProgress}"`, same: (cur) => cur === k.toolProgress },
    { section: 'display', key: KEY.interim, value: String(k.interim), same: (cur) => cur === String(k.interim) },
    // `generic` is on too (hermes words the message generically); keep it.
    { section: 'display', key: KEY.heartbeat, value: String(k.heartbeat), same: (cur) => cur === String(k.heartbeat) || (k.heartbeat && cur.trim().toLowerCase() === 'generic') },
  ])
}

type Fail = { ok: false; status: 400 | 404 | 409 | 500; error: string }

function configPathFor(harnessId: string): { ok: true; configPath: string } | Fail {
  const harness = services.harness.get(harnessId)
  if (!harness) return { ok: false, status: 404, error: 'Harness not found' }
  return { ok: true, configPath: path.join(tuningDataDir(harness), 'config.yaml') }
}

export function readHarnessChatUpdates(harnessId: string): ({ ok: true } & ChatUpdateState) | Fail {
  const p = configPathFor(harnessId)
  if (!p.ok) return p
  try {
    return { ok: true, ...readChatUpdateState(fs.readFileSync(p.configPath, 'utf-8')) }
  } catch {
    return { ok: false, status: 404, error: 'config.yaml not found for this harness' }
  }
}

export function applyChatUpdatesToHarness(
  harnessId: string,
  level: unknown,
  opts: { who: string },
): { ok: true; unchanged: boolean; level: ChatUpdateLevel; overridden: boolean } | Fail {
  if (!isChatUpdateLevel(level)) {
    return { ok: false, status: 400, error: `level must be one of ${CHAT_UPDATE_LEVELS.join(', ')}` }
  }
  const p = configPathFor(harnessId)
  if (!p.ok) return p
  // Never create config.yaml: an agent without one is not one this writer
  // understands, and a half-file would crash-loop it.
  let content: string
  try {
    content = fs.readFileSync(p.configPath, 'utf-8')
  } catch {
    return { ok: false, status: 404, error: 'config.yaml not found for this harness' }
  }
  const before = readChatUpdateLevel(content)
  const r = spliceChatUpdateLevel(content, level)
  if (!r.ok) return r
  if (r.text === content) return { ok: true, unchanged: true, level, overridden: hasPlatformOverride(content) }
  try {
    fs.writeFileSync(p.configPath, r.text, 'utf-8')
  } catch (err) {
    return { ok: false, status: 500, error: `could not write config.yaml: ${err instanceof Error ? err.message : String(err)}` }
  }
  services.audit.append({ who: opts.who, what: 'harness.chat-updates.update', target: harnessId, meta: { from: before, to: level } })
  return { ok: true, unchanged: false, level, overridden: hasPlatformOverride(r.text) }
}
