/**
 * The opinionated base package (v1): what every Hermes agent Swarm Map creates
 * gets, and what an existing agent can adopt.
 *
 * Definition lives in infra/artifacts.json (one versioned file):
 *   - core artifacts (plugins/skills/hooks, `tier: core`) — every agent
 *   - packs (`tier: pack`, `pack: <name>`) — opt-in, e.g. browser-ops (captcha +
 *     browser login; plain browsing is base research, not a pack)
 *   - imagePlugins — shipped in the image, only need listing in plugins.enabled
 *   - research — required keys (from the HSM key store) + search/extract/vision
 *     + browser (camofox backend env, every surface)
 *   - surfaces — private | team | public security posture
 *   - deadEnvKeys — keys that look like guards but no runtime code reads
 * plus infra/base-package/soul-orientation.md (the SOUL block).
 *
 * Every creation path (scaffold / duplicate, full deploy, import) and the sync
 * route for existing agents call applyBasePackageToDir, so they cannot drift.
 * It is ADD-ONLY and idempotent: it installs missing core items, adds missing
 * names to lists, replaces only its own marked SOUL block, and never removes
 * or overwrites an agent's customisation. Spec:
 * nimbleco-memory/plans/2026-10-07-opinionated-base-package.md
 */
import fs from 'fs'
import path from 'path'
import {
  loadManifest,
  enabledPluginNames,
  type ArtifactEntry,
  type ArtifactsManifest,
  type ArtifactType,
} from './artifacts-manifest'
import { planArtifactSync, applyArtifactSync, type SyncResult } from './artifacts-sync'
import { ensureBlockList, readBlockList } from '../yaml-block-list'
import { upsertEnvVar } from './keys'
import type { Key } from '@/lib/types'

export const SURFACES = ['private', 'team', 'public'] as const
export type Surface = (typeof SURFACES)[number]
export const DEFAULT_SURFACE: Surface = 'team'
export function isSurface(v: unknown): v is Surface {
  return typeof v === 'string' && (SURFACES as readonly string[]).includes(v)
}

export const STAMP_FILE = '.hsm-base-package'
export const ORIENTATION_START = '<!-- hsm:base-orientation v1 -->'
export const ORIENTATION_END = '<!-- /hsm:base-orientation -->'
// Any version of our own start marker — a v2 block replaces a v1 block.
const START_RE = /<!-- hsm:base-orientation v\d+ -->/
const END_LITERAL = ORIENTATION_END

export interface BasePackageEntry extends ArtifactEntry {
  tier?: 'core' | 'pack'
  pack?: string
}

export interface SurfaceProfile {
  env: Record<string, string>
  disabledToolsets: string[]
  disabledSkills: string[]
  forbiddenPacks: string[]
  forbiddenEnv: string[]
}

export interface ResearchConfig {
  requiredKeys: { provider: string; envVar: string }[]
  searchBackendWithKey: string
  searchBackendWithoutKey: string
  extractBackend: string
  imagePackages: string[]
  vision?: { keyProvider: string; envVar: string; provider: string; model: string }
  /** Plain browsing (navigate/snapshot/click). The backend URL is wired into .env when missing. */
  browser?: { toolset: string; backend: string; envVar: string; defaultUrl: string }
}

export interface BasePackage {
  version: string
  manifest: { plugins: BasePackageEntry[]; skills: BasePackageEntry[]; hooks: BasePackageEntry[] }
  imagePlugins: string[]
  packs: Record<string, { description?: string; public?: boolean }>
  research: ResearchConfig
  surfaces: Record<Surface, SurfaceProfile>
  deadEnvKeys: string[]
}

export interface Selection {
  surface: Surface
  packs: string[]
}

export interface Stamp {
  version: string
  surface: Surface
  packs: string[]
}

const EMPTY_PROFILE: SurfaceProfile = { env: {}, disabledToolsets: [], disabledSkills: [], forbiddenPacks: [], forbiddenEnv: [] }

export function loadBasePackage(repoRoot: string = process.cwd()): BasePackage {
  const file = path.join(repoRoot, 'infra', 'artifacts.json')
  const manifest = loadManifest(file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const surfaces = {} as Record<Surface, SurfaceProfile>
  for (const s of SURFACES) surfaces[s] = { ...EMPTY_PROFILE, ...(raw.surfaces?.[s] ?? {}) }
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    throw new Error(`infra/artifacts.json: "version" must be semver, got ${JSON.stringify(raw.version)}`)
  }
  return {
    version: raw.version,
    manifest: manifest as BasePackage['manifest'],
    imagePlugins: Array.isArray(raw.imagePlugins) ? raw.imagePlugins : [],
    packs: raw.packs ?? {},
    research: raw.research ?? { requiredKeys: [], searchBackendWithKey: 'brave-free', searchBackendWithoutKey: 'ddgs', extractBackend: 'firecrawl', imagePackages: [] },
    surfaces,
    deadEnvKeys: Array.isArray(raw.deadEnvKeys) ? raw.deadEnvKeys : [],
  }
}

/** Throws on an unknown pack, or a pack the surface forbids (public + browser-ops). */
export function validateSelection(pkg: BasePackage, sel: Selection): void {
  if (!isSurface(sel.surface)) throw new Error(`Unknown surface "${sel.surface}" (expected ${SURFACES.join(' | ')})`)
  for (const p of sel.packs) {
    if (!pkg.packs[p]) throw new Error(`Unknown pack "${p}"`)
    if (pkg.surfaces[sel.surface].forbiddenPacks.includes(p) || (sel.surface === 'public' && pkg.packs[p].public === false)) {
      throw new Error(`Pack "${p}" is not allowed on a public surface`)
    }
  }
}

function inSelection(e: BasePackageEntry, sel: Selection): boolean {
  if ((e.tier ?? 'core') === 'core') return true
  return !!e.pack && sel.packs.includes(e.pack)
}

/** The artifacts manifest for this selection: core + selected packs. */
export function selectArtifacts(pkg: BasePackage, sel: Selection): ArtifactsManifest {
  return {
    plugins: pkg.manifest.plugins.filter((e) => inSelection(e, sel)),
    skills: pkg.manifest.skills.filter((e) => inSelection(e, sel)),
    hooks: pkg.manifest.hooks.filter((e) => inSelection(e, sel)),
  }
}

/** Every name that belongs in plugins.enabled: enabled local plugins + image plugins. */
export function basePluginNames(pkg: BasePackage, sel: Selection): string[] {
  return Array.from(new Set([...enabledPluginNames(selectArtifacts(pkg, sel)), ...pkg.imagePlugins]))
}

export function orientationBlock(repoRoot: string = process.cwd()): string {
  return fs.readFileSync(path.join(repoRoot, 'infra', 'base-package', 'soul-orientation.md'), 'utf-8').trimEnd() + '\n'
}

/**
 * Add the orientation block to a SOUL, or replace an older copy of it. Only
 * the text between our own markers is ever touched; the persona around it is
 * kept byte-for-byte. A start marker without an end marker means someone
 * edited it by hand — leave the file alone rather than guess.
 */
export function upsertOrientation(soul: string, block: string): { content: string; changed: boolean } {
  const start = soul.search(START_RE)
  if (start >= 0) {
    const end = soul.indexOf(END_LITERAL, start)
    if (end < 0) return { content: soul, changed: false }
    let after = end + END_LITERAL.length
    if (soul[after] === '\n') after += 1
    const content = soul.slice(0, start) + block + soul.slice(after)
    return { content, changed: content !== soul }
  }
  const base = soul.length === 0 ? '' : soul.endsWith('\n') ? soul : soul + '\n'
  return { content: `${base}${base ? '\n' : ''}${block}`, changed: true }
}

export function readStamp(dataDir: string): Stamp | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, STAMP_FILE), 'utf-8'))
    if (s && typeof s.version === 'string' && isSurface(s.surface)) {
      return { version: s.version, surface: s.surface, packs: Array.isArray(s.packs) ? s.packs : [] }
    }
  } catch {
    /* missing or malformed → never adopted */
  }
  return null
}

/**
 * The selection to use for an existing agent: an explicit request wins for the
 * surface; packs are the union of what it already has and what is asked for
 * (apply never removes a pack).
 */
export function resolveSelection(dataDir: string, req: { surface?: unknown; packs?: unknown }): Selection {
  const stamp = readStamp(dataDir)
  const surface = isSurface(req.surface) ? req.surface : stamp?.surface ?? DEFAULT_SURFACE
  const asked = Array.isArray(req.packs) ? req.packs.filter((p): p is string => typeof p === 'string') : []
  return { surface, packs: Array.from(new Set([...(stamp?.packs ?? []), ...asked])) }
}

export type StepKind = 'artifact' | 'plugins' | 'toolsets' | 'skills' | 'vision' | 'browser' | 'soul' | 'env' | 'stamp'
export interface ApplyStep {
  kind: StepKind
  target: string
  detail: string
}
export interface ApplyReport {
  version: string
  selection: Selection
  changed: boolean
  envChanged: boolean
  configChanged: boolean
  steps: ApplyStep[]
  /** artifact-level outcomes, including skips (user-modified / untracked) */
  artifacts: SyncResult[]
  /** shapes the package could not edit safely — a human should look */
  warnings: string[]
}

function readIf(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

/**
 * Public-surface reachability, from the hermes-agent-mt auth chain
 * (discord adapter _is_allowed_user + gateway authz_mixin): with
 * DISCORD_ALLOW_ALL_USERS=false, a member of the public is admitted only when
 * DISCORD_CHANNEL_SCOPED_ACCESS=true AND DISCORD_ALLOWED_CHANNELS lists real
 * channel ids ('*' and '0' are never grants). A '*' user allowlist re-opens
 * DMs. Names keys only — never values.
 */
export function publicReachabilityWarnings(env: string): string[] {
  const out: string[] = []
  const val = (k: string) => (env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim()
  const channels = val('DISCORD_ALLOWED_CHANNELS').split(',').map((c) => c.trim()).filter((c) => c && c !== '*' && c !== '0')
  if (!['true', '1', 'yes'].includes(val('DISCORD_CHANNEL_SCOPED_ACCESS').toLowerCase())) {
    out.push('public surface: DISCORD_CHANNEL_SCOPED_ACCESS is not true, so with DISCORD_ALLOW_ALL_USERS=false the bot answers nobody outside DISCORD_ALLOWED_USERS/ROLES')
  }
  if (channels.length === 0) {
    out.push('public surface: DISCORD_ALLOWED_CHANNELS has no real channel ids, so channel-scoped access admits nobody')
  }
  if (val('DISCORD_ALLOWED_USERS').split(',').some((u) => u.trim() === '*')) {
    out.push('public surface: DISCORD_ALLOWED_USERS contains "*", which re-opens DMs to everyone')
  }
  return out
}
function envValue(env: string, key: string): string | undefined {
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].trim() : undefined
}

/**
 * Apply the base package to an agent data dir. Add-only and idempotent: a
 * second run returns changed: false and writes nothing. dryRun computes the
 * same report without writing. Never touches MEMORY/USER/people, never removes
 * an artifact, list entry or env key, and never edits SOUL outside its markers.
 */
export function applyBasePackageToDir(
  dataDir: string,
  pkg: BasePackage,
  sel: Selection,
  repoRoot: string = process.cwd(),
  opts: { dryRun?: boolean; force?: boolean } = {},
): ApplyReport {
  validateSelection(pkg, sel)
  const steps: ApplyStep[] = []
  const warnings: string[] = []
  const write = (p: string, c: string, mode?: number) => {
    if (!opts.dryRun) fs.writeFileSync(p, c, mode ? { mode } : undefined)
  }

  // 1. Artifacts: install missing core/pack items; pristine-update unmodified
  //    ones; skip anything the agent changed or added itself.
  const plan = planArtifactSync(dataDir, selectArtifacts(pkg, sel), repoRoot, { force: opts.force })
  const artifacts: SyncResult[] = opts.dryRun
    ? plan.items.map((i) => ({ ...i, applied: false }))
    : applyArtifactSync(dataDir, plan, repoRoot)
  for (const a of plan.items) {
    if (a.action !== 'skip') steps.push({ kind: 'artifact', target: `${a.type}/${a.name}`, detail: `${a.action} (${a.reason})` })
  }

  // 2. config.yaml — every edit is a column-0-anchored block-list union.
  const profile = pkg.surfaces[sel.surface]
  const configPath = path.join(dataDir, 'config.yaml')
  let config = readIf(configPath)
  let configChanged = false
  if (config !== null) {
    const lists: [StepKind, string, string, string[]][] = [
      ['plugins', 'plugins', 'enabled', basePluginNames(pkg, sel)],
      ['toolsets', 'agent', 'disabled_toolsets', profile.disabledToolsets],
      ['skills', 'skills', 'disabled', profile.disabledSkills],
    ]
    for (const [kind, top, child, names] of lists) {
      if (names.length === 0) continue
      const r = ensureBlockList(config, top, child, names)
      if (r.bailed) warnings.push(`config.yaml ${top}.${child} has a shape the package will not edit; add ${names.join(', ')} by hand`)
      if (r.content !== config) {
        config = r.content
        configChanged = true
        const parts = [r.added.length ? `+ ${r.added.join(', ')}` : '', r.converted ? 'inline list → block list' : ''].filter(Boolean)
        steps.push({ kind, target: `config.yaml ${top}.${child}`, detail: parts.join('; ') })
      }
    }

    // Vision (research): only when the agent holds the vision key and has no
    // auxiliary block of its own — an existing block is the owner's choice.
    const v = pkg.research.vision
    const env = readIf(path.join(dataDir, '.env')) ?? ''
    if (v && envValue(env, v.envVar)) {
      if (!/^auxiliary:/m.test(config)) {
        config = config.replace(/\n*$/, '\n') +
          `\n# --- Vision (base package: lets text-only primaries see posted images) ---\n` +
          `auxiliary:\n  vision:\n    provider: ${v.provider}\n    model: "${v.model}"\n`
        configChanged = true
        steps.push({ kind: 'vision', target: 'config.yaml auxiliary.vision', detail: `${v.provider} ${v.model}` })
      }
    }
    if (configChanged) write(configPath, config)

    // Browser (research): add-only, so a disabled browser toolset is the
    // owner's call — but it removes plain browsing AND web_search, so say so.
    const b = pkg.research.browser
    if (b && (readBlockList(config, 'agent', 'disabled_toolsets') ?? []).includes(b.toolset)) {
      warnings.push(`config.yaml agent.disabled_toolsets has "${b.toolset}": the base package's browser toolset is disabled (no browsing, no web_search); remove it by hand`)
    }
  }

  // 3. SOUL orientation block (between markers only).
  const soulPath = path.join(dataDir, 'SOUL.md')
  const soul = readIf(soulPath)
  if (soul !== null) {
    const r = upsertOrientation(soul, orientationBlock(repoRoot))
    if (r.changed) {
      write(soulPath, r.content)
      steps.push({ kind: 'soul', target: 'SOUL.md', detail: 'orientation block added/refreshed' })
    } else if (START_RE.test(soul) && !soul.includes(END_LITERAL)) {
      warnings.push('SOUL.md has an orientation start marker without an end marker; left untouched')
    }
  }

  // 4. Surface env. The surface is an explicit operator choice, so its values
  //    are the contract (a public agent with DMs open is tightened). Nothing
  //    else in .env is touched, and nothing is removed.
  const envPath = path.join(dataDir, '.env')
  let env = readIf(envPath)
  let envChanged = false
  if (env !== null) {
    for (const [k, val] of Object.entries(profile.env)) {
      if (envValue(env, k) === val) continue
      env = upsertEnvVar(env, k, val)
      envChanged = true
      steps.push({ kind: 'env', target: `.env ${k}`, detail: `= ${val} (${sel.surface} surface)` })
    }
    // Browser backend (research layer, every surface). Only when the agent has
    // none: an existing URL (its own camofox) is kept. No CAMOFOX_USER_ID —
    // without it every session gets an ephemeral profile, so no agent shares
    // a logged-in browser profile (public forbids the key outright).
    const b = pkg.research.browser
    if (b && envValue(env, b.envVar) === undefined) {
      env = upsertEnvVar(env, b.envVar, b.defaultUrl)
      envChanged = true
      steps.push({ kind: 'browser', target: `.env ${b.envVar}`, detail: `= ${b.defaultUrl} (${b.backend} backend)` })
    }
    if (envChanged) write(envPath, env, 0o600)
    // With DISCORD_ALLOW_ALL_USERS=false and no user/role allowlist, guild
    // traffic is admitted only via channel-scoped access (adapter AND gateway
    // both check it). Without it the bot goes silent for everyone — say so.
    if (sel.surface === 'public' && /^DISCORD_BOT_TOKEN=./m.test(env)) {
      warnings.push(...publicReachabilityWarnings(env))
    }
  }

  // 5. Stamp (no timestamp — a re-run must be byte-identical).
  const stamp: Stamp = { version: pkg.version, surface: sel.surface, packs: [...sel.packs].sort() }
  const stampJson = JSON.stringify(stamp, null, 2) + '\n'
  const stampPath = path.join(dataDir, STAMP_FILE)
  if (readIf(stampPath) !== stampJson) {
    write(stampPath, stampJson)
    steps.push({ kind: 'stamp', target: STAMP_FILE, detail: `v${stamp.version} ${stamp.surface}${stamp.packs.length ? ` +${stamp.packs.join(',')}` : ''}` })
  }

  return {
    version: pkg.version,
    selection: sel,
    changed: steps.length > 0,
    envChanged,
    configChanged,
    steps,
    artifacts,
    warnings,
  }
}

// ── Research keys (key store only — never hand-written .env lines) ─────────

export interface KeyAssignmentResult {
  provider: string
  keyId?: string
  action: 'assigned' | 'already' | 'missing' | 'planned'
  /** assignedTo before this call — lets a failed create roll the registry back */
  previous?: string[]
}

type KeyStore = { list(): Key[]; setAssignment(id: string, assignedTo: string[]): string[] }

/**
 * Pick the store key for a provider: one already assigned to this harness, or
 * the fleet key (most assignments, then id for determinism).
 */
function pickKey(keys: Key[], provider: string, harnessId: string): Key | undefined {
  const mine = keys.find((k) => k.provider === provider && (k.assignedTo ?? []).includes(harnessId))
  if (mine) return mine
  return keys
    .filter((k) => k.provider === provider)
    .sort((a, b) => (b.assignedTo?.length ?? 0) - (a.assignedTo?.length ?? 0) || a.id.localeCompare(b.id))[0]
}

/**
 * Assign the package's required research keys (and optionally the vision key)
 * to a harness. Goes through setAssignment with the FULL assignedTo list, so
 * keys.json and the agent's .env move together — update() alone records the
 * assignment without writing .env.
 */
export function assignBasePackageKeys(
  keys: KeyStore,
  harnessId: string,
  pkg: BasePackage,
  opts: { dryRun?: boolean; includeVision?: boolean; skipProviders?: string[] } = {},
): KeyAssignmentResult[] {
  const providers = pkg.research.requiredKeys.map((k) => k.provider).filter((p) => !(opts.skipProviders ?? []).includes(p))
  if (opts.includeVision && pkg.research.vision) providers.push(pkg.research.vision.keyProvider)
  const all = keys.list()
  const out: KeyAssignmentResult[] = []
  for (const provider of Array.from(new Set(providers))) {
    const key = pickKey(all, provider, harnessId)
    if (!key) { out.push({ provider, action: 'missing' }); continue }
    const assigned = key.assignedTo ?? []
    if (assigned.includes(harnessId)) { out.push({ provider, keyId: key.id, action: 'already' }); continue }
    if (opts.dryRun) { out.push({ provider, keyId: key.id, action: 'planned' }); continue }
    keys.setAssignment(key.id, [...assigned, harnessId])
    out.push({ provider, keyId: key.id, action: 'assigned', previous: assigned })
  }
  return out
}

/** Whether the store can give this harness a key for every required provider. */
export function storeHasProvider(keys: { list(): Key[] }, provider: string): boolean {
  try { return keys.list().some((k) => k.provider === provider) } catch { return false }
}

/** search_backend to write at create time: brave-free with a key, ddgs without. */
export function searchBackendFor(pkg: BasePackage, hasBraveKey: boolean): string {
  return hasBraveKey ? pkg.research.searchBackendWithKey : pkg.research.searchBackendWithoutKey
}

export type { ArtifactType }
