/**
 * Use-case templates: opinionated, public "packages" a user can opt into when
 * creating an agent (e.g. Matilde, the science assistant). A template declares
 * recommended model/platform config plus a set of git-sourced artifacts
 * (plugins/skills/hooks) and an optional SOUL overlay.
 *
 * Everything fetched from a template repo goes through the SAME security path as
 * baseline artifacts: pinned git source -> fetch -> trust gate (injection scan)
 * -> copy. Nothing is executed (no setup scripts) — copy + gate only.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cp } from 'fs/promises'
import {
  installArtifacts,
  parseGitSource,
  type ArtifactsManifest,
  type ArtifactType,
  type InstallResult,
  type GitSource,
} from './artifacts-manifest'
import { fetchGitArtifact } from './git-fetch'
import { gateArtifactDir } from './artifact-gate'
import { ensurePluginsEnabled } from './artifacts-sync'

export interface UseCaseArtifact {
  type: ArtifactType
  name: string
  /** git:<org>/<repo>#<tag>[:<subdir>] — pinned + trust-gated like any artifact. */
  source: string
  /** plugins only: enable in config.yaml plugins.enabled. */
  enabled?: boolean
}

export interface UseCaseRecommends {
  provider?: string
  primaryModel?: string
  fallbackModel?: string
  platforms?: string[]
  browser?: boolean
}

export interface UseCaseSoul {
  /** git source whose (sub)dir contains the SOUL file. */
  source: string
  /** file within the fetched dir to seed as the agent's SOUL.md. */
  file: string
}

export interface UseCaseTemplate {
  id: string
  name: string
  description: string
  recommends?: UseCaseRecommends
  artifacts: UseCaseArtifact[]
  soul?: UseCaseSoul
}

export interface InstallTemplateOpts {
  gitToken?: string
  cacheRoot?: string
  /** Inject a fetcher for tests; defaults to the real trust-gated git fetch. */
  gitFetch?: (src: GitSource) => string
  /** Replace already-present artifacts (re-apply / update). Default false. */
  overwrite?: boolean
  /** Seed the template SOUL over the agent's SOUL.md. Default true (create-time);
   *  re-apply passes false to preserve a deployed agent's identity. */
  seedSoul?: boolean
  /** The agent's name as entered at create time (e.g. "vera"). Fills the
   *  template SOUL's {{AGENT_NAME}} placeholder (as a display name, "Vera"). */
  agentName?: string
}

/**
 * Display name for an agent from its harness name: "vera" -> "Vera",
 * "ops-bot" -> "Ops Bot". Words that already carry capitals are kept as typed.
 */
export function agentDisplayName(name: string): string {
  return name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/**
 * Fill the {{PLACEHOLDER}}s a template SOUL declares. Only known keys are
 * replaced; unknown ones are left verbatim (a template may use a token the
 * operator fills in by hand) and reported so the deploy can warn.
 */
export function fillSoulPlaceholders(
  content: string,
  values: Record<string, string>,
): { content: string; unknown: string[] } {
  const unknown = new Set<string>()
  const out = content.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key]
    unknown.add(key)
    return match
  })
  return { content: out, unknown: [...unknown] }
}

export function loadUseCaseTemplates(repoRoot: string = process.cwd()): UseCaseTemplate[] {
  const p = path.join(repoRoot, 'infra', 'usecase-templates.json')
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch {
    return [] // registry is optional — no templates is a valid state
  }
  let parsed: { templates?: UseCaseTemplate[] }
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid usecase-templates.json: ${(e as Error).message}`)
  }
  return Array.isArray(parsed.templates) ? parsed.templates : []
}

export function getUseCaseTemplate(id: string, repoRoot: string = process.cwd()): UseCaseTemplate | undefined {
  return loadUseCaseTemplates(repoRoot).find((t) => t.id === id)
}

/** Plugin names a template marks enabled — merged into config.yaml plugins.enabled. */
export function templateEnabledPlugins(template: UseCaseTemplate): string[] {
  return template.artifacts.filter((a) => a.type === 'plugins' && a.enabled === true).map((a) => a.name)
}

/**
 * Install a use-case template's artifacts into an agent's data dir, then seed its
 * SOUL (if any). Artifacts are installed via the shared, trust-gated
 * installArtifacts. The SOUL file is gated the same way (scanned in isolation)
 * before it overwrites the agent's SOUL.md.
 */
export async function installUseCaseTemplate(
  agentDataDir: string,
  template: UseCaseTemplate,
  opts: InstallTemplateOpts = {},
): Promise<InstallResult[]> {
  const gitToken = opts.gitToken ?? process.env.ARTIFACT_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined
  const cacheRoot = opts.cacheRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-usecase-cache-'))
  const gitFetch =
    opts.gitFetch ?? ((src: GitSource): string => fetchGitArtifact(src, { token: gitToken, cacheRoot }))

  const manifest: ArtifactsManifest = { plugins: [], skills: [], hooks: [] }
  for (const a of template.artifacts) {
    manifest[a.type].push({ name: a.name, source: a.source, enabled: a.enabled })
  }
  // 'strict' scope: template skills/plugins are content the agent obeys, so
  // screen the exfil/persistence/config-mod/secret pattern set too (audit: High).
  const results = await installArtifacts(agentDataDir, manifest, process.cwd(), { gitToken, cacheRoot, gitFetch, scope: 'strict', overwrite: opts.overwrite })

  if (template.soul && opts.seedSoul !== false) {
    await seedSoulFromGit(agentDataDir, template.soul, gitFetch, cacheRoot, opts.agentName)
  }
  return results
}

/**
 * Re-apply a use-case template to an ALREADY-DEPLOYED agent: re-run the same
 * trust-gated install into the agent's data dir (updating plugins/skills/SOUL to
 * the template's currently-pinned tag), then ensure the template's enabled
 * plugins are listed in the agent's config.yaml so the runtime loads them.
 *
 * Security is inherited from installUseCaseTemplate (injection scan at 'strict'
 * scope) — a poisoned artifact is refused before anything is written.
 *
 * Returns what was installed, which plugins were newly enabled, and whether
 * anything changed (so the caller can decide whether to restart the container).
 */
export async function reapplyUseCaseTemplate(
  agentDataDir: string,
  template: UseCaseTemplate,
  configPath: string,
  opts: InstallTemplateOpts = {},
): Promise<{ results: InstallResult[]; pluginsEnabled: string[]; changed: boolean }> {
  // Re-apply = update artifacts to the template's current tag (overwrite), but
  // do NOT re-seed SOUL — a deployed agent's identity may be operator-customized.
  const results = await installUseCaseTemplate(agentDataDir, template, { ...opts, overwrite: true, seedSoul: false })
  // "changed" = something was actually (re)written, not merely already present.
  const changed = results.some((r) => r.installed && !r.skipped)

  // Enable any template plugins that were actually installed, so config.yaml
  // tells the runtime to load them (mirrors syncArtifacts' enable step).
  let pluginsEnabled: string[] = []
  const toEnable = templateEnabledPlugins(template).filter((n) =>
    results.some((r) => r.name === n && r.installed),
  )
  if (toEnable.length > 0) {
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''
    const { content, added } = ensurePluginsEnabled(current, toEnable)
    if (added.length > 0) {
      fs.writeFileSync(configPath, content)
      pluginsEnabled = added
    }
  }

  return { results, pluginsEnabled, changed }
}

/**
 * Fetch a single SOUL file from a git source, run it through the trust gate in
 * isolation (so sibling files like setup scripts don't taint the scan and a
 * poisoned SOUL is refused), then write it as the agent's SOUL.md.
 */
async function seedSoulFromGit(
  agentDataDir: string,
  soul: UseCaseSoul,
  gitFetch: (src: GitSource) => string,
  cacheRoot: string,
  agentName?: string,
): Promise<void> {
  const src = parseGitSource(soul.source)
  if (!src) throw new Error(`Use-case template SOUL source must be a pinned git source: "${soul.source}"`)
  // Guard against path traversal in the declared file name.
  if (soul.file.includes('..') || path.isAbsolute(soul.file)) {
    throw new Error(`Invalid SOUL file path "${soul.file}"`)
  }
  const fetchedDir = gitFetch(src)
  const soulSrc = path.join(fetchedDir, soul.file)
  if (!fs.existsSync(soulSrc)) {
    throw new Error(`SOUL file "${soul.file}" not found in ${soul.source}`)
  }

  // Gate the SOUL file in isolation: copy just it into a scratch dir and scan.
  const scratch = fs.mkdtempSync(path.join(cacheRoot, 'soul-gate-'))
  const values: Record<string, string> = {}
  if (agentName && agentName.trim()) values.AGENT_NAME = agentDisplayName(agentName)
  const filled = fillSoulPlaceholders(fs.readFileSync(soulSrc, 'utf-8'), values)
  if (filled.unknown.length > 0) {
    console.warn(
      `[usecase-templates] SOUL from ${soul.source} has unfilled placeholders: ${filled.unknown.map((k) => `{{${k}}}`).join(', ')}`,
    )
  }
  // Gate the FILLED content — the name is operator input and ends up in the prompt.
  fs.writeFileSync(path.join(scratch, 'SOUL.md'), filled.content, 'utf-8')
  // SOUL becomes the agent's identity prompt — gate it at the strictest scope.
  const gate = gateArtifactDir(scratch, 'strict')
  if (!gate.ok) {
    const summary = gate.findings.map((f) => `${f.file} [${f.ids.join(',')}]`).join('; ')
    throw new Error(`Refused SOUL from ${soul.source}: failed the injection scan (${summary}).`)
  }
  await cp(path.join(scratch, 'SOUL.md'), path.join(agentDataDir, 'SOUL.md'))
}
