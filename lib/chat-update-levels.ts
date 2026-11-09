/**
 * The chat-updates levels and the config.yaml keys each one writes. Pure (no
 * fs, no services) so the deploy template can import it. The reader/writer
 * for live agents is lib/services/chat-updates.ts.
 */

export const CHAT_UPDATE_LEVELS = ['quiet', 'some', 'all'] as const
export type ChatUpdateLevel = (typeof CHAT_UPDATE_LEVELS)[number]

/** What new agents get (lib/templates/config-yaml.ts writes the same keys). */
export const DEFAULT_CHAT_UPDATE_LEVEL: ChatUpdateLevel = 'quiet'

export type LevelKeys = { toolProgress: string; interim: boolean; heartbeat: boolean }

/**
 * display.tool_progress, display.interim_assistant_messages and
 * display.long_running_notifications (the "still working" message hermes
 * posts every few minutes on a long task).
 */
export const LEVEL_KEYS: Record<ChatUpdateLevel, LevelKeys> = {
  quiet: { toolProgress: 'off', interim: false, heartbeat: false },
  some: { toolProgress: 'new', interim: true, heartbeat: true },
  all: { toolProgress: 'all', interim: true, heartbeat: true },
}

/** The YAML lines the template writes for a level, at two-space indent. */
export function chatUpdateYamlLines(level: ChatUpdateLevel): string[] {
  const k = LEVEL_KEYS[level]
  return [
    `  tool_progress: "${k.toolProgress}"`,
    `  interim_assistant_messages: ${k.interim}`,
    `  long_running_notifications: ${k.heartbeat}`,
  ]
}

export function isChatUpdateLevel(v: unknown): v is ChatUpdateLevel {
  return typeof v === 'string' && (CHAT_UPDATE_LEVELS as readonly string[]).includes(v)
}
