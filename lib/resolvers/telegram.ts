import fs from 'fs'
import path from 'path'
import type { ResolvedIdentity } from './signal'
import { agentHome } from '@/lib/services/agent-home'

function getTelegramToken(harnessId: string): string | null {
  // Throws for an id whose stored row Swarm Map does not manage.
  const dataDir = agentHome(harnessId)
  const envPath = path.join(dataDir, '.env')

  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    return content.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim() || null
  } catch {}
  return null
}

/**
 * Resolve a Telegram @username to numeric user ID via getChat.
 * Only works for public users/channels/groups.
 *
 * `botToken` overrides the token read from the agent .env — the connect route
 * passes the token from the request payload because TELEGRAM_BOT_TOKEN may not
 * be written to the .env yet at connect time.
 */
export async function resolveTelegramUsername(
  harnessId: string,
  username: string,
  botToken?: string
): Promise<ResolvedIdentity | null> {
  const token = botToken || getTelegramToken(harnessId)
  if (!token) return null

  const handle = username.startsWith('@') ? username : `@${username}`

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(handle)}`
    )
    if (!res.ok) return null
    const data = await res.json()
    if (data.ok && data.result?.id) {
      const r = data.result
      const profileName = r.first_name
        ? `${r.first_name}${r.last_name ? ' ' + r.last_name : ''}`
        : r.title || undefined
      return { display: handle, nativeId: String(r.id), profileName }
    }
  } catch {}
  return null
}

/**
 * Resolve a Telegram numeric ID to display name.
 */
export async function getTelegramDisplayName(
  harnessId: string,
  numericId: string
): Promise<string | null> {
  const token = getTelegramToken(harnessId)
  if (!token) return null

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${numericId}`
    )
    if (!res.ok) return null
    const data = await res.json()
    if (data.ok && data.result) {
      const r = data.result
      return r.title || r.first_name || r.username || null
    }
  } catch {}
  return null
}
