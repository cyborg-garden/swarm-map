import fs from 'fs'
import { cp, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { gateArtifactDir } from './artifact-gate'
import { fetchGitArtifact } from './git-fetch'
import type { ThreatScope } from './threat-patterns'

export type ArtifactType = 'plugins' | 'skills' | 'hooks'

export interface ArtifactEntry {
  name: string
  // Phase 1: only 'local' is supported. Future: 'upstream', 'git:<org>/<repo>#<tag>'.
  source: string
  // plugins only: write into config.yaml plugins.enabled so the runtime loads this standalone plugin
  enabled?: boolean
  // git sources only: the full commit SHA the pinned tag pointed at when it was
  // reviewed. The fetch refuses a clone whose HEAD is any other commit.
  commit?: string
}

export interface ArtifactsManifest {
  plugins: ArtifactEntry[]
  skills: ArtifactEntry[]
  hooks: ArtifactEntry[]
}

export interface GitSource {
  org: string
  repo: string
  ref: string
  subdir?: string
  // Expected commit for `ref`; see ArtifactEntry.commit.
  commit?: string
}

const GIT_COMMIT_RE = /^[0-9a-f]{40}$/i

// org / repo names and refs are charset-validated because the parsed values
// later feed a git command — a stray shell metacharacter or path traversal
// must be rejected loudly, never silently passed through.
const GIT_NAME_RE = /^[A-Za-z0-9._-]+$/ // <org> and <repo>
const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/ // <tag> (tags may contain '/')
const GIT_SUBDIR_RE = /^[A-Za-z0-9._/-]+$/

// Mutable refs that can silently drift to malicious code after review. We only
// permit immutable refs (version tags / commit SHAs). git-fetch additionally
// runs an authoritative `ls-remote --heads` branch check (this is just the
// fast-fail front door — audit FIX 4a).
const MUTABLE_REFS = new Set(['head', 'main', 'master', 'develop'])

/**
 * Parse a `git:<org>/<repo>#<tag>[:<subdir>]` artifact source.
 *
 * Security front door for git-sourced (third-party / cross-trust-boundary)
 * artifacts:
 * - returns `null` for non-git sources (`local`, `upstream`, …) so the caller
 *   routes them through the existing local path;
 * - throws (loud failure) on any `git:`-prefixed source that is **unpinned**
 *   (pinning to an immutable tag/commit is mandatory — an unpinned or mutable
 *   ref like a branch/HEAD can silently drift to malicious code), points at a
 *   mutable branch ref (HEAD/main/master/develop), is malformed, or contains
 *   unsafe characters / path traversal. The mutable-ref check here is the
 *   fast-fail front door; git-fetch additionally runs an authoritative
 *   `ls-remote --heads` branch check that catches arbitrary branch names.
 */
export function parseGitSource(source: string): GitSource | null {
  if (!source.startsWith('git:')) return null
  const rest = source.slice('git:'.length)

  const hashIdx = rest.indexOf('#')
  if (hashIdx === -1) {
    throw new Error(`git source must be pinned: "${source}" is missing "#<tag>"`)
  }
  const repoPart = rest.slice(0, hashIdx) // <org>/<repo>
  let refPart = rest.slice(hashIdx + 1) // <tag>[:<subdir>]

  let subdir: string | undefined
  const colonIdx = refPart.indexOf(':')
  if (colonIdx !== -1) {
    subdir = refPart.slice(colonIdx + 1)
    refPart = refPart.slice(0, colonIdx)
  }

  const segs = repoPart.split('/')
  if (segs.length !== 2 || !segs[0] || !segs[1]) {
    throw new Error(`malformed git source "${source}": expected git:<org>/<repo>#<tag>`)
  }
  const [org, repo] = segs
  if (!GIT_NAME_RE.test(org) || !GIT_NAME_RE.test(repo)) {
    throw new Error(`invalid org/repo in git source "${source}" (unsafe characters)`)
  }
  if (!refPart) {
    throw new Error(`git source must be pinned: "${source}" has an empty ref`)
  }
  if (!GIT_REF_RE.test(refPart)) {
    throw new Error(`invalid ref in git source "${source}" (unsafe characters)`)
  }
  // FIX 4a (audit): reject well-known mutable refs; only immutable tags/commits
  // are allowed (a branch/HEAD can drift to malicious code after review).
  if (MUTABLE_REFS.has(refPart.toLowerCase())) {
    throw new Error(
      `mutable git ref "${refPart}" in "${source}": pin to an immutable tag or commit SHA, not a branch/HEAD`,
    )
  }
  if (subdir !== undefined) {
    if (!subdir || !GIT_SUBDIR_RE.test(subdir) || subdir.split('/').includes('..')) {
      throw new Error(`invalid subdir in git source "${source}" (traversal or unsafe characters)`)
    }
  }

  const parsed: GitSource = { org, repo, ref: refPart }
  if (subdir !== undefined) parsed.subdir = subdir
  return parsed
}

export function loadManifest(manifestPath: string): ArtifactsManifest {
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8')
  } catch {
    throw new Error(`Artifacts manifest not found at ${manifestPath}`)
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid artifacts manifest at ${manifestPath}: ${(e as Error).message}`)
  }
  return {
    plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [],
  }
}

export interface InstallResult {
  type: ArtifactType
  name: string
  installed: boolean
  // true when the artifact was already present and left untouched (import-safe).
  skipped?: boolean
  error?: string
}

export interface InstallOpts {
  // Inject a fetcher (tests / custom transports). Defaults to fetchGitArtifact.
  gitFetch?: (src: GitSource) => string
  // Passed through to the default fetcher.
  gitBaseUrl?: string
  gitToken?: string
  cacheRoot?: string
  // Threat-pattern scope for the install-time gate. Defaults to 'context';
  // use-case template installs pass 'strict' (SOUL/skills the agent obeys).
  scope?: ThreatScope
  // Replace an already-present artifact instead of skipping it. Off by default
  // (create/import is no-clobber). Re-applying a use-case template to a deployed
  // agent sets this to pull the newer pinned tag. The new content is fetched and
  // trust-gated BEFORE the existing dir is removed, so a refused update never
  // destroys the working artifact.
  overwrite?: boolean
  // Refuse a git source whose manifest entry records no commit SHA.
  requireCommit?: boolean
}

// Sources supported:
//   'local'                      copy infra/templates/<type>/<name>
//   'git:<org>/<repo>#<tag>[:..]' fetch at the pinned tag, run the trust gate,
//                                 then install — or REFUSE (throw) if the gate
//                                 finds prompt-injection / promptware.
// Any other scheme throws (loud failure) rather than silently producing a
// capability-less agent.
export async function installArtifacts(
  agentDataDir: string,
  manifest: ArtifactsManifest,
  repoRoot: string,
  opts: InstallOpts = {},
): Promise<InstallResult[]> {
  const results: InstallResult[] = []
  const types: ArtifactType[] = ['plugins', 'skills', 'hooks']

  // Clones land in a cache dir. When the caller names none, this call makes
  // its own and removes it before returning: the installed copy is all it keeps.
  let ownCache: string | undefined
  const gitFetch =
    opts.gitFetch ??
    ((src: GitSource): string =>
      fetchGitArtifact(src, {
        baseUrl: opts.gitBaseUrl,
        token: opts.gitToken,
        cacheRoot: opts.cacheRoot ?? (ownCache ??= fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-artifact-cache-'))),
      }))

  try {
  for (const type of types) {
    for (const entry of manifest[type]) {
      // Defense in depth: the artifact name becomes a path segment and a
      // config.yaml plugins.enabled entry. Reject traversal / unsafe names even
      // though names come from a server-side manifest (audit: Low).
      if (!GIT_NAME_RE.test(entry.name) || entry.name.includes('..')) {
        throw new Error(`unsafe artifact name "${entry.name}" for ${type}`)
      }
      const destDir = path.join(agentDataDir, type, entry.name)

      // Never clobber an agent's existing (possibly customized) artifact — e.g.
      // when importing an already-provisioned agent. Seed baseline only when the
      // artifact is absent; the agent owns its own copy thereafter. Applied
      // before fetching so an already-present git-sourced artifact isn't re-cloned.
      // EXCEPT when overwrite is set (re-applying a template to a deployed agent):
      // fall through, fetch + gate, then replace.
      const exists = fs.existsSync(destDir)
      if (exists && !opts.overwrite) {
        results.push({ type, name: entry.name, installed: true, skipped: true })
        continue
      }

      // Throws loudly on a malformed / unpinned git source; null for non-git.
      const git = parseGitSource(entry.source)
      if (git) {
        if (entry.commit !== undefined) {
          if (typeof entry.commit !== 'string' || !GIT_COMMIT_RE.test(entry.commit)) {
            throw new Error(`invalid commit for ${type}/${entry.name}: expected a full 40-character SHA`)
          }
          git.commit = entry.commit
        } else if (opts.requireCommit) {
          throw new Error(`git-sourced ${type}/${entry.name} has no recorded commit. Not installed.`)
        }
        const fetchedDir = gitFetch(git)
        const gate = gateArtifactDir(fetchedDir, opts.scope)
        if (!gate.ok) {
          const summary = gate.findings.map((f) => `${f.file} [${f.ids.join(',')}]`).join('; ')
          throw new Error(
            `Refused git-sourced ${type}/${entry.name} (${entry.source}): content failed the injection scan (${summary}). Not installed.`,
          )
        }
        try {
          // Gate passed — only now is it safe to drop the old copy and replace.
          if (exists) await rm(destDir, { recursive: true, force: true })
          await cp(fetchedDir, destDir, {
            recursive: true,
            filter: (s) => !s.split(path.sep).includes('.git'),
          })
          results.push({ type, name: entry.name, installed: true })
        } catch (e) {
          results.push({ type, name: entry.name, installed: false, error: `copy failed: ${(e as Error).message}` })
        }
        continue
      }

      if (entry.source !== 'local') {
        throw new Error(`Unsupported artifact source "${entry.source}" for ${type}/${entry.name}`)
      }
      const srcDir = path.join(repoRoot, 'infra', 'templates', type, entry.name)
      try {
        if (exists) await rm(destDir, { recursive: true, force: true })
        await cp(srcDir, destDir, { recursive: true })
        results.push({ type, name: entry.name, installed: true })
      } catch (e) {
        results.push({ type, name: entry.name, installed: false, error: `source not found: ${(e as Error).message}` })
      }
    }
  }
  } finally {
    if (ownCache) await rm(ownCache, { recursive: true, force: true }).catch(() => {})
  }
  return results
}

/** Plugin names the manifest marks enabled (written to config.yaml plugins.enabled). */
export function enabledPluginNames(manifest: ArtifactsManifest): string[] {
  return manifest.plugins.filter((p) => p.enabled === true).map((p) => p.name)
}

/** Convenience: enabled plugin names from the repo's infra/artifacts.json. */
export function defaultEnabledPlugins(repoRoot: string = process.cwd()): string[] {
  const manifest = loadManifest(path.join(repoRoot, 'infra', 'artifacts.json'))
  return enabledPluginNames(manifest)
}
