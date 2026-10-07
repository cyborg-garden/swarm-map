import { installArtifacts, type InstallResult } from './artifacts-manifest'
import { lockInstalled } from './artifacts-sync'
import {
  loadBasePackage,
  selectArtifacts,
  validateSelection,
  applyBasePackageToDir,
  DEFAULT_SURFACE,
  type ApplyReport,
  type Selection,
} from './base-package'

/**
 * Inject the base package into a NEW agent's data directory. This is the one
 * choke point every creation path calls (scaffold/duplicate, the full deploy
 * route, import), so they stay in parity.
 *
 * 1. installs the selected artifacts (core + chosen packs) from
 *    infra/artifacts.json — `local` entries are copied from infra/templates;
 *    `git:<org>/<repo>#<tag>` entries are fetched at the pinned tag and
 *    screened by the install-time trust gate (see installArtifacts);
 * 2. records them in the artifacts lock so later syncs can pristine-update;
 * 3. applies the rest of the package (plugins.enabled block list, surface
 *    profile, SOUL orientation block, .hsm-base-package stamp) via the same
 *    add-only applyBasePackageToDir the sync route uses.
 * Throws on an invalid selection, unsupported sources, or when the trust gate
 * refuses a fetched artifact.
 *
 * The git build-time token is read from the HSM *server* env
 * (`ARTIFACT_GIT_TOKEN`, falling back to `GITHUB_TOKEN`). This is deliberately
 * distinct from the per-agent runtime `GITHUB_TOKEN` written into an agent's
 * `.env`: the server fetches+screens artifacts at create time; the agent never
 * sees this credential.
 */
export async function provisionBasePackage(
  agentDataDir: string,
  sel: Selection = { surface: DEFAULT_SURFACE, packs: [] },
): Promise<{ install: InstallResult[]; report: ApplyReport }> {
  const repoRoot = process.cwd()
  const pkg = loadBasePackage(repoRoot)
  validateSelection(pkg, sel)
  const gitToken = process.env.ARTIFACT_GIT_TOKEN || process.env.GITHUB_TOKEN || undefined
  const selected = selectArtifacts(pkg, sel)
  const install = await installArtifacts(agentDataDir, selected, repoRoot, { gitToken })
  const localNames = new Set(
    (['plugins', 'skills', 'hooks'] as const).flatMap((t) =>
      selected[t].filter((e) => e.source === 'local').map((e) => `${t}/${e.name}`),
    ),
  )
  lockInstalled(
    agentDataDir,
    install.filter((r) => r.installed && !r.skipped && localNames.has(`${r.type}/${r.name}`)),
  )
  const report = applyBasePackageToDir(agentDataDir, pkg, sel, repoRoot)
  return { install, report }
}

/** Back-compat wrapper: provisionBasePackage, returning only the install results. */
export async function installBaselineTemplates(
  agentDataDir: string,
  sel?: Selection,
): Promise<InstallResult[]> {
  return (await provisionBasePackage(agentDataDir, sel)).install
}

/**
 * @deprecated Read the manifest (infra/artifacts.json) instead. Retained only for
 * callers that still reference the plugin name list; will be removed in Phase 2.
 */
export const TEMPLATE_PLUGINS = ['swarm_map_policy', 'boot_md', 'credential_redactor']
