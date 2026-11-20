import { NextResponse } from 'next/server'
import { getSignalDaemonUrl } from '@/lib/env-helpers'
import { services } from '@/lib/services'

const SIGNAL_API = getSignalDaemonUrl()

export async function GET() {
  try {
    const healthRes = await fetch(`${SIGNAL_API}/api/v1/check`, {
      signal: AbortSignal.timeout(3000),
    })
    const healthy = healthRes.ok

    let accounts: string[] = []
    if (healthy) {
      const rpcRes = await fetch(`${SIGNAL_API}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'listAccounts', id: '1' }),
        signal: AbortSignal.timeout(3000),
      })
      const rpcData = await rpcRes.json()
      if (Array.isArray(rpcData.result)) {
        accounts = rpcData.result.map((a: { number?: string }) => a.number || '')
      }
    }

    // Cross-reference PIN status using surfaces (Signal is a multi-surface, not h.platform)
    // Pass the live harness names so every existing harness is considered. Without
    // this, listSurfaces() falls back to the configured default list and
    // harnesses outside it never produce a Signal surface — so their
    // saved PIN status is never looked up and the UI shows "Registration Lock: not
    // set" (issue #57). Mirrors GET /api/surfaces.
    const pinStatus: Record<string, string> = {}
    const harnessNames = services.harness.list().map((h) => h.name)
    const surfaces = services.config.listSurfaces(harnessNames)
    const harnessAccounts: Array<{ phone: string; harnessId: string }> = []

    for (const s of surfaces) {
      if (s.platform === 'signal' && s.status === 'connected' && s.config.phone) {
        const harnessId = s.harnessIds[0] || 'unknown'
        harnessAccounts.push({ phone: s.config.phone, harnessId })
      }
    }

    if (healthy && harnessAccounts.length > 0) {
      const status = await services.signalPin.checkPinHealth(accounts, harnessAccounts)
      Object.assign(pinStatus, status)
    } else {
      for (const { phone } of harnessAccounts) {
        pinStatus[phone] = services.signalPin.getPinStatus(phone)
      }
    }

    return NextResponse.json({ healthy, url: SIGNAL_API, accounts, pinStatus })
  } catch {
    return NextResponse.json({ healthy: false, url: SIGNAL_API, accounts: [], pinStatus: {} })
  }
}
