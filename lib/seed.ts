import { Storage } from './services/storage'
import path from 'path'
import os from 'os'

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace('~', os.homedir())
  : path.join(os.homedir(), '.hermes-swarm-map')

const storage = new Storage(DATA_DIR)

// Default to pulling the published hermes-agent-mt image. hermesDir is only a
// hint for the opt-in local-build toggle; point it at hermes-agent-mt (not the
// retired hermes-swarm path) so it's correct if a dev enables local build.
storage.write('settings.json', {
  hermesDir: path.join(os.homedir(), 'Documents/GitHub/hermes-agent-mt'),
  dataDir: DATA_DIR,
  theme: 'light',
  composeFiles: [],
  onboarded: true,
  defaultImage: 'ghcr.io/cyborg-garden/hermes-agent-mt:latest',
  useLocalBuild: false,
})

// Harnesses are discovered live from Docker; harnesses.json only stores
// user-configured overlays (tier, platform, channel, etc.) that attach to a
// discovered container by id. Seed it empty so a fresh install shows a clean
// empty dashboard instead of 8 placeholder "bots" the user never created
// (which also read as orphan overlays with no live container behind them).
storage.write('harnesses.json', [])

// Models — static config (not discovered).
// Native Anthropic + local Ollama only. The Bedrock (LiteLLM :4100) and
// Gemini (vertex-proxy :4200) backends were retired 2026-06-04 — both were
// down/auth-failing and removed from all agent cascades.
storage.write('models.json', [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', vendor: 'anthropic', accessTier: 'admin', costClass: 'high', notes: 'Primary — direct Anthropic API.' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', vendor: 'anthropic', accessTier: 'admin', costClass: 'high', notes: 'Direct Anthropic API.' },
  { id: 'qwen3.5-9b', name: 'Qwen 3.5 9B', vendor: 'ollama', accessTier: 'open', costClass: 'local', notes: 'Local fallback (Ollama).' },
])

// People — static admin config
storage.write('people.json', [
  { id: 'p_admin', handle: '@admin', role: 'admin', surfaces: ['int_mm', 'int_tg'] },
])

// Tools, keys, surfaces, memory-scopes are discovered live — no seed data needed.
// tools.json, keys.json, surfaces.json, memory-scopes.json = user override stores only.

console.log(`Seed data written to ${DATA_DIR}`)
