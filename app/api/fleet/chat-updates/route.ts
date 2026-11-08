import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { applyChatUpdatesToHarness, isChatUpdateLevel, readHarnessChatUpdates, CHAT_UPDATE_LEVELS } from '@/lib/services/chat-updates'

// /api/fleet/chat-updates — the chat-updates level across every Hermes agent.
//
// GET  — each agent's current level. Writes nothing.
// POST — Body `{ level }`: set that level on every Hermes agent now. Each
//        agent can still be changed on its own afterwards; nothing re-applies
//        this at server start.

function hermesHarnessIds(): string[] {
  return services.harness
    .list()
    .filter((h) => h.runtime !== 'letta' && h.runtime !== 'letta-server')
    .map((h) => h.id)
}

export async function GET() {
  const agents = hermesHarnessIds().map((id) => {
    const r = readHarnessChatUpdates(id)
    return r.ok ? { id, level: r.level } : { id, error: r.error }
  })
  return NextResponse.json({ agents })
}

export async function POST(request: Request) {
  let body: { level?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!isChatUpdateLevel(body?.level)) {
    return NextResponse.json({ error: `level must be one of ${CHAT_UPDATE_LEVELS.join(', ')}` }, { status: 400 })
  }
  const updated: string[] = []
  const unchanged: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of hermesHarnessIds()) {
    const r = applyChatUpdatesToHarness(id, body.level, { who: 'api:fleet' })
    if (!r.ok) failed.push({ id, error: r.error })
    else (r.unchanged ? unchanged : updated).push(id)
  }
  return NextResponse.json({ level: body.level, updated, unchanged, failed })
}
