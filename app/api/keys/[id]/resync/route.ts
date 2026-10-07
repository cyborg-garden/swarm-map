import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// Rewrite an assigned key into its agents' .env, then recreate only the agents
// whose .env changed (env_file is read at container creation). Repairs a key
// that is assigned on paper but missing from an agent, which re-saving the
// same assignment cannot do. Body (optional): { harnesses: string[] } narrows
// the resync to those assigned agents.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let body: unknown = {}
  try { body = await request.json() } catch { /* empty body = all assigned */ }

  let harnesses: string[] | undefined
  if (body && typeof body === 'object' && 'harnesses' in body) {
    const h = (body as { harnesses: unknown }).harnesses
    if (!Array.isArray(h) || !h.every((x) => typeof x === 'string')) {
      return NextResponse.json({ error: 'harnesses must be an array of harness ids' }, { status: 400 })
    }
    harnesses = h
  }

  const result = services.keys.resync(id, harnesses)
  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const recreated: string[] = []
  const recreateFailed: string[] = []
  for (const h of result.changed) {
    try { services.harness.restart(h, 'recreate'); recreated.push(h) } catch { recreateFailed.push(h) }
  }
  return NextResponse.json({ ...result, recreated, recreateFailed })
}
