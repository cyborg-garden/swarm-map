import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isLiveProvider, LIVE_PROVIDERS } from '@/lib/services/model-freshness'

// GET /api/models/live?provider=openrouter|anthropic|zai[&force=1]
//
// The provider's live model list (cached 1h under DATA_DIR/model-lists/).
// 204 when there is no live information (no key, provider down, non-200) —
// callers render the catalog unflagged in that case (#136).
export async function GET(request: Request) {
  const url = new URL(request.url)
  const provider = (url.searchParams.get('provider') ?? '').trim().toLowerCase()
  if (!isLiveProvider(provider)) {
    return NextResponse.json(
      { error: `provider must be one of ${LIVE_PROVIDERS.join(', ')}` },
      { status: 400 },
    )
  }
  const force = url.searchParams.get('force') === '1'
  const live = await services.modelFreshness.fetchLiveModels(provider, { force })
  if (!live) return new Response(null, { status: 204 })
  return NextResponse.json({ provider, fetchedAt: live.fetchedAt, models: live.models })
}
