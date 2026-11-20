import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { getSignalDaemonUrl } from '@/lib/env-helpers'

const SIGNAL_API = getSignalDaemonUrl()

export async function POST() {
  let accounts: Array<{ number?: string }> = []
  try {
    const rpcRes = await fetch(`${SIGNAL_API}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'listAccounts', id: '1' }),
      signal: AbortSignal.timeout(5000),
    })
    const rpcData = await rpcRes.json()
    if (Array.isArray(rpcData.result)) {
      accounts = rpcData.result
    }
  } catch {
    return NextResponse.json(
      { success: false, error: 'Cannot reach signal-cli daemon' },
      { status: 503 }
    )
  }

  const registeredPhones = accounts
    .map(a => a.number)
    .filter((n): n is string => !!n)

  if (registeredPhones.length === 0) {
    return NextResponse.json({ success: true, locked: [], alreadyLocked: [], failed: [] })
  }

  // Build phone→harnessId mapping from surfaces (Signal is multi-surface, not h.platform).
  // Pass the live harness names, as GET /api/surfaces does, so every existing
  // harness is considered rather than only the configured default list.
  const harnessNames = services.harness.list().map((h) => h.name)
  const surfaces = services.config.listSurfaces(harnessNames)
  const phoneToHarness: Record<string, string> = {}
  for (const s of surfaces) {
    if (s.platform === 'signal' && s.status === 'connected' && s.config.phone) {
      const harnessId = s.harnessIds[0] || 'unassigned'
      if (registeredPhones.includes(s.config.phone)) {
        phoneToHarness[s.config.phone] = harnessId
      }
    }
  }

  // Unmatched phones get 'unassigned'
  for (const phone of registeredPhones) {
    if (!phoneToHarness[phone]) {
      phoneToHarness[phone] = 'unassigned'
    }
  }

  const result = await services.signalPin.bulkSet(registeredPhones, phoneToHarness)
  return NextResponse.json({ success: true, ...result })
}
