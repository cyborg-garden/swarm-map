/**
 * Client-safe helpers for per-row model status in the cascade editor.
 *
 * Kept out of lib/services/* on purpose: those modules pull in fs/storage and
 * the key store, which a 'use client' component must not import. The two
 * facts mirrored here have a server source of truth:
 *  - TRACKABLE_PROVIDERS = LIVE_PROVIDERS (lib/services/model-freshness.ts):
 *    the providers with a live model list, so the only ones "Track latest"
 *    or a retired badge can mean anything for. ollama/bedrock/custom rows are
 *    NEVER_APPLY_PROVIDERS on the scheduler side and get no toggle.
 *  - rowKey = trackingKey (lib/services/model-update-scheduler.ts):
 *    "provider/model", exactly as the row appears in fallback_providers.
 */

export const TRACKABLE_PROVIDERS = ['openrouter', 'anthropic', 'zai'] as const

export function isTrackableProvider(provider: string): boolean {
  return (TRACKABLE_PROVIDERS as readonly string[]).includes(provider.trim().toLowerCase())
}

export function rowKey(entry: { provider: string; model: string }): string {
  return `${entry.provider}/${entry.model}`
}

export type LiveListLike = { models: Array<{ id: string; expiration?: string | null }> } | null

/**
 * Mirrors ModelFreshnessService.isRetired: retired = absent from the live
 * list, or its expiration date has passed. No list (204 / provider down /
 * no key) → never retired — a provider outage must not paint the fleet red.
 */
export function isRetiredIn(live: LiveListLike, id: string, today: string = new Date().toISOString().slice(0, 10)): boolean {
  if (!live) return false
  const row = live.models.find((m) => m.id === id)
  if (!row) return true
  return !!row.expiration && row.expiration < today
}
