import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import type { Harness } from '@/lib/types'

export async function GET() {
  try {
    // Hermes agents exactly as before, then the door agents, which HarnessService never lists.
    const harnesses = services.harness.list()
    let doorAgents: Harness[] = []
    // A door agent that cannot be read must not take the Hermes list down with it.
    try { doorAgents = services.doorAgents.list() ?? [] } catch { /* listed without them */ }
    return NextResponse.json([...harnesses, ...doorAgents])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, harnesses: [] }, { status: 500 })
  }
}
