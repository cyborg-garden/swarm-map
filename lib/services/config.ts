import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Settings, Model, Person, Surface, ModelAutoUpdateSettings } from '@/lib/types'
import type { Storage } from './storage'
import { assertNoNewline } from '@/lib/env-helpers'

/**
 * Validate a settings patch against an explicit allowlist before it is merged
 * into stored settings (P3/F6). Rejects unknown keys, wrong types, out-of-range
 * ports, and newline-bearing strings (path/image/host values that flow into
 * filesystem scans and generated compose files). Returns a patch containing only
 * known, well-typed keys. Throws on any violation.
 */
export function validateSettingsPatch(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('settings patch must be a JSON object')
  }
  const out: Partial<Settings> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    switch (key) {
      case 'hermesDir':
      case 'dataDir':
      case 'defaultImage':
      case 'vncBindHost':
      case 'controlBindHost':
        if (typeof value !== 'string') throw new Error(`${key} must be a string`)
        assertNoNewline(value, key)
        out[key] = value
        break
      case 'theme':
        if (value !== 'light' && value !== 'dark') throw new Error('theme must be "light" or "dark"')
        out.theme = value
        break
      case 'composeFiles':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          throw new Error('composeFiles must be an array of strings')
        }
        ;(value as string[]).forEach((v, i) => assertNoNewline(v, `composeFiles[${i}]`))
        out.composeFiles = value as string[]
        break
      case 'onboarded':
      case 'useLocalBuild':
      case 'localApiEnabled':
        if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
        out[key] = value
        break
      case 'localApiPort':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('localApiPort must be an integer between 1 and 65535')
        }
        out.localApiPort = value
        break
      case 'modelAutoUpdate':
        out.modelAutoUpdate = validateModelAutoUpdate(value)
        break
      default:
        throw new Error(`unknown settings key: ${key}`)
    }
  }
  return out
}

export const DEFAULT_MODEL_AUTO_UPDATE: ModelAutoUpdateSettings = {
  enabled: false,
  mode: 'notify',
  intervalHours: 24,
  maxPriceMultiplier: 1.5,
}

/**
 * Validate a full modelAutoUpdate block. Every field is required and typed —
 * callers that accept a partial (PUT /api/settings/model-auto-update) merge it
 * over the current block first, then validate the result.
 */
export function validateModelAutoUpdate(input: unknown): ModelAutoUpdateSettings {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('modelAutoUpdate must be a JSON object')
  }
  const v = input as Record<string, unknown>
  for (const key of Object.keys(v)) {
    if (!(key in DEFAULT_MODEL_AUTO_UPDATE)) throw new Error(`unknown modelAutoUpdate key: ${key}`)
  }
  if (typeof v.enabled !== 'boolean') throw new Error('modelAutoUpdate.enabled must be a boolean')
  if (v.mode !== 'notify' && v.mode !== 'apply') throw new Error('modelAutoUpdate.mode must be "notify" or "apply"')
  if (typeof v.intervalHours !== 'number' || !Number.isFinite(v.intervalHours) || v.intervalHours <= 0) {
    throw new Error('modelAutoUpdate.intervalHours must be a positive number')
  }
  if (typeof v.maxPriceMultiplier !== 'number' || !Number.isFinite(v.maxPriceMultiplier) || v.maxPriceMultiplier <= 0) {
    throw new Error('modelAutoUpdate.maxPriceMultiplier must be a positive number')
  }
  return {
    enabled: v.enabled,
    mode: v.mode,
    intervalHours: v.intervalHours,
    maxPriceMultiplier: v.maxPriceMultiplier,
  }
}

const SETTINGS_FILE = 'settings.json'
const MODELS_FILE = 'models.json'
const PEOPLE_FILE = 'people.json'

const DEFAULT_SETTINGS: Settings = {
  hermesDir: '~/Documents/GitHub/hermes-agent-mt',
  dataDir: '~/.hermes-swarm-map',
  theme: 'light',
  composeFiles: [],
  defaultImage: 'ghcr.io/cyborg-garden/hermes-agent-mt:latest',
  // Pull the published image by default — a fresh install has no local hermes
  // source checkout to build from. Local build is an opt-in dev toggle (Settings).
  useLocalBuild: false,
  vncBindHost: '127.0.0.1',
  controlBindHost: '127.0.0.1',
}

// Agent data directory mapping
function agentDataDir(harnessName: string): string {
  if (harnessName === 'personal') {
    return path.join(os.homedir(), '.hermes')
  }
  return path.join(os.homedir(), `.hermes-${harnessName}`)
}

// Parse a .env file, return key→value map (raw, unmasked — for internal use only)
function parseEnvFile(envPath: string): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const varName = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (varName && value && !value.startsWith('${')) {
        result[varName] = value
      }
    }
  } catch {
    // no .env or can't read
  }
  return result
}

const DEFAULT_HARNESS_NAMES = [
  'personal',
  'cryptids',
  'cyborg',
  'egregore',
  'osint',
  'seraph-doer',
  'seraph-generalist',
  'seraph-thinker',
]

export class ConfigService {
  constructor(private storage: Storage) {}

  getSettings(): Settings {
    return this.storage.read<Settings>(SETTINGS_FILE, DEFAULT_SETTINGS)
  }

  updateSettings(partial: Partial<Settings>): Settings {
    const validated = validateSettingsPatch(partial)
    const current = this.getSettings()
    const updated = { ...current, ...validated }
    this.storage.write(SETTINGS_FILE, updated)
    return updated
  }

  /** The model-update policy with defaults filled in (never undefined). */
  getModelAutoUpdate(): ModelAutoUpdateSettings {
    return { ...DEFAULT_MODEL_AUTO_UPDATE, ...(this.getSettings().modelAutoUpdate ?? {}) }
  }

  /** Merge a partial policy over the current one, validate, persist. Throws on a bad patch. */
  updateModelAutoUpdate(partial: unknown): ModelAutoUpdateSettings {
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      throw new Error('modelAutoUpdate must be a JSON object')
    }
    const merged = validateModelAutoUpdate({ ...this.getModelAutoUpdate(), ...(partial as Record<string, unknown>) })
    return this.updateSettings({ modelAutoUpdate: merged }).modelAutoUpdate ?? merged
  }

  listModels(): Model[] {
    return this.storage.read<Model[]>(MODELS_FILE, [])
  }

  updateModel(id: string, partial: Partial<Model>): Model | undefined {
    const models = this.listModels()
    const index = models.findIndex((m) => m.id === id)
    if (index === -1) return undefined
    models[index] = { ...models[index], ...partial }
    this.storage.write(MODELS_FILE, models)
    return models[index]
  }

  listPeople(): Person[] {
    return this.storage.read<Person[]>(PEOPLE_FILE, [])
  }

  listSurfaces(harnessNames?: string[]): Surface[] {
    const names = harnessNames ?? DEFAULT_HARNESS_NAMES

    // Per-harness surfaces — each harness owns its own surface instances.
    // No cross-harness leaking of phone numbers, tokens, or URLs.
    const surfaces: Surface[] = []
    const seenPlatforms = new Set<string>()

    for (const name of names) {
      const dataDir = agentDataDir(name)
      const envPath = path.join(dataDir, '.env')
      const env = parseEnvFile(envPath)
      const harnessId = `h_${name.replace(/-/g, '_')}`

      if (env['MATTERMOST_TOKEN'] || env['MATTERMOST_URL']) {
        seenPlatforms.add('mattermost')
        surfaces.push({
          id: `int_mm_${name}`,
          platform: 'mattermost',
          name: 'Mattermost',
          status: 'connected',
          config: { url: env['MATTERMOST_URL'] || '' },
          harnessIds: [harnessId],
        })
      }

      if (env['TELEGRAM_BOT_TOKEN']) {
        seenPlatforms.add('telegram')
        surfaces.push({
          id: `int_tg_${name}`,
          platform: 'telegram',
          name: 'Telegram',
          status: 'connected',
          config: {},
          harnessIds: [harnessId],
        })
      }

      if (env['SIGNAL_ACCOUNT'] && env['SIGNAL_HTTP_URL']) {
        seenPlatforms.add('signal')
        surfaces.push({
          id: `int_sg_${name}`,
          platform: 'signal',
          name: 'Signal',
          status: 'connected',
          config: { phone: env['SIGNAL_ACCOUNT'], url: env['SIGNAL_HTTP_URL'] },
          harnessIds: [harnessId],
        })
      }

      if (env['DISCORD_BOT_TOKEN']) {
        seenPlatforms.add('discord')
        surfaces.push({
          id: `int_dc_${name}`,
          platform: 'discord',
          name: 'Discord',
          status: 'connected',
          config: {},
          harnessIds: [harnessId],
        })
      }

      // Slack needs BOTH tokens (bot for API, app for the Socket Mode websocket).
      if (env['SLACK_BOT_TOKEN'] && env['SLACK_APP_TOKEN']) {
        seenPlatforms.add('slack')
        surfaces.push({
          id: `int_sl_${name}`,
          platform: 'slack',
          name: 'Slack',
          status: 'connected',
          config: {},
          harnessIds: [harnessId],
        })
      }
    }

    // Add available (not yet connected) platform stubs for platforms
    // that at least one harness uses, so the "Available" section shows them
    // for harnesses that haven't connected yet.
    if (seenPlatforms.has('mattermost')) {
      surfaces.push({ id: 'int_mm_available', platform: 'mattermost', name: 'Mattermost', status: 'available', config: {}, harnessIds: [] })
    } else {
      surfaces.push({ id: 'int_mm', platform: 'mattermost', name: 'Mattermost', status: 'planned', config: {}, harnessIds: [] })
    }

    if (seenPlatforms.has('telegram')) {
      surfaces.push({ id: 'int_tg_available', platform: 'telegram', name: 'Telegram', status: 'available', config: {}, harnessIds: [] })
    } else {
      surfaces.push({ id: 'int_tg', platform: 'telegram', name: 'Telegram', status: 'planned', config: {}, harnessIds: [] })
    }

    if (seenPlatforms.has('signal')) {
      surfaces.push({ id: 'int_sg_available', platform: 'signal', name: 'Signal', status: 'available', config: {}, harnessIds: [] })
    } else {
      surfaces.push({ id: 'int_sg', platform: 'signal', name: 'Signal', status: 'planned', config: {}, harnessIds: [] })
    }

    if (seenPlatforms.has('discord')) {
      surfaces.push({ id: 'int_dc_available', platform: 'discord', name: 'Discord', status: 'available', config: {}, harnessIds: [] })
    } else {
      surfaces.push({ id: 'int_dc', platform: 'discord', name: 'Discord', status: 'planned', config: {}, harnessIds: [] })
    }

    if (seenPlatforms.has('slack')) {
      surfaces.push({ id: 'int_sl_available', platform: 'slack', name: 'Slack', status: 'available', config: {}, harnessIds: [] })
    } else {
      surfaces.push({ id: 'int_sl', platform: 'slack', name: 'Slack', status: 'planned', config: {}, harnessIds: [] })
    }

    return surfaces
  }
}
