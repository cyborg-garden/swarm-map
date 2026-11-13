// @vitest-environment node
/**
 * Removal guards for the old Letta integration.
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

// The migration's plan and spec describe what was removed, by name. They are
// published with the follow-up work, not with this removal, so these two
// paths do not exist yet. They are listed so that change needs no edit here.
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
    .filter((f) => {
      // Regular files only. This drops staged deletions, and it drops a
      // nested git worktree, which `--others` lists as one entry ending in
      // "/" (`.wt-topic/`). That is another branch's checkout, not this
      // tree, and vitest.config.ts leaves it out of the run for the same
      // reason.
      const stat = fs.lstatSync(path.join(ROOT, f), { throwIfNoEntry: false })
      return stat?.isFile() === true
    })
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

  it('a nested git worktree in the checkout is skipped, not read as a file', () => {
    // `git ls-files --others` reports a nested checkout as ONE entry ending in
    // "/" (`.wt-topic/`). The main checkout holds many of these. Reading one
    // as a file throws EISDIR and turns every guard red for the wrong reason.
    const probe = path.join(ROOT, `.wt-guard-probe-${process.pid}`)
    fs.mkdirSync(probe)
    try {
      execFileSync('git', ['init', '-q'], { cwd: probe })
      fs.writeFileSync(path.join(probe, 'inside.txt'), '"name": "swarm-map"\n')
      const raw = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
        cwd: ROOT,
        encoding: 'utf-8',
      }).split('\0')
      // The probe is set up the way the bug needs it: git lists it as a directory.
      expect(raw).toContain(`${path.basename(probe)}/`)

      const files = repoFiles()
      for (const f of files) expect(fs.lstatSync(path.join(ROOT, f)).isFile()).toBe(true)
      expect(files.some((f) => f.startsWith(path.basename(probe)))).toBe(false)
      expect(() => hits(/"name": "swarm-map"/, () => false)).not.toThrow()
      // Still sees the real needle, and nothing from inside the nested checkout.
      const found = hits(/"name": "swarm-map"/, () => false)
      expect(found.some((h) => h.startsWith('package.json:'))).toBe(true)
      expect(found.some((h) => h.startsWith(path.basename(probe)))).toBe(false)
    } finally {
      fs.rmSync(probe, { recursive: true, force: true })
    }
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

// Translations of README.md and their frozen test snapshot. They are written
// by the readme-zh-sync workflow after README.md changes on main, never by
// hand, so they trail the English by one sync.
const TRANSLATED = (f: string) =>
  f === 'README.zh-CN.md' || f === 'README.zh-TW.md' || f.startsWith('scripts/__tests__/fixtures/readme-pair/')

// Each entry is a reason, not a convenience. Adding one is a decision.
const MAY_SAY_LETTA: Record<string, string> = {
  'lib/services/runtime-adapter.ts': 'the retired-runtime table (R4)',
  'lib/services/__tests__/retired-runtime.test.ts': 'R4 tests',
  'lib/services/__tests__/runtime-adapter.test.ts': 'R4: no Hermes fallback',
  'lib/services/__tests__/agent-deploy-templates.test.ts': 'R3 test',
  'lib/services/__tests__/deploy-route.integration.test.ts': 'R5 tests',
  'app/api/setup/deploy/route.ts': 'the R5 refusal message',
  'app/api/harnesses/retired/route.test.ts': 'retired-row fixture',
  'app/api/harnesses/__tests__/retired-row-routes.test.ts': 'R4: every per-agent write route refuses a retired row, by its real ids',
  'lib/services/__tests__/surface-admins.test.ts': 'R4: the surface-admins write path refuses a retired row, by its real ids',
  'scripts/sync-readme-zh.mjs': 'translator glossary: product names stay in English',
  'docs/runtimes.md': 'says what was removed and what comes next',
  'README.md': 'points at docs/runtimes.md for the retired runtime',
}

/**
 * Where the harness-agnostic contract lives (spec section 4: `lib/core/` for
 * types and pure functions, `lib/door/` for the sidecar). That contract names
 * every harness by id, `'letta-code'` included (spec 4.5,
 * `Capabilities.harness`), so the bare word is expected there. The specific
 * strings of the old integration (server image, port, REST path, bridge
 * vars) are still banned in these directories by the checks around this one.
 */
const SHARED_CONTRACT_DIRS = ['lib/core/', 'lib/door/']

const removedPathAllowed = (f: string) =>
  f === SELF || MIGRATION_DOCS.includes(f) || f.startsWith(LETTA_CODE_DIR) || TRANSLATED(f)

/** May this file contain the bare word "letta"? */
const mayNameLetta = (f: string) =>
  removedPathAllowed(f) ||
  Object.hasOwn(MAY_SAY_LETTA, f) ||
  SHARED_CONTRACT_DIRS.some((dir) => f.startsWith(dir))

describe('R1: the old Letta server client stays deleted', () => {
  const allow = removedPathAllowed

  it('the shared contract may name the new harness id; the old paths stay banned there', () => {
    // The Pi branch's lib/door/protocol.ts lists 'letta-code' as a harness id.
    expect(mayNameLetta('lib/door/protocol.ts')).toBe(true)
    expect(mayNameLetta('lib/core/policy/types.ts')).toBe(true)
    // Not a blanket pass: the word is still refused everywhere else...
    expect(mayNameLetta('lib/services/harness.ts')).toBe(false)
    expect(mayNameLetta('lib/corex/a.ts')).toBe(false)
    expect(mayNameLetta('app/api/harnesses/route.ts')).toBe(false)
    // ...and the removed integration's own strings are refused in the shared
    // dirs too, because those checks do not consult the word list.
    expect(allow('lib/door/protocol.ts')).toBe(false)
    expect(allow('lib/core/policy/types.ts')).toBe(false)
  })

  it('nothing pins the retired server image', () => {
    expect(hits(/letta\/letta:/i, allow)).toEqual([])
  })

  it('nothing names the retired server port', () => {
    expect(hits(/(?<![0-9a-f]):8283\b/i, (f) => allow(f) || /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$/.test(f))).toEqual([])
  })

  it('nothing calls the retired REST agents API', () => {
    expect(hits(/\/v1\/agents/i, allow)).toEqual([])
  })

  it('the word "letta" appears only where this list says it may', () => {
    expect(hits(/letta/i, mayNameLetta)).toEqual([])
    // An allow entry for a file that no longer exists is a stale hole.
    const files = new Set(repoFiles())
    expect(Object.keys(MAY_SAY_LETTA).filter((f) => !files.has(f))).toEqual([])
  })

  it('the files of the old integration are gone', () => {
    const gone = [
      'lib/services/letta.ts',
      'lib/services/letta-agent-provider.ts',
      'lib/services/letta-deploy-templates.ts',
      'lib/services/__tests__/letta-client.test.ts',
      'lib/services/__tests__/letta-deploy-templates.test.ts',
      'docker/letta-compose.yml',
      'components/harness/letta-agent-detail.tsx',
    ]
    expect(gone.filter((f) => fs.existsSync(path.join(ROOT, f)))).toEqual([])
  })
})

describe('R2: no elizaOS code', () => {
  it('nothing mentions eliza', () => {
    expect(hits(/eliza/i, (f) => f === SELF || MIGRATION_DOCS.includes(f))).toEqual([])
  })
})

describe('R6: no Letta routes, page or sidebar entry', () => {
  it('there is no /api/letta route tree and no /letta page (so both are 404)', () => {
    // Next.js routes are files. No file under these paths means no route.
    expect(repoFiles().filter((f) => /^app\/(api\/letta|\(dashboard\)\/letta)(\/|$)/.test(f))).toEqual([])
    expect(fs.existsSync(path.join(ROOT, 'app/api/letta'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'app/(dashboard)/letta'))).toBe(false)
  })

  it('nothing links to /letta or /api/letta', () => {
    expect(hits(/['"`(]\/(api\/)?letta\b/, (f) => f === SELF || MIGRATION_DOCS.includes(f) || TRANSLATED(f))).toEqual([])
  })

  it('the sidebar has no Letta entry', () => {
    const sidebar = fs.readFileSync(path.join(ROOT, 'components/shell/sidebar.tsx'), 'utf-8')
    expect(sidebar).not.toMatch(/letta/i)
  })
})

describe('R7: the sanitization gate needs no Letta exception', () => {
  it('sanitize.config.json allows no Letta connection string', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'sanitize.config.json'), 'utf-8')
    expect(raw).not.toMatch(/letta/i)
    // And it still parses, with its allow list intact.
    const cfg = JSON.parse(raw)
    expect(cfg.deterministic.allow_substrings).toContain('+1234567890')
  })
})
