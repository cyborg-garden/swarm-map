import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { getSignalDaemonUrl } from '@/lib/env-helpers'
import { invalidHarnessId } from '@/lib/harness-ref'

const SIGNAL_API = getSignalDaemonUrl()

export async function POST(request: Request) {
  const { phone, pin, harnessId } = await request.json() as {
    phone: string; pin: string; harnessId: string
  }

  if (!phone || !pin || !harnessId) {
    return NextResponse.json(
      { success: false, error: 'phone, pin, and harnessId required' },
      { status: 400 }
    )
  }

  // The id is stored as the PIN's assignment, so it must be a well-formed one.
  const invalid = invalidHarnessId(harnessId)
  if (invalid) return invalid

  if (pin.length < 4) {
    return NextResponse.json(
      { success: false, error: 'PIN must be at least 4 characters' },
      { status: 400 }
    )
  }

  // Verify account is registered before setting PIN
  try {
    const rpcRes = await fetch(`${SIGNAL_API}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'listAccounts', id: '1' }),
      signal: AbortSignal.timeout(5000),
    })
    const rpcData = await rpcRes.json()
    const registered = Array.isArray(rpcData.result) &&
      rpcData.result.some((a: { number?: string }) => a.number === phone)
    if (!registered) {
      return NextResponse.json(
        { success: false, error: `Account ${phone} not found in signal-cli` },
        { status: 404 }
      )
    }
  } catch {
    return NextResponse.json(
      { success: false, error: 'Cannot reach signal-cli daemon' },
      { status: 503 }
    )
  }

  const result = await services.signalPin.setPin(phone, pin, harnessId)
  if (!result.success) {
    return NextResponse.json(result, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(request: Request) {
  const { phone } = await request.json() as { phone: string }

  if (!phone) {
    return NextResponse.json(
      { success: false, error: 'phone required' },
      { status: 400 }
    )
  }

  const result = await services.signalPin.removePin(phone)
  if (!result.success) {
    return NextResponse.json(result, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const phone = url.searchParams.get('phone')

  if (!phone) {
    return NextResponse.json(
      { success: false, error: 'phone query param required' },
      { status: 400 }
    )
  }

  const info = services.signalPin.getPin(phone)
  if (!info) {
    return NextResponse.json(
      { success: false, error: 'No PIN found for this number' },
      { status: 404 }
    )
  }

  return NextResponse.json(info)
}
