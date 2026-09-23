import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { CascadeLibraryError } from '@/lib/services/cascades'

// Named cascade library — one record.
//   GET    /api/cascades/:name                       → CascadeRecord | 404
//   PUT    /api/cascades/:name { name?, chain? }   → rename and/or replace chain
//   DELETE /api/cascades/:name                       → { ok: true } | 404
// Name lookup is case-insensitive.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
  const record = services.cascades.get(name)
  if (!record) {
    return NextResponse.json({ error: 'Cascade not found' }, { status: 404 })
  }
  return NextResponse.json(record)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params

  let body: {
    name?: string
    chain?: Array<{ provider: string; model: string; base_url?: string }>
    /** Pre-chain alias for `chain`. */
    entries?: Array<{ provider: string; model: string; base_url?: string }>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.chain === undefined && body.entries !== undefined) body.chain = body.entries
  const wantsRename = typeof body.name === 'string'
  const wantsEntries = body.chain !== undefined
  if (!wantsRename && !wantsEntries) {
    return NextResponse.json(
      { error: 'Provide "name" (rename) and/or "chain" (replace chain)' },
      { status: 400 }
    )
  }

  if (!services.cascades.get(name)) {
    return NextResponse.json({ error: 'Cascade not found' }, { status: 404 })
  }

  try {
    // One validated write: a 409 on the rename (or a 400 on the chain)
    // leaves the record exactly as it was — never half-applied.
    const record = services.cascades.edit(name, {
      ...(wantsRename ? { name: body.name as string } : {}),
      ...(wantsEntries ? { chain: body.chain ?? [] } : {}),
    })
    return NextResponse.json(record)
  } catch (err) {
    if (err instanceof CascadeLibraryError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
  const removed = services.cascades.remove(name)
  if (!removed) {
    return NextResponse.json({ error: 'Cascade not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
