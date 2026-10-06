/**
 * Report-only drift between an agent's data dir and the base package.
 *
 * Reads files, writes nothing, fixes nothing — a human runs
 * POST /api/harnesses/:id/artifacts/sync to adopt. Findings name keys and
 * files only; secret VALUES are never read into a finding.
 */
import fs from 'fs'
import path from 'path'
import { hashArtifactTree } from './artifacts-sync'
import { readBlockList } from '../yaml-block-list'
import { basePluginNames, selectArtifacts, readStamp, publicReachabilityWarnings, DEFAULT_SURFACE, type BasePackage, type Surface } from './base-package'
import type { Key } from '@/lib/types'

export type DriftSeverity = 'error' | 'warn' | 'info'
export interface DriftFinding {
  id: string
  severity: DriftSeverity
  message: string
}
export interface DriftReport {
  ok: boolean
  packageVersion: string
  agentVersion: string | null
  surface: Surface
  surfaceFromStamp: boolean
  findings: DriftFinding[]
}

// Where each model provider's credential lives in .env (fallback rows).
// Unknown providers are skipped rather than guessed — no false alarms.
const PROVIDER_ENV: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  zai: ['GLM_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
}

function readIf(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

/** Present AND non-empty. Returns a boolean only — never the value. */
function hasEnv(env: string, key: string): boolean {
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return !!m && m[1].trim() !== ''
}
function envEquals(env: string, key: string, val: string): boolean {
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return !!m && m[1].trim() === val
}

/** Lines of a column-0 `<topKey>:` block (children only), or null. */
function blockLines(config: string, topKey: string): string[] | null {
  const lines = config.replace(/\r\n/g, '\n').split('\n')
  const top = lines.findIndex((l) => new RegExp(`^${topKey}:\\s*(#.*)?$`).test(l))
  if (top < 0) return null
  const out: string[] = []
  for (let i = top + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith('#')) break
    out.push(lines[i])
  }
  return out
}

/** `<topKey>:` → `  <child>: value` scalar. */
function readScalar(config: string, topKey: string, child: string): string | null {
  for (const l of blockLines(config, topKey) ?? []) {
    const m = l.match(new RegExp(`^\\s+${child}:\\s*["']?([^"'#\\s]+)`))
    if (m) return m[1]
  }
  return null
}

/** provider names from `fallback_providers:` rows. */
function fallbackProviders(config: string): string[] {
  const out: string[] = []
  for (const l of blockLines(config, 'fallback_providers') ?? []) {
    const m = l.match(/^\s*(?:-\s+)?provider:\s*["']?([A-Za-z0-9_-]+)/)
    if (m) out.push(m[1])
  }
  return out
}

function semverLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  }
  return false
}

export function checkBasePackageDrift(
  dataDir: string,
  pkg: BasePackage,
  ctx: { harnessId: string; keys?: Key[]; repoRoot?: string },
): DriftReport {
  const repoRoot = ctx.repoRoot ?? process.cwd()
  const findings: DriftFinding[] = []
  const add = (id: string, severity: DriftSeverity, message: string) => findings.push({ id, severity, message })

  const stamp = readStamp(dataDir)
  const surface: Surface = stamp?.surface ?? DEFAULT_SURFACE
  const sel = { surface, packs: stamp?.packs ?? [] }
  const config = readIf(path.join(dataDir, 'config.yaml')) ?? ''
  const env = readIf(path.join(dataDir, '.env')) ?? ''
  const soul = readIf(path.join(dataDir, 'SOUL.md'))

  // ── version ──────────────────────────────────────────────────────────────
  if (!stamp) add('not-adopted', 'warn', `No ${'.hsm-base-package'} stamp: this agent never adopted the base package (surface assumed ${surface}).`)
  else if (semverLess(stamp.version, pkg.version)) add('version-behind', 'warn', `Base package v${stamp.version} < v${pkg.version}.`)

  // ── plugins ──────────────────────────────────────────────────────────────
  if ((blockLines(config, 'plugins') ?? []).some((l) => /^\s+enabled:\s*\[/.test(l))) {
    add('inline-plugins-enabled', 'error', 'plugins.enabled is an inline list; the runtime loads none of it. Sync rewrites it as a block list.')
  }
  const enabled = new Set(readBlockList(config, 'plugins', 'enabled') ?? [])
  const selected = selectArtifacts(pkg, sel)
  for (const p of selected.plugins) {
    const dir = path.join(dataDir, 'plugins', p.name)
    if (p.enabled && !fs.existsSync(dir)) add('core-plugin-missing', 'warn', `Plugin ${p.name} is not installed.`)
    if (p.source === 'local' && fs.existsSync(dir)) {
      const src = path.join(repoRoot, 'infra', 'templates', 'plugins', p.name)
      if (fs.existsSync(src) && hashArtifactTree(dir) !== hashArtifactTree(src)) {
        add('core-plugin-diverged', 'info', `Plugin ${p.name} differs from the shipped copy (customised or older).`)
      }
    }
  }
  for (const name of basePluginNames(pkg, sel)) {
    if (!enabled.has(name)) add('core-plugin-not-enabled', 'warn', `${name} is not in plugins.enabled.`)
  }
  for (const s of selected.skills) {
    if (!fs.existsSync(path.join(dataDir, 'skills', s.name))) add('core-skill-missing', 'warn', `Skill ${s.name} is not installed.`)
  }

  // ── SOUL ─────────────────────────────────────────────────────────────────
  if (soul !== null && !/<!-- hsm:base-orientation v\d+ -->/.test(soul)) {
    add('orientation-missing', 'warn', 'SOUL.md has no base-package orientation block.')
  }

  // ── research keys ────────────────────────────────────────────────────────
  for (const rk of pkg.research.requiredKeys) {
    const inEnv = hasEnv(env, rk.envVar)
    if (!inEnv) add('required-key-missing', 'error', `${rk.envVar} (${rk.provider}) is not in .env.`)
    if (ctx.keys) {
      const assigned = ctx.keys.some((k) => k.provider === rk.provider && (k.assignedTo ?? []).includes(ctx.harnessId))
      if (assigned !== inEnv) {
        add('key-assignment-mismatch', 'warn', assigned
          ? `Key store assigns a ${rk.provider} key to ${ctx.harnessId} but ${rk.envVar} is not in .env.`
          : `${rk.envVar} is in .env but the key store does not assign a ${rk.provider} key to ${ctx.harnessId} (hand-edited .env).`)
      }
    }
  }
  const search = readScalar(config, 'web', 'search_backend')
  const braveVar = pkg.research.requiredKeys.find((k) => k.provider === 'brave')?.envVar ?? 'BRAVE_SEARCH_API_KEY'
  if (search === pkg.research.searchBackendWithKey && !hasEnv(env, braveVar)) {
    add('search-without-key', 'error', `web.search_backend is ${search} but ${braveVar} is missing: web search returns nothing.`)
  }
  if (search === pkg.research.searchBackendWithoutKey) {
    add('search-needs-image-package', 'info', `web.search_backend is ${search}; it works only if the image bakes the "${search}" package (lazy installs are off).`)
  }

  // ── dead keys, fallback rows ─────────────────────────────────────────────
  for (const k of pkg.deadEnvKeys) {
    if (new RegExp(`^${k}=`, 'm').test(env)) add('dead-env-key', 'warn', `${k} is set but no runtime code reads it — it is not a guard.`)
  }
  for (const prov of fallbackProviders(config)) {
    const vars = PROVIDER_ENV[prov]
    if (vars && !vars.some((v) => hasEnv(env, v))) {
      add('fallback-without-key', 'warn', `fallback_providers row "${prov}" has no credential in .env; that fallback can never succeed.`)
    }
  }

  // ── surface profile ──────────────────────────────────────────────────────
  const profile = pkg.surfaces[surface]
  for (const [k, v] of Object.entries(profile.env)) {
    if (!envEquals(env, k, v)) {
      add(surface === 'public' && k === 'DISCORD_ALLOW_ALL_USERS' ? 'public-dms-reachable' : 'surface-env', 'error',
        `${surface} surface requires ${k}=${v}.`)
    }
  }
  if (surface === 'public' && /^DISCORD_BOT_TOKEN=./m.test(env)) {
    for (const w of publicReachabilityWarnings(env)) add('public-unreachable', 'error', w)
  }
  // The runtime reads agent.disabled_toolsets only; a column-0
  // `disabled_toolsets:` looks like a guard and disables nothing.
  if (/^disabled_toolsets:/m.test(config)) {
    add('dead-toplevel-disabled-toolsets', 'warn', 'Top-level disabled_toolsets is ignored by the runtime (only agent.disabled_toolsets is read); those toolsets are still enabled.')
  }
  if (profile.disabledToolsets.length) {
    const disabled = new Set(readBlockList(config, 'agent', 'disabled_toolsets') ?? [])
    const missing = profile.disabledToolsets.filter((t) => !disabled.has(t))
    if (missing.length) add(`${surface}-toolset-enabled`, 'error', `${surface} surface requires these toolsets disabled: ${missing.join(', ')}.`)
  }
  if (profile.disabledSkills.length) {
    const disabled = new Set(readBlockList(config, 'skills', 'disabled') ?? [])
    const missing = profile.disabledSkills.filter((t) => !disabled.has(t))
    if (missing.length) add(`${surface}-skills-not-pruned`, 'warn', `${missing.length} skills outside the ${surface} allowlist are still enabled.`)
  }
  for (const packName of profile.forbiddenPacks) {
    for (const t of ['plugins', 'skills', 'hooks'] as const) {
      for (const e of pkg.manifest[t]) {
        if (e.pack === packName && fs.existsSync(path.join(dataDir, t, e.name))) {
          add(`${surface}-forbidden-artifact`, 'error', `${t}/${e.name} (${packName} pack) is installed on a ${surface} agent.`)
        }
      }
    }
  }
  for (const k of profile.forbiddenEnv) {
    if (hasEnv(env, k)) add(`${surface}-forbidden-env`, 'error', `${k} is set on a ${surface} agent.`)
  }

  return {
    ok: !findings.some((f) => f.severity !== 'info'),
    packageVersion: pkg.version,
    agentVersion: stamp?.version ?? null,
    surface,
    surfaceFromStamp: !!stamp,
    findings,
  }
}
