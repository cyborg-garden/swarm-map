import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

/**
 * Stored rows whose runtime is retired or unknown. They are not in
 * GET /api/harnesses and no per-harness route resolves them. The one thing
 * that works on such a row is DELETE /api/harnesses/:id, which forgets it.
 */
export async function GET() {
  try {
    return NextResponse.json(services.harness.listRetired())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message, retired: [] }, { status: 500 })
  }
}
