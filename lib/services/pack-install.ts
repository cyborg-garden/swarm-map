/**
 * Install one opt-in pack into an existing agent, including git-sourced
 * artifacts. Base-package sync (artifacts-sync) only copies `local` sources
 * and skips git ones, so a pack whose plugin lives in its own repo (e.g.
 * papareo-transcription) had no install path for an agent that already exists.
 *
 * Git sources are fetched at their pinned tag and trust-gated by
 * installArtifacts before anything is written. The pack's enabled plugins are
 * added to config.yaml plugins.enabled, and the pack is recorded in the
 * agent's base-package stamp so drift checks and forbiddenPacks see it.
 * Add-only: never removes anything.
 */
import fs from 'fs'
import path from 'path'
import { installArtifacts, type InstallOpts, type InstallResult } from './artifacts-manifest'
import { ensurePluginsEnabled } from './artifacts-sync'
import { loadBasePackage, readStamp, STAMP_FILE, validateSelection, DEFAULT_SURFACE } from './base-package'

export interface PackInstallResult {
  pack: string
  installed: boolean
  results: InstallResult[]
  pluginsEnabled: string[]
  error?: string
}

export async function installPackToDir(
  agentDir: string,
  pack: string,
  opts: { repoRoot?: string; overwrite?: boolean; gitFetch?: InstallOpts['gitFetch']; gitToken?: string } = {},
): Promise<PackInstallResult> {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const pkg = loadBasePackage(repoRoot)
  const stamp = readStamp(agentDir)
  // Throws on an unknown pack or one this agent's surface forbids.
  validateSelection(pkg, { surface: stamp?.surface ?? DEFAULT_SURFACE, packs: [pack] })

  const entries = {
    plugins: pkg.manifest.plugins.filter((e) => (e as { pack?: string }).pack === pack),
    skills: pkg.manifest.skills.filter((e) => (e as { pack?: string }).pack === pack),
    hooks: pkg.manifest.hooks.filter((e) => (e as { pack?: string }).pack === pack),
  }
  const results = await installArtifacts(agentDir, entries, repoRoot, {
    overwrite: opts.overwrite === true,
    gitFetch: opts.gitFetch,
    gitToken: opts.gitToken,
  })
  const failed = results.filter((r) => !r.installed)
  if (failed.length) {
    return {
      pack,
      installed: false,
      results,
      pluginsEnabled: [],
      error: failed.map((r) => `${r.type}/${r.name}: ${r.error}`).join('; '),
    }
  }

  const configPath = path.join(agentDir, 'config.yaml')
  const names = entries.plugins.filter((p) => p.enabled === true).map((p) => p.name)
  let pluginsEnabled: string[] = []
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf-8')
    const r = ensurePluginsEnabled(config, names)
    if (r.content !== config) fs.writeFileSync(configPath, r.content, 'utf-8')
    pluginsEnabled = r.added
  }
  if (stamp && !stamp.packs.includes(pack)) {
    fs.writeFileSync(
      path.join(agentDir, STAMP_FILE),
      JSON.stringify({ ...stamp, packs: [...stamp.packs, pack] }, null, 2) + '\n',
    )
  }
  return { pack, installed: true, results, pluginsEnabled }
}
