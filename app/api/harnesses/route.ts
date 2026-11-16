import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

export async function GET() {
  try {
    // Hermes agents exactly as before, then the door agents, which HarnessService never lists.
    const harnesses = services.harness.list()
    return NextResponse.json([...harnesses, ...(services.doorAgents.list() ?? [])])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, harnesses: [] }, { status: 500 })
  }
}
