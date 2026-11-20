/**
 * The real config.yaml shapes on the fleet (read on a live host, 2026-09-22),
 * block style, with the surrounding keys a live file has. Both conventions
 * coexist:
 *
 *  - primary NOT repeated in fallback_providers (ember, matilde, heron —
 *    hand-edited, or written by `hermes fallback`)
 *  - primary repeated as fallback_providers[0] (badger/harbor/ledger,
 *    kestrel — saved by the HSM editor, which wrote that convention)
 *
 * The runtime reads the primary from model.provider / model.default and the
 * fallbacks from fallback_providers in order; a row identical to the current
 * (provider, model) is skipped. So neither convention is wrong, and a no-op
 * save over ANY of these must be byte-identical.
 */
export const OLLAMA_URL = 'http://host.docker.internal:11434/v1'

export const EMBER = [
  '# Hermes agent config — ember',
  'model:',
  '  provider: openrouter',
  '  default: z-ai/glm-5.3',
  '',
  'fallback_providers:',
  '  - provider: anthropic',
  '    model: claude-sonnet-4-6',
  '  - provider: openrouter',
  '    model: anthropic/claude-sonnet-4.6',
  '  - provider: openrouter',
  '    model: deepseek/deepseek-v4-flash-0731',
  '  - provider: ollama',
  '    model: qwen3.5:9b',
  `    base_url: ${OLLAMA_URL}`,
  '',
  '# --- Context compression ---',
  'compression:',
  '  enabled: true',
  '',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '',
].join('\n')

export const MATILDE = [
  'model:',
  '  provider: openrouter',
  '  default: moonshotai/kimi-k3',
  'fallback_providers:',
  '  - provider: openrouter',
  '    model: z-ai/glm-5.3',
  '  - provider: anthropic',
  '    model: claude-sonnet-5',
  '  - provider: openrouter',
  '    model: anthropic/claude-sonnet-5',
  '  - provider: openrouter',
  '    model: deepseek/deepseek-v4-flash-0731',
  '  - provider: ollama',
  '    model: qwen3:30b',
  `    base_url: ${OLLAMA_URL}`,
  'platforms:',
  '  telegram:',
  '    enabled: true',
  '',
].join('\n')

/** badger / harbor / ledger: HSM-saved, primary duplicated as row 0. */
export const BADGER = [
  'model:',
  '  provider: openrouter',
  '  default: z-ai/glm-5.3',
  'fallback_providers:',
  '  - provider: openrouter',
  '    model: z-ai/glm-5.3',
  '  - provider: anthropic',
  '    model: claude-sonnet-4-6',
  '  - provider: ollama',
  '    model: qwen3:30b',
  `    base_url: ${OLLAMA_URL}`,
  '',
  '# --- Platforms (chat surfaces the gateway starts) ---',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '',
].join('\n')

/** kestrel: duplicate only — the primary is the ONLY row. */
export const KESTREL = [
  'model:',
  '  provider: openrouter',
  '  default: z-ai/glm-5.2',
  'fallback_providers:',
  '  - provider: openrouter',
  '    model: z-ai/glm-5.2',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '',
].join('\n')

export const HERON = [
  'model:',
  '  provider: openrouter',
  '  default: z-ai/glm-5.3',
  '  api_mode: chat',
  'fallback_providers:',
  '  - provider: openrouter',
  '    model: moonshotai/kimi-k3',
  '  - provider: anthropic',
  '    model: claude-sonnet-4-6',
  '',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '',
].join('\n')

/**
 * P2 (a personal instance): the hermes "new format" scalar `model: <id>`
 * with the primary's provider and base_url as ROOT-level siblings. hermes
 * reads them the way it reads model.provider / model.base_url when the
 * model: section lacks the key (_normalize_root_model_keys, fallback-only)
 * and drops the root keys on its next save. So the primary here IS
 * ollama / qwen3:30b @ OLLAMA_URL, and a cloud primary that replaces it must
 * take the root base_url with it.
 */
export const P2 = [
  'model: qwen3:30b',
  'provider: ollama',
  `base_url: ${OLLAMA_URL}`,
  'fallback_providers:',
  '  - provider: anthropic',
  '    model: claude-sonnet-4-6',
  'platforms:',
  '  discord:',
  '    enabled: true',
  '',
].join('\n')

export const FLEET_SHAPES: Record<string, string> = { ember: EMBER, matilde: MATILDE, badger: BADGER, kestrel: KESTREL, heron: HERON, p2: P2 }
