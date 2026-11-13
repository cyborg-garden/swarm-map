import { NextResponse } from 'next/server'
import { applyChatUpdatesToHarness, readHarnessChatUpdates } from '@/lib/services/chat-updates'
import { refuseUnmanagedRow } from '@/lib/services/unmanaged-row-guard'

/**
 * GET /api/harnesses/:id/chat-updates
 *
 * How much of this agent's working shows in chat: `level` is quiet, some or
 * all; 'custom' when config.yaml holds a mix no level writes; 'unset' when a
 * key is absent, so hermes's per-surface defaults apply. `overridden` is true when a
 * per-platform value in config.yaml wins over the level on some surface.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const unmanaged = refuseUnmanagedRow(id)
  if (unmanaged) return unmanaged
  const r = readHarnessChatUpdates(id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ level: r.level, overridden: r.overridden })
}

/**
 * PUT /api/harnesses/:id/chat-updates  Body: `{ level: "quiet" | "some" | "all" }`
 *
 * Hermes re-reads config.yaml when it changes, so this applies from the
 * agent's next message. No restart.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const unmanaged = refuseUnmanagedRow(id)
  if (unmanaged) return unmanaged
  let body: { level?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const r = applyChatUpdatesToHarness(id, body?.level, { who: 'api' })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, unchanged: r.unchanged, level: r.level, overridden: r.overridden })
}
