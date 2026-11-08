import { NextResponse } from 'next/server'
import { applyChatUpdatesToHarness, readHarnessChatUpdates } from '@/lib/services/chat-updates'

/**
 * GET /api/harnesses/:id/chat-updates
 *
 * How much of this agent's working shows in chat: `level` is quiet, some or
 * all; 'custom' when config.yaml holds a mix no level writes; null when
 * neither key is set (hermes's defaults apply — every step on Discord).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const r = readHarnessChatUpdates(id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ level: r.level })
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
  let body: { level?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const r = applyChatUpdatesToHarness(id, body?.level, { who: 'api' })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, unchanged: r.unchanged, level: r.level })
}
