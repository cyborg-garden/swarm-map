import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { Key, KeyInput } from '@/lib/types'
import type { Storage } from './storage'
import type { AuditService } from './audit'
import { Encryption } from './encryption'
import { assertNoNewline } from '@/lib/env-helpers'

const KEYS_FILE = 'keys.json'

type StoredKey = Key & { encryptedValue: string; manuallyAdded?: boolean }

// Overlay for user-configured fields (budget, health, assignedTo overrides)
type KeyOverride = Partial<Key> & { id: string }

function maskValue(value: string): string {
  if (value.length <= 8) return '••••'
  const prefix = value.slice(0, 4)
  const suffix = value.slice(-4)
  return `${prefix}…${suffix}`
}

// Derive a stable ID from the masked key fingerprint (first 8 + last 8 chars of value)
function fingerprintId(value: string): string {
  const fp = value.slice(0, 8) + value.slice(-8)
  return 'k_' + crypto.createHash('sha1').update(fp).digest('hex').slice(0, 8)
}

// --- Anthropic credential routing -------------------------------------------
// Anthropic accepts two credential formats that authenticate differently:
//   * Standard API keys (sk-ant-api*) → x-api-key header, which the SDK reads
//     from ANTHROPIC_API_KEY.
//   * Bearer-style tokens (sk-ant-oat* setup tokens, cc-* access tokens, JWT
//     eyJ*) → Authorization: Bearer, which the SDK reads from ANTHROPIC_TOKEN.
// The two must never both be set: the SDK auto-attaches x-api-key whenever
// ANTHROPIC_API_KEY is present — even alongside a Bearer token — producing a
// conflicting dual-header request the API rejects (HTTP 401). So a credential
// is written to exactly one of these vars and the other is cleared.
export const ANTHROPIC_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'] as const

export function anthropicEnvVarForValue(value: string): 'ANTHROPIC_API_KEY' | 'ANTHROPIC_TOKEN' {
  const v = (value ?? '').trim()
  if (v.startsWith('sk-ant-api')) return 'ANTHROPIC_API_KEY'
  if (v.startsWith('sk-ant-') || v.startsWith('cc-') || v.startsWith('eyJ')) return 'ANTHROPIC_TOKEN'
  return 'ANTHROPIC_API_KEY'
}

// --- Bluesky credential pairing ---------------------------------------------
// A Bluesky session needs (identifier, app-password): the app password is the
// single secret this key stores (→ BLUESKY_APP_PASSWORD), and the account
// handle/DID is non-secret config carried in the key's `identifier` field and
// emitted as BLUESKY_IDENTIFIER at write time. One key, two env vars — the
// same "paired vars, single key" posture as Anthropic above, except both vars
// are always written rather than one-of-two.
export const BLUESKY_ENV_VARS = ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD'] as const

// A value in our AES-256-GCM at-rest format is `iv:authTag:ciphertext`, all hex
// (see encryption.ts). Used to tell a real decrypt failure (rotated/lost .key →
// must fail loud) apart from a legacy pre-encryption plaintext value (no such
// shape → returning it as-is is correct).
const CIPHERTEXT_SHAPE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i
function looksLikeCiphertext(value: string): boolean {
  return CIPHERTEXT_SHAPE.test(value)
}

// What to return when `decrypt()` throws. D5: if the stored value is in our
// ciphertext format, decryption genuinely failed (rotated/lost .key or
// corruption) — returning the raw iv:tag:ciphertext would hand a garbage
// credential to the agent, so fail closed (undefined). If it is NOT ciphertext,
// it's a legacy plaintext value stored before encryption existed — return as-is.
function decryptFallback(storedValue: string): string | undefined {
  return looksLikeCiphertext(storedValue) ? undefined : storedValue
}

// Set VAR=value in a .env body — replacing an existing line or appending one.
// Exported for direct testing (it is a generated-file sink; see F9).
export function upsertEnvVar(content: string, varName: string, value: string): string {
  assertNoNewline(value, varName)
  const regex = new RegExp(`^${varName}=.*$`, 'm')
  if (regex.test(content)) return content.replace(regex, `${varName}=${value}`)
  return content.trimEnd() + `\n${varName}=${value}\n`
}

// Remove a VAR= line (if present) from a .env body.
function removeEnvVar(content: string, varName: string): string {
  return content.replace(new RegExp(`^${varName}=.*\\n?`, 'm'), '')
}

// Hints that let a key resolve to the right .env var name. Custom-provider keys
// carry no entry in PROVIDER_TO_VAR, so they lean on these.
type EnvVarHints = { name?: string; envVar?: string; identifier?: string }

// Coerce arbitrary text into a valid shell env-var identifier. Env var names
// must match [A-Za-z_][A-Za-z0-9_]* — in particular they cannot start with a
// digit, so a name like "2captcha" is prefixed with "_" rather than left as the
// unloadable "2CAPTCHA".
function normalizeEnvVarName(raw: string): string {
  const v = raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[0-9]/.test(v) ? `_${v}` : v
}

// Derive an env var from a custom key's display name. A bare label like
// "capsolver" becomes CAPSOLVER_API_KEY. A value the user already typed as a
// full identifier (e.g. "OPEN_MEASURES_API_KEY") is kept as-is; a human label
// that merely happens to end in a word like "Key" ("Team Key") is NOT treated
// as complete — it still gets the _API_KEY suffix ("TEAM_KEY_API_KEY").
function envVarFromName(name: string): string {
  const trimmed = name.trim()
  const alreadyIdentifier =
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) &&
    /_(API_KEY|KEY|TOKEN|URL|SECRET|ID|ACCOUNT)$/i.test(trimmed)
  if (alreadyIdentifier) return normalizeEnvVarName(trimmed)
  const norm = normalizeEnvVarName(trimmed)
  if (!norm) return ''
  return `${norm}_API_KEY`
}

type ProviderPattern = {
  varPattern: RegExp
  provider: string
  valuePattern?: RegExp
}

const PROVIDER_PATTERNS: ProviderPattern[] = [
  { varPattern: /^ANTHROPIC_API_KEY$/i, provider: 'anthropic', valuePattern: /^sk-ant-/ },
  { varPattern: /^ANTHROPIC_TOKEN$/i, provider: 'anthropic', valuePattern: /^(sk-ant-oat|cc-|eyJ)/ },
  { varPattern: /^OPENAI_API_KEY$/i, provider: 'openai', valuePattern: /^sk-/ },
  { varPattern: /^GITHUB_TOKEN$|^GITHUB_PAT$/i, provider: 'github', valuePattern: /^gh[pso]_/ },
  { varPattern: /^MATTERMOST_TOKEN$/i, provider: 'mattermost' },
  { varPattern: /^TELEGRAM_BOT_TOKEN$/i, provider: 'telegram' },
  { varPattern: /^SIGNAL_ACCOUNT$/i, provider: 'signal' },
  // Bluesky app passwords are xxxx-xxxx-xxxx-xxxx (Settings → App Passwords).
  // BLUESKY_IDENTIFIER is deliberately NOT a pattern here: it is the non-secret
  // half of the pair and must never be discovered as a key of its own.
  { varPattern: /^BLUESKY_APP_PASSWORD$/i, provider: 'bluesky', valuePattern: /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i },
  // Notion tokens: legacy `secret_` prefix or current `ntn_` prefix.
  { varPattern: /^NOTION_API_KEY$|^NOTION_TOKEN$/i, provider: 'notion', valuePattern: /^(secret_|ntn_)/ },
  { varPattern: /^AWS_ACCESS_KEY_ID$/i, provider: 'aws', valuePattern: /^AKIA/ },
  { varPattern: /^AWS_BEARER_TOKEN_BEDROCK$/i, provider: 'aws-bedrock' },
  { varPattern: /^GOOGLE_CLOUD_API_KEY$/i, provider: 'google-cloud' },
  { varPattern: /^BRAVE_SEARCH_API_KEY$/i, provider: 'brave' },
  { varPattern: /^HELIUS_API_KEY$/i, provider: 'helius' },
  { varPattern: /^COINGECKO_API_KEY$/i, provider: 'coingecko' },
  { varPattern: /^DEHASHED_API_KEY$/i, provider: 'dehashed' },
  { varPattern: /^OPENCORPORATES_API_KEY$/i, provider: 'opencorporates' },
  { varPattern: /^CAPSOLVER_API_KEY$/i, provider: 'capsolver' },
  { varPattern: /^OPEN_MEASURES_API_KEY$/i, provider: 'open-measures' },
  { varPattern: /^PEXELS_API_KEY$/i, provider: 'pexels' },
  // Z.ai (GLM). The runtime plugin accepts GLM_API_KEY / ZAI_API_KEY / Z_AI_API_KEY;
  // GLM_API_KEY is the canonical one HSM writes (see PROVIDER_TO_VAR + deploy template).
  { varPattern: /^(GLM_API_KEY|ZAI_API_KEY|Z_AI_API_KEY)$/i, provider: 'zai' },
]

function detectProvider(varName: string, value: string): string | null {
  for (const { varPattern, provider, valuePattern } of PROVIDER_PATTERNS) {
    if (varPattern.test(varName)) {
      if (!valuePattern || valuePattern.test(value)) {
        return provider
      }
      return provider // still match by var name even if value doesn't match pattern
    }
  }
  // Fallback: any var with KEY/TOKEN/SECRET/PASSWORD
  if (/KEY|TOKEN|SECRET|PASSWORD/i.test(varName)) {
    // Derive a provider name from the var name
    const name = varName
      .replace(/_?(API_KEY|API_TOKEN|TOKEN|SECRET|KEY|PASSWORD)_?/gi, '')
      .replace(/_+/g, '-')
      .toLowerCase()
      .replace(/^-+|-+$/g, '')
    return name || 'unknown'
  }
  return null
}

// Convert harness name to harness ID (matches harness.ts convention)
function nameToId(name: string): string {
  return 'h_' + name.replace(/-/g, '_')
}

// Convert harness ID back to name (h_seraph_doer → seraph-doer)
function idToName(id: string): string {
  return id.replace(/^h_/, '').replace(/_/g, '-')
}

// Agent data directory mapping
function agentDataDir(harnessName: string): string {
  if (harnessName === 'personal') {
    return path.join(os.homedir(), '.hermes')
  }
  return path.join(os.homedir(), `.hermes-${harnessName}`)
}

// Parse a .env file into key=value pairs (skip comments and empty lines)
function parseEnvFile(envPath: string): Array<{ varName: string; value: string }> {
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    const pairs: Array<{ varName: string; value: string }> = []
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const varName = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (varName && value && !value.startsWith('${')) {
        pairs.push({ varName, value })
      }
    }
    return pairs
  } catch {
    return []
  }
}

// Discover all keys from agent env files
// encryption is optional: if provided, values are encrypted before storing in the registry
function discoverKeys(harnessNames: string[], encryption?: Encryption): Map<string, { key: StoredKey; harnesses: string[] }> {
  // Deduplicate by fingerprint: same key value = same key
  const registry = new Map<string, { key: StoredKey; harnesses: string[] }>()

  for (const harnessName of harnessNames) {
    const dataDir = agentDataDir(harnessName)
    const envPath = path.join(dataDir, '.env')
    const pairs = parseEnvFile(envPath)

    // Bluesky's non-secret companion var: not a key itself (see
    // PROVIDER_PATTERNS), but a discovered app password should carry the
    // identifier it was written next to, so re-assignment round-trips both.
    const blueskyIdentifier = pairs.find((p) => /^BLUESKY_IDENTIFIER$/i.test(p.varName))?.value

    for (const { varName, value } of pairs) {
      const provider = detectProvider(varName, value)
      if (!provider) continue

      const fpId = fingerprintId(value)
      const existing = registry.get(fpId)
      if (existing) {
        if (!existing.harnesses.includes(harnessName)) {
          existing.harnesses.push(harnessName)
        }
      } else {
        const encryptedValue = encryption ? encryption.encrypt(value) : value
        const storedKey: StoredKey = {
          id: fpId,
          provider,
          ...(provider === 'bluesky' && blueskyIdentifier ? { identifier: blueskyIdentifier } : {}),
          maskedValue: maskValue(value),
          encryptedValue, // encrypted at rest; never exposed in API
          assignedTo: [],
          health: 'good',
        }
        registry.set(fpId, { key: storedKey, harnesses: [harnessName] })
      }
    }
  }

  return registry
}

export class KeysService {
  private encryption: Encryption

  constructor(
    private storage: Storage,
    private audit: AuditService,
    dataDir?: string,
  ) {
    // Use the storage directory as the data dir for the encryption key file
    const dir = dataDir ?? storage.getBaseDir()
    this.encryption = new Encryption(dir)
  }

  private defaultHarnessNames(): string[] {
    return [
      'personal',
      'cryptids',
      'cyborg',
      'egregore',
      'osint',
      'seraph-doer',
      'seraph-generalist',
      'seraph-thinker',
    ]
  }

  // Every harness name key discovery should scan: the built-in defaults PLUS any
  // harness the operator created via the app (persisted in harnesses.json). D2:
  // without the overlay names, UI-created harnesses showed zero keys forever.
  private allHarnessNames(): string[] {
    const overlays = this.storage.read<Array<{ name?: string }>>('harnesses.json', [])
    const overlayNames = overlays
      .map((o) => o.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    return Array.from(new Set([...this.defaultHarnessNames(), ...overlayNames]))
  }

  // Load user overrides (budget, health, assignedTo overrides)
  private loadOverrides(): Map<string, KeyOverride> {
    const stored = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const map = new Map<string, KeyOverride>()
    for (const s of stored) {
      const { encryptedValue: _, ...k } = s
      map.set(k.id, k)
    }
    return map
  }

  list(harnessNames?: string[]): Key[] {
    const names = harnessNames ?? this.allHarnessNames()
    const registry = discoverKeys(names, this.encryption)
    const storedAll = this.storage.read<StoredKey[]>(KEYS_FILE, [])

    // A stored key is "persistent" if it carries its own value: manual adds,
    // rotated keys, or discovered keys materialized on first edit/assign. These
    // list regardless of whether the value still lives in any .env — so
    // unassigning a key never makes it disappear. Stored keys WITHOUT a value
    // are metadata-only overrides that decorate a still-discovered key.
    const hasValue = (s: StoredKey) => typeof s.encryptedValue === 'string' && s.encryptedValue.length > 0
    const isPersistent = (s: StoredKey) => s.manuallyAdded === true || hasValue(s)

    // Build override map for (non-persistent) discovered keys
    const overrides = new Map<string, KeyOverride>()
    for (const s of storedAll) {
      if (!isPersistent(s)) {
        const { encryptedValue: _, manuallyAdded: __, ...k } = s
        overrides.set(k.id, k)
      }
    }

    // Collect persistent keys (value-bearing stored keys)
    const persistentKeys: Key[] = storedAll
      .filter(isPersistent)
      .map((s) => {
        const { encryptedValue: _, manuallyAdded: __, ...k } = s
        return k
      })
    const persistentIds = new Set(persistentKeys.map((k) => k.id))

    // Build discovered key list (skip ids already covered by a persistent entry)
    const discoveredKeys: Key[] = []
    for (const [id, { key, harnesses }] of registry) {
      if (persistentIds.has(id)) continue
      const override = overrides.get(id)
      const { encryptedValue: _, ...baseKey } = key
      const merged: Key = {
        ...baseKey,
        assignedTo: override?.assignedTo ?? harnesses.map(nameToId),
        ...(override?.budgetUsd !== undefined ? { budgetUsd: override.budgetUsd } : {}),
        ...(override?.health ? { health: override.health } : {}),
        ...(override?.name ? { name: override.name } : {}),
        ...(override?.identifier ? { identifier: override.identifier } : {}),
      }
      discoveredKeys.push(merged)
    }

    // Merge: persistent (authoritative) + discovered, deduplicated by id
    const seen = new Set<string>()
    const result: Key[] = []
    for (const k of [...persistentKeys, ...discoveredKeys]) {
      if (!seen.has(k.id)) {
        seen.add(k.id)
        result.push(k)
      }
    }

    return result.sort((a, b) => a.provider.localeCompare(b.provider))
  }

  // Map provider to env var name
  private static PROVIDER_TO_VAR: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    github: 'GITHUB_TOKEN',
    mattermost: 'MATTERMOST_TOKEN',
    telegram: 'TELEGRAM_BOT_TOKEN',
    signal: 'SIGNAL_ACCOUNT',
    // The secret half only. The identifier half is written as a side effect in
    // writeKeyToEnv (see BLUESKY_ENV_VARS).
    bluesky: 'BLUESKY_APP_PASSWORD',
    notion: 'NOTION_API_KEY',
    aws: 'AWS_ACCESS_KEY_ID',
    'aws-bedrock': 'AWS_BEARER_TOKEN_BEDROCK',
    'google-cloud': 'GOOGLE_CLOUD_API_KEY',
    brave: 'BRAVE_SEARCH_API_KEY',
    helius: 'HELIUS_API_KEY',
    coingecko: 'COINGECKO_API_KEY',
    dehashed: 'DEHASHED_API_KEY',
    opencorporates: 'OPENCORPORATES_API_KEY',
    capsolver: 'CAPSOLVER_API_KEY',
    'open-measures': 'OPEN_MEASURES_API_KEY',
    pexels: 'PEXELS_API_KEY',
    zai: 'GLM_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
  }

  // Manual add (user-input key not from a .env file)
  add(input: KeyInput & { assignedTo?: string[] }): Key {
    const stored = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const newKey: StoredKey = {
      // Fingerprint id (== the id discovery assigns) so an added+assigned key
      // collapses with its discovered twin in list() instead of duplicating.
      // (Random ids made the same token appear twice: once stored, once discovered.)
      id: fingerprintId(input.value),
      provider: input.provider,
      ...(input.name ? { name: input.name } : {}),
      ...(input.envVar ? { envVar: input.envVar } : {}),
      ...(input.identifier ? { identifier: input.identifier } : {}),
      maskedValue: maskValue(input.value),
      encryptedValue: this.encryption.encrypt(input.value),
      assignedTo: input.assignedTo ?? [],
      budgetUsd: input.budgetUsd,
      health: 'good',
      manuallyAdded: true,
    }
    // Upsert: re-adding the same value updates the entry rather than duplicating.
    const existingIdx = stored.findIndex((k) => k.id === newKey.id)
    if (existingIdx >= 0) stored[existingIdx] = newKey
    else stored.push(newKey)
    this.storage.write(KEYS_FILE, stored)
    this.audit.append({ who: 'admin', what: 'key:add', target: input.provider })
    const { encryptedValue: _, manuallyAdded: __, ...key } = newKey
    return key
  }

  // Resolve the env var a provider's credential is written to. Anthropic is
  // value-dependent (see anthropicEnvVarForValue); known providers map through
  // PROVIDER_TO_VAR. Custom/unknown providers use an explicit envVar hint, else
  // derive from the key's name so a key named "capsolver" lands in
  // CAPSOLVER_API_KEY rather than the useless CUSTOM_API_KEY fallback.
  private resolveEnvVar(provider: string, value: string, hints?: EnvVarHints): string {
    if (provider === 'anthropic') return anthropicEnvVarForValue(value)
    // A known provider always uses its canonical var. The envVar/name hints are
    // only meaningful for custom/unknown providers, so they must never redirect
    // a mapped provider (a stale hint from the UI could otherwise send e.g. a
    // Brave key to the wrong var).
    const mapped = KeysService.PROVIDER_TO_VAR[provider]
    if (mapped) return mapped
    if (hints?.envVar) {
      const explicit = normalizeEnvVarName(hints.envVar)
      if (explicit) return explicit
    }
    if (hints?.name) {
      const fromName = envVarFromName(hints.name)
      if (fromName) return fromName
    }
    return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
  }

  // Returns whether the .env changed. An already-correct .env is not rewritten.
  writeKeyToEnv(harnessIdOrName: string, provider: string, value: string, hints?: EnvVarHints): boolean {
    const name = harnessIdOrName.startsWith('h_') ? idToName(harnessIdOrName) : harnessIdOrName
    const dataDir = agentDataDir(name)
    const envPath = path.join(dataDir, '.env')

    let content = ''
    let exists = true
    try {
      content = fs.readFileSync(envPath, 'utf-8')
    } catch {
      // .env doesn't exist yet — will create
      exists = false
    }
    const original = content

    const varName = this.resolveEnvVar(provider, value, hints)
    content = upsertEnvVar(content, varName, value)

    // Anthropic's credential belongs in exactly one var depending on its format;
    // clear the other so a stale value can't add a conflicting auth header.
    if (provider === 'anthropic') {
      for (const other of ANTHROPIC_ENV_VARS) {
        if (other !== varName) content = removeEnvVar(content, other)
      }
    }

    // Bluesky is a credential PAIR: the secret app password (written above) plus
    // the non-secret account identifier from the key's metadata. Without the
    // identifier hint any existing BLUESKY_IDENTIFIER is left untouched — never
    // half-cleared — so a legacy hand-written pair keeps working.
    if (provider === 'bluesky' && hints?.identifier?.trim()) {
      content = upsertEnvVar(content, 'BLUESKY_IDENTIFIER', hints.identifier.trim())
    }

    if (exists && content === original) return false
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(envPath, content, { mode: 0o600 })
    return true
  }

  removeKeyFromEnv(harnessIdOrName: string, provider: string, hints?: EnvVarHints): void {
    const name = harnessIdOrName.startsWith('h_') ? idToName(harnessIdOrName) : harnessIdOrName
    const dataDir = agentDataDir(name)
    const envPath = path.join(dataDir, '.env')

    try {
      let content = fs.readFileSync(envPath, 'utf-8')
      // Anthropic may have been written to either var; clear both. Bluesky is a
      // pair, so both halves go — a lingering BLUESKY_IDENTIFIER without its
      // password is stale config, not a working credential. Everything else
      // resolves to the single var writeKeyToEnv would have used (custom keys
      // included, via the same name/envVar hints).
      const vars = provider === 'anthropic'
        ? [...ANTHROPIC_ENV_VARS]
        : provider === 'bluesky'
          ? [...BLUESKY_ENV_VARS]
          : [this.resolveEnvVar(provider, '', hints)]
      for (const v of vars) content = removeEnvVar(content, v)
      fs.writeFileSync(envPath, content, { mode: 0o600 })
    } catch {
      // .env doesn't exist, nothing to remove
    }
  }

  // Get the decrypted value for a key by id (internal use: restart flows, key injection)
  getDecryptedValue(id: string): string | undefined {
    // Check stored keys first
    const stored = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const key = stored.find((k) => k.id === id)
    if (key?.encryptedValue) {
      try {
        return this.encryption.decrypt(key.encryptedValue)
      } catch {
        return decryptFallback(key.encryptedValue)
      }
    }

    // Fall back to live discovery — discovered keys aren't persisted to keys.json
    // until explicitly modified, but we can read the actual value from .env files
    const names = this.allHarnessNames()
    const registry = discoverKeys(names, this.encryption)
    const discovered = registry.get(id)
    if (discovered?.key.encryptedValue) {
      try {
        return this.encryption.decrypt(discovered.key.encryptedValue)
      } catch {
        return decryptFallback(discovered.key.encryptedValue)
      }
    }

    return undefined
  }

  update(id: string, partial: Partial<Key>): Key | undefined {
    const stored = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const index = stored.findIndex((k) => k.id === id)
    if (index !== -1) {
      stored[index] = { ...stored[index], ...partial }
    } else {
      // First time a discovered key is modified: materialize it as a persistent
      // stored key, capturing its current value. The value is still in the .env
      // at this point (the route strips it only afterwards), so getDecryptedValue
      // can resolve it. Previously this stored an empty-value override, so once
      // the value left the last .env the key vanished from list() entirely and
      // could not be re-assigned.
      const discovered = this.list().find((k) => k.id === id)
      const decrypted = this.getDecryptedValue(id)
      stored.push({
        id,
        provider: partial.provider ?? discovered?.provider ?? 'unknown',
        maskedValue: partial.maskedValue ?? discovered?.maskedValue ?? '••••',
        encryptedValue: decrypted ? this.encryption.encrypt(decrypted) : '',
        assignedTo: partial.assignedTo ?? discovered?.assignedTo ?? [],
        ...(partial.budgetUsd !== undefined
          ? { budgetUsd: partial.budgetUsd }
          : discovered?.budgetUsd !== undefined
            ? { budgetUsd: discovered.budgetUsd }
            : {}),
        ...(partial.name ? { name: partial.name } : discovered?.name ? { name: discovered.name } : {}),
        ...(partial.envVar ? { envVar: partial.envVar } : discovered?.envVar ? { envVar: discovered.envVar } : {}),
        ...(partial.identifier ? { identifier: partial.identifier } : discovered?.identifier ? { identifier: discovered.identifier } : {}),
        health: partial.health ?? discovered?.health ?? 'good',
      })
    }
    this.storage.write(KEYS_FILE, stored)
    return this.list().find((k) => k.id === id)
  }

  // Assign a key to exactly `assignedTo`, keeping every affected agent's .env in
  // lockstep with keys.json: write the value into newly-assigned agents and strip
  // it from dropped ones. This is the single consistent assignment primitive —
  // callers must NOT set `assignedTo` via update() alone, which records the
  // assignment without touching .env and drifts the registry from the fleet (a
  // key shows assigned but its var never reaches the agent).
  //
  // Returns the harness ids whose .env changed (added ∪ removed) so the caller
  // can recreate those containers (env_file is read at container creation, not on
  // a plain restart).
  setAssignment(id: string, assignedTo: string[]): string[] {
    const before = this.list().find((k) => k.id === id)
    if (!before) return []
    const prev = before.assignedTo ?? []
    const next = assignedTo ?? []
    const added = next.filter((h) => !prev.includes(h))
    const removed = prev.filter((h) => !next.includes(h))

    // Persist the new assignment (materializes a discovered key if needed).
    this.update(id, { assignedTo: next })

    const value = this.getDecryptedValue(id)
    const hints: EnvVarHints = { name: before.name, envVar: before.envVar, identifier: before.identifier }
    if (value) {
      for (const h of added) this.writeKeyToEnv(h, before.provider, value, hints)
    }
    for (const h of removed) this.removeKeyFromEnv(h, before.provider, hints)

    return [...added, ...removed]
  }

  // Rewrite an assigned key's value into its agents' .env files. setAssignment
  // syncs only the diff of an assignment, so it cannot repair an agent that is
  // assigned on paper but never received the var (e.g. capsolver on personal,
  // written as CUSTOM_API_KEY before #151 and never rewritten). This can.
  //
  // `harnessIds` narrows the resync; ids the key is not assigned to are
  // reported in `notAssigned` and never written. Legacy misnamed vars are left
  // in place. Returns undefined for an unknown key. `changed` lists the
  // harnesses whose .env changed, so the caller recreates only those.
  resync(id: string, harnessIds?: string[]): { changed: string[]; notAssigned: string[]; noValue: boolean } | undefined {
    const key = this.list().find((k) => k.id === id)
    if (!key) return undefined
    const assigned = key.assignedTo ?? []
    const targets = harnessIds ? harnessIds.filter((h) => assigned.includes(h)) : assigned
    const notAssigned = harnessIds ? harnessIds.filter((h) => !assigned.includes(h)) : []

    const value = this.getDecryptedValue(id)
    const changed: string[] = []
    if (value) {
      const hints: EnvVarHints = { name: key.name, envVar: key.envVar, identifier: key.identifier }
      for (const h of targets) {
        if (this.writeKeyToEnv(h, key.provider, value, hints)) changed.push(h)
      }
    }
    this.audit.append({ who: 'admin', what: 'key:resync', target: key.provider, meta: { changed } })
    return { changed, notAssigned, noValue: !value }
  }

  rotateValue(id: string, newValue: string, updates?: Partial<Key>): Key | undefined {
    // Read stored keys and deduplicate by ID (cleanup from prior bugs)
    const raw = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const seen = new Set<string>()
    const stored: StoredKey[] = []
    for (const k of raw) {
      if (!seen.has(k.id)) { seen.add(k.id); stored.push(k) }
    }

    let index = stored.findIndex((k) => k.id === id)

    // Key might be discovered (from .env scan) but not in stored file — look it up and add it
    if (index === -1) {
      const discovered = this.list().find((k) => k.id === id)
      if (!discovered) return undefined
      const decrypted = this.getDecryptedValue(id)
      stored.push({
        id: discovered.id,
        provider: discovered.provider,
        maskedValue: discovered.maskedValue,
        encryptedValue: decrypted ? this.encryption.encrypt(decrypted) : '',
        assignedTo: discovered.assignedTo,
        health: discovered.health,
        ...(discovered.name ? { name: discovered.name } : {}),
        ...(discovered.identifier ? { identifier: discovered.identifier } : {}),
        ...(discovered.budgetUsd !== undefined ? { budgetUsd: discovered.budgetUsd } : {}),
      })
      index = stored.length - 1
    }

    const key = stored[index]
    const encryptedValue = this.encryption.encrypt(newValue)
    const newFpId = fingerprintId(newValue)

    // Determine final assignedTo (from updates or existing)
    const finalAssignedTo = updates?.assignedTo ?? key.assignedTo

    // Update stored entry with new value + fingerprint-based ID + any metadata updates
    stored[index] = {
      ...key,
      id: newFpId,
      encryptedValue,
      maskedValue: maskValue(newValue),
      assignedTo: finalAssignedTo,
      ...(updates?.name !== undefined ? { name: updates.name } : {}),
      ...(updates?.envVar !== undefined ? { envVar: updates.envVar } : {}),
      ...(updates?.identifier !== undefined ? { identifier: updates.identifier } : {}),
      ...(updates?.budgetUsd !== undefined ? { budgetUsd: updates.budgetUsd } : {}),
    }
    this.storage.write(KEYS_FILE, stored)

    // Write new value to all assigned harnesses' .env files
    const rotatedHints: EnvVarHints = {
      name: updates?.name ?? key.name,
      envVar: updates?.envVar ?? key.envVar,
      identifier: updates?.identifier ?? key.identifier,
    }
    for (const harnessId of finalAssignedTo) {
      this.writeKeyToEnv(harnessId, key.provider, newValue, rotatedHints)
    }

    // Remove from harnesses that were unassigned
    if (updates?.assignedTo) {
      const removed = key.assignedTo.filter((h) => !updates.assignedTo!.includes(h))
      for (const harnessId of removed) {
        this.removeKeyFromEnv(harnessId, key.provider, rotatedHints)
      }
    }

    this.audit.append({ who: 'admin', what: 'key:rotate', target: key.provider })
    return this.list().find((k) => k.id === newFpId)
  }

  remove(id: string): boolean {
    const stored = this.storage.read<StoredKey[]>(KEYS_FILE, [])
    const key = stored.find((k) => k.id === id)
    if (!key) return false
    // Strip the credential from every agent it was assigned to, so deleting a key
    // in HSM actually removes it from the running fleet's .env — not just the
    // registry. Otherwise a "deleted" key keeps authenticating from stale .env
    // files. Callers should read the key's `assignedTo` before removing and
    // recreate those harnesses afterward.
    for (const harnessId of key.assignedTo ?? []) {
      this.removeKeyFromEnv(harnessId, key.provider, { name: key.name, envVar: key.envVar, identifier: key.identifier })
    }
    const filtered = stored.filter((k) => k.id !== id)
    this.storage.write(KEYS_FILE, filtered)
    this.audit.append({ who: 'admin', what: 'key:remove', target: key.provider })
    return true
  }
}
