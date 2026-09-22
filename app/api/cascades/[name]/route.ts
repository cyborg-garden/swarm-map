import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { CascadeLibraryError } from '@/lib/services/cascades'

// Named cascade library — one record.
//   GET    /api/cascades/:name                       → CascadeRecord | 404
//   PUT    /api/cascades/:name { name?, entries? }   → rename and/or replace entries
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
    entries?: Array<{ provider: string; model: string; base_url?: string }>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const wantsRename = typeof body.name === 'string'
  const wantsEntries = body.entries !== undefined
  if (!wantsRename && !wantsEntries) {
    return NextResponse.json(
      { error: 'Provide "name" (rename) and/or "entries" (replace entries)' },
      { status: 400 }
    )
  }

  if (!services.cascades.get(name)) {
    return NextResponse.json({ error: 'Cascade not found' }, { status: 404 })
  }

  try {
    // Entries first so a rename never lands beside an invalid entry set.
    let record = wantsEntries ? services.cascades.update(name, body.entries ?? []) : undefined
    if (wantsRename) record = services.cascades.rename(name, body.name as string)
    return NextResponse.json(record ?? services.cascades.get(name))
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
