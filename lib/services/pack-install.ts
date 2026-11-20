/**
 * Install one opt-in pack into an existing agent, including git-sourced
 * artifacts. Base-package sync (artifacts-sync) only copies `local` sources
 * and skips git ones, so a pack whose plugin lives in its own repo (e.g.
 * papareo-transcription) had no install path for an agent that already exists.
 *
 * The agent must carry a base-package stamp: the stamp is the only record of
 * its surface, and without one a private-only pack could land on a public
 * agent. Git sources must record the commit their tag pointed at, and the
 * fetch refuses any other commit.
 *
 * All or nothing: every artifact is fetched, trust-gated and copied into a
 * staging dir first. Only when all of them passed is anything moved into the
 * agent's dir, so a pack whose skill fails the gate leaves no plugin behind.
 * The pack's enabled plugins are then added to config.yaml plugins.enabled and
 * the pack is recorded in the stamp, so drift checks and forbiddenPacks see it.
 * Add-only: never removes anything. Staging and clone dirs are removed after.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { installArtifacts, type ArtifactType, type InstallOpts, type InstallResult } from './artifacts-manifest'
import { ensurePluginsEnabled } from './artifacts-sync'
import { loadBasePackage, readStamp, STAMP_FILE, validateSelection } from './base-package'

export interface PackInstallResult {
  pack: string
  installed: boolean
  results: InstallResult[]
  pluginsEnabled: string[]
  error?: string
}

const TYPES: ArtifactType[] = ['plugins', 'skills', 'hooks']

export async function installPackToDir(
  agentDir: string,
  pack: string,
  opts: { repoRoot?: string; overwrite?: boolean; gitFetch?: InstallOpts['gitFetch']; gitToken?: string; gitBaseUrl?: string } = {},
): Promise<PackInstallResult> {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const pkg = loadBasePackage(repoRoot)
  if (!pkg.packs[pack]) throw new Error(`Unknown pack "${pack}"`)
  const stamp = readStamp(agentDir)
  if (!stamp) {
    throw new Error(
      `Pack "${pack}" is not allowed on this agent yet: it has no base-package stamp, so its surface is unknown. ` +
        'Run the base-package sync for this agent first (POST /api/harnesses/:id/artifacts/sync), then install the pack.',
    )
  }
  // Throws on a pack this agent's surface forbids.
  validateSelection(pkg, { surface: stamp.surface, packs: [pack] })

  const inPack = (e: { pack?: string }) => e.pack === pack
  const all = {
    plugins: pkg.manifest.plugins.filter(inPack),
    skills: pkg.manifest.skills.filter(inPack),
    hooks: pkg.manifest.hooks.filter(inPack),
  }
  // Present artifacts are left alone unless overwrite is set, as installArtifacts does.
  const present = (type: ArtifactType, name: string) => fs.existsSync(path.join(agentDir, type, name))
  const results: InstallResult[] = []
  const todo = { plugins: [] as typeof all.plugins, skills: [] as typeof all.skills, hooks: [] as typeof all.hooks }
  for (const type of TYPES) {
    for (const e of all[type]) {
      if (present(type, e.name) && opts.overwrite !== true) results.push({ type, name: e.name, installed: true, skipped: true })
      else todo[type].push(e)
    }
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-pack-install-'))
  const staging = path.join(work, 'staging')
  fs.mkdirSync(staging)
  try {
    // Fetch + gate + copy into staging. A gate refusal throws from here, before
    // the agent's dir has been touched.
    const staged = await installArtifacts(staging, todo, repoRoot, {
      gitFetch: opts.gitFetch,
      gitToken: opts.gitToken,
      gitBaseUrl: opts.gitBaseUrl,
      cacheRoot: path.join(work, 'clones'),
      requireCommit: true,
    })
    const failed = staged.filter((r) => !r.installed)
    if (failed.length) {
      return {
        pack,
        installed: false,
        results: [...results, ...staged],
        pluginsEnabled: [],
        error: failed.map((r) => `${r.type}/${r.name}: ${r.error}`).join('; '),
      }
    }

    // Everything passed. Move it in; if a copy fails part-way, take back what
    // this run added (an overwritten artifact keeps its new, already-gated copy).
    const added: string[] = []
    try {
      for (const r of staged) {
        const dest = path.join(agentDir, r.type, r.name)
        const existed = fs.existsSync(dest)
        if (existed) fs.rmSync(dest, { recursive: true, force: true })
        else added.push(dest)
        fs.cpSync(path.join(staging, r.type, r.name), dest, { recursive: true })
      }
    } catch (e) {
      for (const d of added) fs.rmSync(d, { recursive: true, force: true })
      return {
        pack,
        installed: false,
        results: [...results, ...staged.map((r) => ({ ...r, installed: false }))],
        pluginsEnabled: [],
        error: `copy into the agent failed: ${(e as Error).message}`,
      }
    }
    results.push(...staged)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }

  const configPath = path.join(agentDir, 'config.yaml')
  const names = all.plugins.filter((p) => p.enabled === true).map((p) => p.name)
  let pluginsEnabled: string[] = []
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf-8')
    const r = ensurePluginsEnabled(config, names)
    if (r.content !== config) fs.writeFileSync(configPath, r.content, 'utf-8')
    pluginsEnabled = r.added
  }
  if (!stamp.packs.includes(pack)) {
    fs.writeFileSync(
      path.join(agentDir, STAMP_FILE),
      JSON.stringify({ ...stamp, packs: [...stamp.packs, pack] }, null, 2) + '\n',
    )
  }
  return { pack, installed: true, results, pluginsEnabled }
}
