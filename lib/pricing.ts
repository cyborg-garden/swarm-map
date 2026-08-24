/**
 * Model pricing table for cost estimation.
 *
 * Ported from hermes-agent's agent/usage_pricing.py.
 * All costs are per million tokens.
 * When a model is accessed through LiteLLM proxy, state.db records the
 * proxy-facing model name (e.g. "claude-sonnet-4"). We resolve the provider
 * via model name patterns rather than base_url, since the proxy obscures it.
 */

export type PricingEntry = {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
}

/**
 * Pricing keyed by model name pattern.
 * Order matters — first match wins, so put specific names before wildcards.
 */
const PRICING_TABLE: Array<{ pattern: string | RegExp; pricing: PricingEntry }> = [
  // ── Anthropic Claude 4.5+ generation ──────────────────────────────────
  // Opus 4.5/4.6/4.7: $5/$25
  {
    pattern: /^claude-opus-4/,
    pricing: {
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    },
  },
  // Sonnet 4.x: $3/$15
  {
    pattern: /^claude-sonnet-4/,
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  },
  // Haiku 4.5: $1/$5
  {
    pattern: /^claude-haiku-4/,
    pricing: {
      inputPerMillion: 1.0,
      outputPerMillion: 5.0,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
    },
  },
  // ── Anthropic older models ────────────────────────────────────────────
  {
    pattern: /^claude-3-5-sonnet/,
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  },
  {
    pattern: /^claude-3-5-haiku/,
    pricing: {
      inputPerMillion: 0.8,
      outputPerMillion: 4.0,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1.0,
    },
  },
  {
    pattern: /^claude-3-opus/,
    pricing: {
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  },
  {
    pattern: /^claude-3-haiku/,
    pricing: {
      inputPerMillion: 0.25,
      outputPerMillion: 1.25,
      cacheReadPerMillion: 0.03,
      cacheWritePerMillion: 0.3,
    },
  },
  // ── OpenAI ────────────────────────────────────────────────────────────
  {
    pattern: 'gpt-4o-mini',
    pricing: {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.075,
    },
  },
  {
    pattern: /^gpt-4o/,
    pricing: {
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 1.25,
    },
  },
  {
    pattern: 'gpt-4.1-nano',
    pricing: {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheReadPerMillion: 0.025,
    },
  },
  {
    pattern: 'gpt-4.1-mini',
    pricing: {
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
      cacheReadPerMillion: 0.1,
    },
  },
  {
    pattern: /^gpt-4\.1/,
    pricing: {
      inputPerMillion: 2.0,
      outputPerMillion: 8.0,
      cacheReadPerMillion: 0.5,
    },
  },
  {
    pattern: 'o3-mini',
    pricing: {
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
      cacheReadPerMillion: 0.55,
    },
  },
  {
    pattern: /^o3/,
    pricing: {
      inputPerMillion: 10.0,
      outputPerMillion: 40.0,
      cacheReadPerMillion: 2.5,
    },
  },
  // ── DeepSeek ──────────────────────────────────────────────────────────
  // DeepSeek V4 Flash — successor cheap routing tier (D-2026-08-06). DeepSeek
  // permanent list price $0.14/$0.28, cache-hit $0.0028 (2026-05-22 schedule);
  // OpenRouter was serving below list (~$0.09/$0.18) as of 2026-08-06 — we
  // price at list, so spend is over-estimated rather than under-tracked. Must
  // also sit ABOVE the legacy /^deepseek/ wildcard, which happens to share the
  // in/out rates but has no cache-read rate — and the fleet runs ~6:1
  // cache-read:input, so the cache field is the one that matters.
  {
    pattern: /^deepseek-v4-flash/,
    pricing: {
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
      cacheReadPerMillion: 0.0028,
    },
  },
  // DeepSeek V3.2 — the previous cheap routing tier, still referenced by
  // legacy cascade entries; $0.23/$0.34 per DeepSeek platform / OpenRouter
  // listings (2026-07-23). Must also sit ABOVE the legacy /^deepseek/
  // wildcard, which carries stale V3-era rates.
  {
    pattern: /^deepseek-v3\.2/,
    pricing: {
      inputPerMillion: 0.23,
      outputPerMillion: 0.34,
    },
  },
  {
    pattern: 'deepseek-reasoner',
    pricing: {
      inputPerMillion: 0.55,
      outputPerMillion: 2.19,
    },
  },
  {
    pattern: /^deepseek/,
    pricing: {
      inputPerMillion: 0.14,
      outputPerMillion: 0.28,
    },
  },
  // ── Google Gemini ─────────────────────────────────────────────────────
  {
    pattern: /^gemini-2\.5-pro/,
    pricing: {
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
    },
  },
  {
    pattern: /^gemini-2\.5-flash/,
    pricing: {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    },
  },
  {
    pattern: /^gemini-2\.0-flash/,
    pricing: {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
    },
  },
  // ── Z.ai GLM ([intelligent-routing-cost]) ─────────────────────────────
  // GLM-5.3 — fleet chat primary since 2026-08-20 (replaced Kimi K3 fleet-wide).
  // OpenRouter $1.40/$4.40, cache-read $0.26 (as of 2026-08-20).
  {
    pattern: /^glm-5\.3/,
    pricing: {
      inputPerMillion: 1.4,
      outputPerMillion: 4.4,
      cacheReadPerMillion: 0.26,
    },
  },
  // GLM-5.2 — fleet chat primary. Z.ai LIST price $1.40/$4.40. OpenRouter is
  // running a 45%-off promo (~$0.7644/$2.402) as of 2026-07-23; we price at
  // list, so promo-period spend is over-estimated rather than under-tracked.
  {
    pattern: /^glm-5\.2/,
    pricing: {
      inputPerMillion: 1.4,
      outputPerMillion: 4.4,
    },
  },
  // GLM-4.6 — still listed in the zai catalog; Z.ai list $0.60/$2.20.
  {
    pattern: /^glm-4\.6/,
    pricing: {
      inputPerMillion: 0.6,
      outputPerMillion: 2.2,
    },
  },
  // GLM-4.5 Flash — Z.ai free tier. A real $0 entry (not a missing one) so
  // usage resolves to cost_status "estimated" instead of "unknown".
  {
    pattern: /^glm-4\.5-flash/,
    pricing: {
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
  },
  // ── Moonshot Kimi ─────────────────────────────────────────────────────
  // Kimi K3 — premium on-demand tier (1M ctx, released 2026-07-16). Moonshot
  // platform pricing $3.00/$15.00, cache-hit input $0.30 (as of 2026-07-23).
  {
    pattern: /^kimi-k3/,
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
    },
  },
  // Kimi K2.7 Code — cheap metered workhorse rung; ~$0.72/$3.49 on OpenRouter.
  {
    pattern: /^kimi-k2\.7/,
    pricing: {
      inputPerMillion: 0.72,
      outputPerMillion: 3.49,
    },
  },
]

/**
 * Look up pricing for a model name.
 * Strips common prefixes like "bedrock/" or "anthropic." before matching.
 */
export function lookupPricing(modelName: string): PricingEntry | null {
  // Normalize: remove provider prefixes that LiteLLM or Bedrock adds
  const normalized = modelName
    .replace(/^bedrock\//, '')
    .replace(/^anthropic\./, '')
    .replace(/^openai\//, '')
    .replace(/^google\//, '')
    .replace(/^vertex_ai\//, '')
    // openrouter/ must strip BEFORE deepseek/: a double-prefixed
    // "openrouter/deepseek/deepseek-*" name must still reach the versioned
    // deepseek patterns (which carry the cache-read rate), not the legacy
    // wildcard (which doesn't).
    .replace(/^openrouter\//, '')
    .replace(/^deepseek\//, '')
    .replace(/^z-ai\//, '')
    .replace(/^zai\//, '')
    .replace(/^moonshotai\//, '')

  for (const entry of PRICING_TABLE) {
    if (typeof entry.pattern === 'string') {
      if (normalized === entry.pattern) return entry.pricing
    } else {
      if (entry.pattern.test(normalized)) return entry.pricing
    }
  }
  return null
}

/**
 * Compute cost in USD from token counts and pricing.
 */
export function computeCost(
  tokens: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  },
  pricing: PricingEntry,
): number {
  const M = 1_000_000
  let cost = 0

  // Input tokens (excluding cache reads, which are priced separately)
  cost += (tokens.input / M) * pricing.inputPerMillion

  // Output tokens
  cost += (tokens.output / M) * pricing.outputPerMillion

  // Cache reads (cheaper than input)
  if (tokens.cacheRead && pricing.cacheReadPerMillion) {
    cost += (tokens.cacheRead / M) * pricing.cacheReadPerMillion
  } else if (tokens.cacheRead) {
    // If no cache pricing, charge at input rate
    cost += (tokens.cacheRead / M) * pricing.inputPerMillion
  }

  // Cache writes (more expensive than input)
  if (tokens.cacheWrite && pricing.cacheWritePerMillion) {
    cost += (tokens.cacheWrite / M) * pricing.cacheWritePerMillion
  }

  // Reasoning tokens charged at output rate
  if (tokens.reasoning) {
    cost += (tokens.reasoning / M) * pricing.outputPerMillion
  }

  return cost
}
