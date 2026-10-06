import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  ArtifactsManifest,
  ArtifactType,
  ArtifactEntry,
  enabledPluginNames,
} from './artifacts-manifest'
import { ensureBlockList } from '../yaml-block-list'

// Issue #82: installBaselineTemplates runs only at agent create/duplicate, so
// existing agents never receive new artifacts added to infra/artifacts.json.
// This module syncs an already-created agent's data dir against the manifest
// WITHOUT clobbering anything the user added or modified.
//
// Safety model (two layers):
//   1. Additive floor — always safe, needs no history: install artifacts that
//      are MISSING from the data dir. Never touch an artifact that exists.
//      This alone solves the driving case (#81: agents missing a plugin gain it).
//   2. Pristine-update — only when we have proof an artifact is unmodified: an
//      `.artifacts-lock.json` written at install time records the shipped
//      content hash. At sync, an existing artifact is updated to the new shipped
//      version ONLY if its on-disk hash still matches the lock (pristine). If it
//      differs (user-modified) or isn't in the lock (untracked / user-added), it
//      is SKIPPED. `force` overrides this to overwrite anyway.

export const LOCK_FILE = '.artifacts-lock.json'

export type SyncAction = 'install' | 'update' | 'skip'

export interface SyncPlanItem {
  type: ArtifactType
  name: string
  action: SyncAction
  // install: 'missing'; update: 'pristine' | 'forced'; skip: 'up-to-date' | 'user-modified' | 'untracked' | 'source-missing'
  reason: string
}

export interface SyncPlan {
  items: SyncPlanItem[]
  /** enabled:true plugins that will be install/update'd — candidates for config.yaml plugins.enabled */
  enablePlugins: string[]
}

interface LockEntry {
  type: ArtifactType
  name: string
  hash: string
}
interface LockFile {
  version: number
  artifacts: LockEntry[]
}

const TYPES: ArtifactType[] = ['plugins', 'skills', 'hooks']

function srcDirFor(repoRoot: string, type: ArtifactType, name: string): string {
  return path.join(repoRoot, 'infra', 'templates', type, name)
}
function destDirFor(agentDataDir: string, type: ArtifactType, name: string): string {
  return path.join(agentDataDir, type, name)
}

/**
 * Deterministic content hash of an artifact directory tree: sorted relative
 * paths + file bytes. Returns null if the dir is missing. Symlinks are hashed
 * by their target string (not followed) so they can't smuggle content in.
 */
export function hashArtifactTree(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  const h = crypto.createHash('sha256')
  const walk = (rel: string) => {
    const abs = path.join(dir, rel)
    const st = fs.lstatSync(abs)
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        walk(path.join(rel, name))
      }
    } else if (st.isSymbolicLink()) {
      h.update(`L:${rel}:${fs.readlinkSync(abs)}\n`)
    } else {
      h.update(`F:${rel}:`)
      h.update(fs.readFileSync(abs))
      h.update('\n')
    }
  }
  walk('')
  return h.digest('hex')
}

export function readLock(agentDataDir: string): LockFile | null {
  const p = path.join(agentDataDir, LOCK_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && Array.isArray(parsed.artifacts)) return parsed as LockFile
  } catch {
    /* missing or malformed → treated as no lock (additive-only) */
  }
  return null
}

function lockHashFor(lock: LockFile | null, type: ArtifactType, name: string): string | null {
  if (!lock) return null
  const e = lock.artifacts.find((a) => a.type === type && a.name === name)
  return e ? e.hash : null
}

/**
 * Decide what sync would do — pure, no writes. Inspects the data dir + lock and
 * the shipped templates. Use dryRun at the call site to surface this to a human.
 */
export function planArtifactSync(
  agentDataDir: string,
  manifest: ArtifactsManifest,
  repoRoot: string,
  opts: { force?: boolean } = {},
): SyncPlan {
  const lock = readLock(agentDataDir)
  const items: SyncPlanItem[] = []
  const enablePlugins: string[] = []
  const enabledNames = new Set(enabledPluginNames(manifest))

  for (const type of TYPES) {
    for (const entry of manifest[type] as ArtifactEntry[]) {
      const dest = destDirFor(agentDataDir, type, entry.name)
      const src = srcDirFor(repoRoot, type, entry.name)
      let item: SyncPlanItem

      if (entry.source !== 'local') {
        item = { type, name: entry.name, action: 'skip', reason: `unsupported-source:${entry.source}` }
      } else if (!fs.existsSync(src)) {
        item = { type, name: entry.name, action: 'skip', reason: 'source-missing' }
      } else if (!fs.existsSync(dest)) {
        item = { type, name: entry.name, action: 'install', reason: 'missing' }
      } else if (opts.force) {
        item = { type, name: entry.name, action: 'update', reason: 'forced' }
      } else {
        const locked = lockHashFor(lock, type, entry.name)
        if (locked === null) {
          item = { type, name: entry.name, action: 'skip', reason: 'untracked' }
        } else if (hashArtifactTree(dest) === locked) {
          // Pristine, but only an update if the shipped copy actually moved —
          // otherwise a re-run would rewrite identical bytes, report a change
          // and bounce the container every time (base package: apply must be
          // idempotent).
          item = hashArtifactTree(src) === locked
            ? { type, name: entry.name, action: 'skip', reason: 'up-to-date' }
            : { type, name: entry.name, action: 'update', reason: 'pristine' }
        } else {
          item = { type, name: entry.name, action: 'skip', reason: 'user-modified' }
        }
      }

      items.push(item)
      if ((item.action === 'install' || item.action === 'update') && type === 'plugins' && enabledNames.has(entry.name)) {
        enablePlugins.push(entry.name)
      }
    }
  }
  return { items, enablePlugins }
}

export interface SyncResult extends SyncPlanItem {
  applied: boolean
  error?: string
}

function rmrf(p: string) {
  fs.rmSync(p, { recursive: true, force: true })
}
function copyTree(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

/**
 * Apply a plan: copy install/update artifacts from the shipped templates and
 * rewrite the lock so every manifest artifact now present on disk records its
 * current shipped hash (future syncs can then pristine-update it). Skips are
 * left entirely untouched. Returns per-artifact outcomes.
 */
export function applyArtifactSync(
  agentDataDir: string,
  plan: SyncPlan,
  repoRoot: string,
): SyncResult[] {
  const results: SyncResult[] = []
  for (const item of plan.items) {
    if (item.action === 'skip') {
      results.push({ ...item, applied: false })
      continue
    }
    const src = srcDirFor(repoRoot, item.type, item.name)
    const dest = destDirFor(agentDataDir, item.type, item.name)
    try {
      if (item.action === 'update') rmrf(dest) // pristine/forced → safe to replace wholesale
      copyTree(src, dest)
      results.push({ ...item, applied: true })
    } catch (e) {
      results.push({ ...item, applied: false, error: (e as Error).message })
    }
  }
  writeLockForApplied(agentDataDir, results)
  return results
}

/**
 * Record/refresh the lock ONLY for artifacts whose copy actually succeeded,
 * preserving prior lock entries for artifacts we didn't touch. The recorded
 * hash is read from the ON-DISK dest after copy (not the shipped src) so a
 * partial/failed write can never be locked as a clean shipped hash — which
 * would otherwise strand the artifact as permanently "user-modified".
 */
/**
 * Record freshly-installed artifacts in the lock (create path: installArtifacts
 * copies but keeps no history). Without this a create-time artifact is
 * "untracked" forever and never receives a pristine update.
 */
export function lockInstalled(agentDataDir: string, items: { type: ArtifactType; name: string }[]) {
  writeLockForApplied(
    agentDataDir,
    items.map((i) => ({ ...i, action: 'install' as const, reason: 'missing', applied: true })),
  )
}

function writeLockForApplied(agentDataDir: string, results: SyncResult[]) {
  const existing = readLock(agentDataDir)
  const byKey = new Map<string, LockEntry>()
  if (existing) for (const e of existing.artifacts) byKey.set(`${e.type}/${e.name}`, e)
  for (const r of results) {
    if (!r.applied) continue
    const onDisk = hashArtifactTree(destDirFor(agentDataDir, r.type, r.name))
    if (onDisk) byKey.set(`${r.type}/${r.name}`, { type: r.type, name: r.name, hash: onDisk })
  }
  const lock: LockFile = { version: 1, artifacts: Array.from(byKey.values()) }
  fs.writeFileSync(path.join(agentDataDir, LOCK_FILE), JSON.stringify(lock, null, 2))
}

/**
 * Ensure config.yaml's `plugins.enabled` list contains `names`, preserving the
 * rest of the file. Text-based (HSM writes config.yaml as a string, no YAML
 * dep). Returns the new content + which names were added (idempotent).
 *
 * Always leaves a BLOCK list behind: an inline `enabled: []` / `[a, b]` is
 * rewritten in place with the same entries (base package v1 — inline `[]` is
 * why cyborg-public loaded none of its plugins and why sync used to give up).
 * A `plugins:` block without an `enabled:` child gains one. Shapes that can't
 * be edited safely (nested flow lists, `plugins: {..}`) are left untouched and
 * reported as added: []. See lib/yaml-block-list.ts.
 */
export function ensurePluginsEnabled(
  configYaml: string,
  names: string[],
): { content: string; added: string[]; converted: boolean } {
  if (names.length === 0) return { content: configYaml, added: [], converted: false }
  const r = ensureBlockList(configYaml, 'plugins', 'enabled', names, {
    comment: '--- Plugins (added by Swarm Map artifacts sync) ---',
  })
  return { content: r.content, added: r.added, converted: r.converted }
}
