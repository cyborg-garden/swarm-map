// lib/resolvers/signal.ts

import fs from 'fs'
import path from 'path'
import os from 'os'

export type ResolvedIdentity = {
  display: string      // what the admin entered (e.g. phone number)
  nativeId: string     // platform-native ID (e.g. UUID)
  profileName?: string // display name if available
}

function getSignalConfig(harnessId: string): { url: string; account: string } | null {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  const dataDir = name === 'personal'
    ? path.join(os.homedir(), '.hermes')
    : path.join(os.homedir(), `.hermes-${name}`)
  const envPath = path.join(dataDir, '.env')

  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    const url = content.match(/^SIGNAL_HTTP_URL=(.+)$/m)?.[1]?.trim()
    const account = content.match(/^SIGNAL_ACCOUNT=(.+)$/m)?.[1]?.trim()
    if (url && account) return { url, account }
  } catch {}
  return null
}

async function signalRpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
  })
  if (!res.ok) throw new Error(`Signal RPC ${method} failed: ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'RPC error')
  return data.result
}

/**
 * Resolve a phone number to a Signal UUID via signal-cli getUserStatus RPC.
 * Returns null if resolution fails.
 */
export async function resolveSignalPhone(
  harnessId: string,
  phone: string
): Promise<ResolvedIdentity | null> {
  const config = getSignalConfig(harnessId)
  if (!config) return null

  try {
    const result = await signalRpc(config.url, 'getUserStatus', {
      account: config.account,
      recipients: [phone],
    }) as Array<{ uuid?: string; serviceId?: string }>

    if (Array.isArray(result) && result[0]) {
      const uuid = result[0].uuid || result[0].serviceId
      if (uuid) return { display: phone, nativeId: uuid }
    }
  } catch {}
  return null
}

/**
 * Get the UUID of the bot's own Signal account.
 */
export async function getSignalAccountUuid(harnessId: string): Promise<string | null> {
  const config = getSignalConfig(harnessId)
  if (!config) return null

  try {
    const result = await signalRpc(config.url, 'listAccounts', {}) as Array<{ number?: string; uuid?: string }>
    if (Array.isArray(result)) {
      const acct = result.find(a => a.number === config.account)
      return acct?.uuid || null
    }
  } catch {}
  return null
}
