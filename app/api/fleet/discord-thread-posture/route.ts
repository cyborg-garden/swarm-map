import { NextResponse } from 'next/server'
import { discordThreadPosture } from '@/lib/services/discord-thread-gate'
import { fleetThreadGateTargets, threadMentionOptOuts } from '@/lib/services/discord-thread-gate-fleet'

// GET /api/fleet/discord-thread-posture — which Discord agents answer
// un-mentioned messages inside threads (read-only).
//
// REPORT ONLY. There is deliberately no POST/apply: the only writer is the
// .env heal (lib/services/discord-thread-gate.ts), and a second writer is how
// the retired disabled-hermes-discord-policy-assert.py fought the console.
//
// ?adapterDefault=true assumes every agent runs an adapter whose default is
// fail-closed. Leave it off (the default) until the whole fleet is rebuilt on
// that adapter, or agents relying on the default are reported as gated when
// they are not.
export async function GET(request: Request) {
  try {
    const adapterDefault = new URL(request.url).searchParams.get('adapterDefault') === 'true'
    return NextResponse.json(discordThreadPosture(fleetThreadGateTargets(), threadMentionOptOuts(), adapterDefault))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'posture check failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
