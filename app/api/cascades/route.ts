import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { CascadeLibraryError } from '@/lib/services/cascades'

// Named cascade library — collection.
//   GET  /api/cascades                       → CascadeRecord[]
//   POST /api/cascades { name, chain, sourceHarness?, overwrite? } → 201 CascadeRecord
// chain[0] is the primary, the rest are the fallbacks. `entries` is accepted
// as an alias for `chain` (the pre-chain key). Existing name → 409 unless
// overwrite:true. api_key is never stored.

export async function GET() {
  return NextResponse.json(services.cascades.list())
}

export async function POST(request: Request) {
  let body: {
    name?: string
    chain?: Array<{ provider: string; model: string; base_url?: string }>
    /** Pre-chain alias for `chain`. */
    entries?: Array<{ provider: string; model: string; base_url?: string }>
    sourceHarness?: string
    overwrite?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const record = services.cascades.save(
      { name: body.name ?? '', chain: body.chain ?? body.entries ?? [], sourceHarness: body.sourceHarness },
      { overwrite: body.overwrite === true }
    )
    return NextResponse.json(record, { status: 201 })
  } catch (err) {
    if (err instanceof CascadeLibraryError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
