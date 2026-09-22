import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { CascadeLibraryError } from '@/lib/services/cascades'

// Named cascade library — collection.
//   GET  /api/cascades                       → CascadeRecord[]
//   POST /api/cascades { name, entries, sourceHarness?, overwrite? } → 201 CascadeRecord
// Existing name → 409 unless overwrite:true. api_key is never stored.

export async function GET() {
  return NextResponse.json(services.cascades.list())
}

export async function POST(request: Request) {
  let body: {
    name?: string
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
      { name: body.name ?? '', entries: body.entries ?? [], sourceHarness: body.sourceHarness },
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
