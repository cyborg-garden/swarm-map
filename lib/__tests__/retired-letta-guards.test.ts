// @vitest-environment node
/**
 * Removal guards for the old Letta integration (plan: docs/plans/
 * 2026-11-13-letta-code-migration.md, section 3a).
 *
 * Two things were deleted: the Hermes-to-Letta bridge, and the client for the
 * retired self-hosted Letta server. These checks keep them deleted. They read
 * the repo's own files and need no harness, no Docker and no network.
 *
 * Every check scans the files git knows about (tracked, plus untracked files
 * that are not ignored), so a file that is only on disk because of a local
 * .gitignore entry can neither fail nor satisfy a guard.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const SELF = 'lib/__tests__/retired-letta-guards.test.ts'

// The migration's own plan and spec describe what was removed, by name.
const MIGRATION_DOCS = [
  'docs/plans/2026-11-13-letta-code-migration.md',
  'docs/specs/2026-11-13-harness-agnostic-primitives.md',
]

/** Where the Letta Code shim will live. Nothing is there yet. */
const LETTA_CODE_DIR = 'lib/runtimes/letta-code/'

function repoFiles(): string[] {
  // Throws if this is not a git checkout. That is deliberate: a guard that
  // cannot list the files must fail, not pass on an empty list.
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f))) // staged deletions
}

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|sqlite|db)$/i

function hits(pattern: RegExp, allow: (file: string) => boolean): string[] {
  const found: string[] = []
  for (const file of repoFiles()) {
    if (BINARY.test(file) || allow(file)) continue
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
    text.split('\n').forEach((line, i) => {
      if (pattern.test(line)) found.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return found
}

describe('the guard can see the repo (a guard that scans nothing passes everything)', () => {
  it('lists a healthy number of files, including this one and package.json', () => {
    const files = repoFiles()
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(SELF)
    expect(files).toContain('package.json')
  })

  it('the scanner really finds a needle that is known to exist', () => {
    // If hits() were broken, every "finds nothing" check below would be green.
    expect(hits(/"name": "swarm-map"/, () => false).some((h) => h.startsWith('package.json:'))).toBe(true)
  })
})

describe('R1/R3: the Hermes-to-Letta bridge stays deleted', () => {
  it('no file names the bridge env vars or its deploy argument', () => {
    const allow = (f: string) =>
      f === SELF ||
      MIGRATION_DOCS.includes(f) ||
      f.startsWith(LETTA_CODE_DIR) ||
      // The R3 test: it passes the old argument on purpose, to prove a stale
      // caller still gets no bridge vars.
      f === 'lib/services/__tests__/agent-deploy-templates.test.ts'
    expect(hits(/letta_brain|lettaBrain/i, allow)).toEqual([])
  })

  it('the create wizard offers no Letta runtime', () => {
    const wizard = fs.readFileSync(path.join(ROOT, 'app/(setup)/setup/wizard/page.tsx'), 'utf-8')
    expect(wizard).not.toMatch(/letta/i)
  })
})
