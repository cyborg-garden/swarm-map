// lib/model-catalog.ts

export type ModelEntry = {
  id: string
  name: string
  tier: 'primary' | 'fallback' | 'local'
}

export const MODEL_CATALOG: Record<string, ModelEntry[]> = {
  anthropic: [
    // Mythos-class tier above Opus — highest-judgment work (curation, taste).
    { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'primary' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'primary' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'primary' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tier: 'fallback' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', tier: 'primary' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'fallback' },
  ],
  google: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'primary' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'primary' },
  ],
  ollama: [
    { id: 'qwen3:30b', name: 'Qwen3 30B', tier: 'local' },
    { id: 'llama3.1:8b', name: 'Llama 3.1 8B', tier: 'local' },
    // GLM open-model family, genuinely local (5.5 GB Q4, 128K ctx) — the
    // runnable-today fallback. GLM-5.2 itself (744B) needs ~256 GB and lives
    // under the `zai` provider (Z.ai cloud / future GPU box), not here.
    { id: 'glm4:9b', name: 'GLM-4 9B (local)', tier: 'local' },
  ],
  // Z.ai (GLM) — Zhipu's open models served over the Z.ai cloud API. Matches the
  // hermes-agent `zai` provider plugin (aliases glm/zhipu; key via GLM_API_KEY).
  // The runtime resolves the Z.ai endpoint itself, so HSM emits no base_url; set
  // GLM_BASE_URL on the agent to repoint the same selection at a self-hosted box.
  zai: [
    { id: 'glm-5.2', name: 'GLM-5.2', tier: 'primary' },
    { id: 'glm-4.6', name: 'GLM-4.6', tier: 'primary' },
    { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash', tier: 'fallback' },
  ],
  openrouter: [
    { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5 (OR)', tier: 'primary' },
    { id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8 (OR)', tier: 'primary' },
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (OR)', tier: 'primary' },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (OR)', tier: 'fallback' },
    // Fleet chat primary — GLM-5.3 (1M ctx, released 2026-08) replaced Kimi K3
    // across the fleet on 2026-08-20 (~2x cheaper input, ~3.4x cheaper output,
    // Terminal-Bench parity). Text-only; vision stays on the auxiliary router.
    { id: 'z-ai/glm-5.3', name: 'GLM-5.3 (OR)', tier: 'primary' },
    // GLM-5.2 (753B MoE, 1M ctx) — previous fleet primary, still primary on
    // some agents. The direct Z.ai lane remains under the `zai` provider above.
    { id: 'z-ai/glm-5.2', name: 'GLM-5.2 (OR)', tier: 'primary' },
    // Premium on-demand tier — Kimi K3 (1M ctx, released 2026-07-16). Not a
    // fallback rung: operators pull it in explicitly for high-judgment work.
    { id: 'moonshotai/kimi-k3', name: 'Kimi K3 (OR, premium)', tier: 'primary' },
    // Cheap metered workhorse rung — the missing "cheap-metered" tier the
    // token-spend audit flagged ([intelligent-routing-cost]). Sits above the
    // local-GLM floor so an agent that exhausts its Claude credits fails over
    // to a cheap metered model, not straight to a degraded local one. Kimi
    // K2.7 Code is confirmed-live on OpenRouter (~$0.72/$3.49 per M tok) and a
    // capable agentic model. Per-agent cheaper picks (Qwen/DeepSeek-class) are
    // free-text in the cascade editor — verify the exact slug live before use.
    { id: 'moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code (OR, cheap)', tier: 'fallback' },
    // Cheap routing tier ([intelligent-routing-cost]) — V4 Flash 0731 retrain
    // (284B MoE, 1M ctx, Terminal-Bench 2.1 82.7) supersedes V3.2 for the
    // mechanical down-route slot (D-2026-08-06). ⚠️ The BARE slug
    // `deepseek/deepseek-v4-flash` resolves to the weak 0423 preview on
    // OpenRouter (TB 61.8) — always pin -0731. V3.2 stays listed while live
    // cascades still reference it.
    { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash 0731 (OR, cheap)', tier: 'fallback' },
    { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2 (OR, cheap, legacy)', tier: 'fallback' },
  ],
  bedrock: [
    { id: 'us.anthropic.claude-sonnet-4-6-20250527-v1:0', name: 'Claude Sonnet 4.6 (Bedrock)', tier: 'primary' },
  ],
}

export type CascadeEntry = { provider: string; model: string }

/**
 * Cascade values (provider / model / base_url) are written into config.yaml
 * UNQUOTED by line splicing — there is no YAML library on that path. So every
 * value must be a safe YAML plain scalar on one line. Anything else can inject
 * top-level keys (a newline), break the mapping (": ", " #", trailing ":") or
 * change the node's type (a leading indicator such as "-", "[", "@", "\"").
 *
 * Returns a human-readable error for an unsafe value, or null when it is safe.
 * Real ids like `qwen3:30b`, `us.anthropic.…-v1:0` and `org/model` are fine.
 */
export function yamlPlainScalarError(value: string, label: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return `${label} "${value.replace(/[\x00-\x1f\x7f]/g, '⏎')}" contains a line break or control character and cannot be written to config.yaml`
  }
  if (/^[-?:,\[\]{}#&*!|>'"%@\`]/.test(value)) {
    return `${label} "${value}" starts with a character YAML reserves ("${value[0]}") and cannot be written unquoted to config.yaml`
  }
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) {
    return `${label} "${value}" contains ": ", " #" or a trailing ":" and cannot be written unquoted to config.yaml`
  }
  return null
}

// Map env var name → provider, used by the /suggest route to detect which
// providers an agent has credentials for (read-only; suggestion building only).
// This is NOT the validation allowlist — see REQUIRED_KEY_BY_PROVIDER below for
// the conservative set we actually enforce on the write path.
export const ENV_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  ANTHROPIC_TOKEN: 'anthropic',
  OPENAI_API_KEY: 'openai',
  GOOGLE_API_KEY: 'google',
  VERTEX_PROJECT_ID: 'google',
  OLLAMA_BASE_URL: 'ollama',
  OPENROUTER_API_KEY: 'openrouter',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock',
  AWS_ACCESS_KEY_ID: 'bedrock',
  GLM_API_KEY: 'zai',
  ZAI_API_KEY: 'zai',
  Z_AI_API_KEY: 'zai',
}

// --- Provider serviceability (credential presence) --------------------------
//
// What actually crash-loops an agent is NOT "the model isn't in our suggestions
// list" — it's pushing a model whose provider has no configured credential for
// THIS agent (e.g. `moonshotai/kimi-k2.7-code` via openrouter when the agent
// has no OPENROUTER_API_KEY → the agent restarts onto it and crash-loops).
//
// So we validate provider-credential PRESENCE, not catalog membership. The bar
// is zero false-rejections of legitimate models: we reject a cascade entry ONLY
// when we can POSITIVELY determine its provider is un-serviceable. On any
// uncertainty we FAIL OPEN (allow the entry).

// Providers that need NO credential — always serviceable.
//   - ollama: local model server reached by base_url
//   - custom: proxy / self-hosted endpoint reached by base_url
// (The config template also rewrites provider `ollama` → `custom`.)
export const NO_KEY_PROVIDERS = new Set(['ollama', 'custom'])

// Providers we can confidently enforce: each needs exactly one well-known
// credential and authenticates only that way. If the env var is ABSENT for an
// agent, the provider is definitively un-serviceable for it.
//
// Deliberately conservative — only single-credential providers are listed.
// `google`/`gemini` are intentionally OMITTED: Google auth has several modes
// (GOOGLE_API_KEY, Vertex project + ADC, service-account JSON), so we cannot
// confidently call it un-serviceable from a single missing var → we fail open.
// `bedrock` is handled separately (AWS multi-var creds, fail-open default).
const REQUIRED_KEY_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  // Z.ai (GLM cloud) authenticates only via a GLM/ZAI key. A genuinely-local
  // GLM uses the `ollama` provider instead (no key, base_url) — kept distinct.
  zai: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
}

/**
 * Decide whether a cascade entry's provider is DEFINITIVELY un-serviceable for
 * an agent, given the set of env-var names present in that agent's .env.
 *
 * Returns true ONLY when we are confident: the provider needs a key, we know
 * which env var(s), and none of them are present. Every other case (no-key
 * provider, unknown provider, ambiguous auth, bedrock with indeterminate creds)
 * returns false → FAIL OPEN.
 */
function isProviderUnserviceable(provider: string, presentEnvVars: Set<string>): boolean {
  const p = provider.trim().toLowerCase()

  // No-key providers (or no provider supplied) are always serviceable.
  if (!p || NO_KEY_PROVIDERS.has(p)) return false

  // Bedrock uses AWS_* multi-var creds (AWS_BEARER_TOKEN_BEDROCK /
  // AWS_ACCESS_KEY_ID / AWS_PROFILE), or an instance role / ~/.aws that won't
  // appear in the agent .env at all. Presence of an AWS var would confirm it's
  // serviceable; ABSENCE is NOT proof it's un-serviceable. So we never reject
  // bedrock on env-var grounds — fail open.
  if (p === 'bedrock') return false

  const requiredVars = REQUIRED_KEY_BY_PROVIDER[p]
  if (!requiredVars) {
    // Unknown / ambiguous provider (e.g. google, gemini, nous, custom proxies):
    // we have no authoritative single credential to check → fail open.
    return false
  }

  // We know this provider needs a specific key and authenticates only that way.
  // Un-serviceable iff none of its credential vars are present.
  return !requiredVars.some((v) => presentEnvVars.has(v))
}

/**
 * Validate a list of (provider, model) cascade entries before they are written
 * to a live agent's config.yaml.
 *
 * Two checks, both deliberately conservative:
 *
 *  1. Empty / missing model id → always rejected (the unambiguous crash case).
 *  2. Provider-credential presence → an entry is rejected ONLY when its provider
 *     is DEFINITIVELY un-serviceable for this agent (we know it needs a key, we
 *     know which env var, and it is absent). All uncertainty fails open.
 *
 * `presentEnvVars` is the set of env-var NAMES configured in the agent's .env
 * (read via readAgentEnvVarNames). When omitted/empty, only the empty-id guard
 * applies — credential validation fails open entirely.
 *
 * Returns a list of human-readable error strings (empty list = valid).
 */
export function validateCascadeEntries(
  entries: CascadeEntry[],
  presentEnvVars: Set<string> = new Set()
): string[] {
  const errors: string[] = []

  // An empty set means we read NO env vars for this agent — almost always a
  // missing/unreadable .env (a live agent's .env has many vars), not a genuinely
  // keyless agent. Treating that as "no credentials" would false-reject every
  // enforced-provider model. So when the set is empty we skip credential
  // validation entirely and fail open — the empty-id guard remains the floor.
  const credCheckActive = presentEnvVars.size > 0

  for (const entry of entries) {
    const provider = (entry.provider ?? '').trim()
    const model = (entry.model ?? '').trim()

    if (!model) {
      errors.push(
        provider
          ? `Missing model id for provider "${provider}"`
          : 'Missing model id'
      )
      continue
    }

    // Both values are spliced into config.yaml unquoted. A value that is not a
    // safe one-line plain scalar can inject keys or break the file → reject.
    const scalarError =
      yamlPlainScalarError(model, 'Model') ?? (provider ? yamlPlainScalarError(provider, 'Provider') : null)
    if (scalarError) {
      errors.push(scalarError)
      continue
    }

    if (credCheckActive && isProviderUnserviceable(provider, presentEnvVars)) {
      const vars = REQUIRED_KEY_BY_PROVIDER[provider.toLowerCase()]?.join(' or ')
      errors.push(
        `Model "${model}" uses provider "${provider}", but this agent has no ` +
          `credential for it${vars ? ` (expected ${vars})` : ''}. ` +
          `Add the key before assigning this model, or the agent will crash-loop on restart.`
      )
    }
  }

  return errors
}
