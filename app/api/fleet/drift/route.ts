import { NextResponse } from 'next/server'
import path from 'path'
import os from 'os'
import { services } from '@/lib/services'
import { fleetDrift } from '@/lib/services/drift'

// GET /api/fleet/drift — per-agent "is this running old code?" (read-only).
//
// DETECTION ONLY. There is deliberately no POST/apply here: the 2026-08-10
// failure was that nothing said "behind", not that nothing could rebuild.
// Rebuilds stay on the existing, explicitly-invoked restart path.
export async function GET() {
  try {
    const settings = services.config.getSettings()
    const dataDir = (settings?.dataDir ?? '~/.hermes-swarm-map').replace(/^~/, os.homedir())
    const composeBaseDir = path.join(dataDir, 'compose')

    const result = await fleetDrift({
      harnesses: services.harness.list(),
      composeBaseDir,
      // Only meaningful when the install builds locally; an image-only agent
      // has no local source to compare against and reports unknown.
      fallbackHermesDir: settings?.useLocalBuild ? settings?.hermesDir ?? null : null,
      deps: { docker: services.docker },
    })

    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'drift check failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
