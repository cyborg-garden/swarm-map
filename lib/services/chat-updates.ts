import fs from 'fs'
import path from 'path'
import { services } from '@/lib/services'
import { readScalar, spliceScalars, tuningDataDir } from '@/lib/services/tuning-writer'
import { CHAT_UPDATE_LEVELS, LEVEL_KEYS, isChatUpdateLevel, type ChatUpdateLevel } from '@/lib/chat-update-levels'

export { CHAT_UPDATE_LEVELS, DEFAULT_CHAT_UPDATE_LEVEL, isChatUpdateLevel, type ChatUpdateLevel } from '@/lib/chat-update-levels'

/**
 * Chat updates: how much of an agent's working shows up in chat.
 *
 * One level, written as two keys in config.yaml's `display:` section:
 *   quiet → tool_progress: "off", interim_assistant_messages: false
 *           Only questions, approval prompts and the final answer. Hermes
 *           sends clarify and approval prompts on their own path, so neither
 *           key hides them.
 *   some  → tool_progress: "new", interim_assistant_messages: true
 *   all   → tool_progress: "all", interim_assistant_messages: true
 *
 * "off" is quoted: bare `off` is a YAML 1.1 boolean. Hermes copes with that,
 * but the quoted form reads the same to every parser.
 *
 * Hermes re-reads config.yaml when it changes, so a new level applies from
 * the agent's next message with no restart.
 */

// Same normalisation hermes applies (gateway/display_config.py _normalise).
function normToolProgress(raw: string | null): string | null {
  if (raw === null || raw === '') return null
  const v = raw.trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(v)) return 'off'
  if (['true', '1', 'yes', 'on'].includes(v)) return 'all'
  return ['new', 'all', 'verbose', 'log'].includes(v) ? v : 'all'
}

function normBool(raw: string | null): boolean | null {
  if (raw === null || raw === '') return null
  return ['true', '1', 'yes', 'on', 'raw', 'verbose'].includes(raw.trim().toLowerCase())
}

/**
 * The level config.yaml expresses. 'custom' = the keys are set to something
 * no level writes; null = neither key is set (hermes's own defaults apply,
 * which on Discord means every step).
 */
export function readChatUpdateLevel(text: string): ChatUpdateLevel | 'custom' | null {
  const tp = normToolProgress(readScalar(text, 'display', 'tool_progress'))
  const interim = normBool(readScalar(text, 'display', 'interim_assistant_messages'))
  if (tp === null && interim === null) return null
  for (const level of CHAT_UPDATE_LEVELS) {
    const k = LEVEL_KEYS[level]
    if (tp === k.toolProgress && interim === k.interim) return level
  }
  return 'custom'
}

export function spliceChatUpdateLevel(text: string, level: ChatUpdateLevel) {
  const k = LEVEL_KEYS[level]
  return spliceScalars(text, [
    {
      section: 'display',
      key: 'tool_progress',
      value: `"${k.toolProgress}"`,
      same: (cur) => cur === k.toolProgress,
    },
    {
      section: 'display',
      key: 'interim_assistant_messages',
      value: String(k.interim),
      same: (cur) => cur === String(k.interim),
    },
  ])
}

type Fail = { ok: false; status: 400 | 404 | 409; error: string }

function configPathFor(harnessId: string): { ok: true; configPath: string } | Fail {
  const harness = services.harness.get(harnessId)
  if (!harness) return { ok: false, status: 404, error: 'Harness not found' }
  return { ok: true, configPath: path.join(tuningDataDir(harness), 'config.yaml') }
}

export function readHarnessChatUpdates(harnessId: string): { ok: true; level: ChatUpdateLevel | 'custom' | null } | Fail {
  const p = configPathFor(harnessId)
  if (!p.ok) return p
  try {
    return { ok: true, level: readChatUpdateLevel(fs.readFileSync(p.configPath, 'utf-8')) }
  } catch {
    return { ok: false, status: 404, error: 'config.yaml not found for this harness' }
  }
}

export function applyChatUpdatesToHarness(
  harnessId: string,
  level: unknown,
  opts: { who: string },
): { ok: true; unchanged: boolean; level: ChatUpdateLevel } | Fail {
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
  if (r.text === content) return { ok: true, unchanged: true, level }
  fs.writeFileSync(p.configPath, r.text, 'utf-8')
  services.audit.append({ who: opts.who, what: 'harness.chat-updates.update', target: harnessId, meta: { from: before, to: level } })
  return { ok: true, unchanged: false, level }
}
