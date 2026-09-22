import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// PUT /api/harnesses/[id]/models/tracking
//   { "provider/model": true | false, ... }
//
// Sets "track the newest version of this model" per cascade entry. Keys are
// "provider/model" exactly as the entry appears in fallback_providers
// (e.g. "openrouter/z-ai/glm-5.2"). false clears the flag. Ollama entries are
// refused: a local tag has no upstream notion of "newer" and must never be
// auto-tracked. This only records intent — nothing is written to the agent
// until the model-update scheduler (or the manual apply route) acts on it.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }
  const body = await request.json().catch(() => null)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object of "provider/model": boolean' }, { status: 400 })
  }
  const patch: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const slash = key.indexOf('/')
    if (slash <= 0 || slash === key.length - 1 || /[\r\n]/.test(key)) {
      return NextResponse.json({ error: `Key "${key}" must be "provider/model"` }, { status: 400 })
    }
    if (typeof value !== 'boolean') {
      return NextResponse.json({ error: `Value for "${key}" must be a boolean` }, { status: 400 })
    }
    const provider = key.slice(0, slash).trim().toLowerCase()
    if (provider === 'ollama' && value) {
      return NextResponse.json({ error: `"${key}": ollama models cannot be tracked (no upstream version list)` }, { status: 400 })
    }
    patch[key] = value
  }

  const next: Record<string, boolean> = { ...(harness.modelTracking ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value) next[key] = true
    else delete next[key]
  }
  services.harness.updateConfig(id, { modelTracking: next })
  services.audit.append({ who: 'api', what: 'models:tracking', target: harness.name, meta: { harness: id, patch } })
  return NextResponse.json({ modelTracking: next })
}
