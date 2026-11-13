// lib/resolvers/mattermost.ts

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ResolvedIdentity } from './signal'

function getMattermostConfig(harnessId: string): { url: string; token: string } | null {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  const dataDir = name === 'personal'
    ? path.join(os.homedir(), '.hermes')
    : path.join(os.homedir(), `.hermes-${name}`)
  const envPath = path.join(dataDir, '.env')

  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    const url = content.match(/^MATTERMOST_URL=(.+)$/m)?.[1]?.trim()
    const token = content.match(/^MATTERMOST_TOKEN=(.+)$/m)?.[1]?.trim()
    if (url && token) return { url, token }
  } catch {}
  return null
}

/**
 * Resolve a Mattermost username to internal user ID.
 */
export async function resolveMattermostUsername(
  harnessId: string,
  username: string
): Promise<ResolvedIdentity | null> {
  const config = getMattermostConfig(harnessId)
  if (!config) return null

  const name = username.startsWith('@') ? username.slice(1) : username

  try {
    const res = await fetch(`${config.url}/api/v4/users/username/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.id) {
      const displayName = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username
      return { display: `@${name}`, nativeId: data.id, profileName: displayName }
    }
  } catch {}
  return null
}
