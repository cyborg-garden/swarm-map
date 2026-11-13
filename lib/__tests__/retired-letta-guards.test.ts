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

describe('the Hermes-to-Letta bridge stays deleted', () => {
  it('no file names the bridge env vars or its deploy argument', () => {
    const allow = (f: string) =>
      f === SELF ||
      // Its test passes the old argument on purpose, to prove a stale
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
  'lib/services/runtime-adapter.ts': 'the table of retired runtime tags',
  'lib/services/__tests__/retired-runtime.test.ts': 'tests of the unknown-runtime rule',
  'lib/services/__tests__/runtime-adapter.test.ts': 'tests of the unknown-runtime rule',
  'lib/services/__tests__/agent-deploy-templates.test.ts': 'checks the bridge variables are not written',
  'lib/services/__tests__/deploy-route.integration.test.ts': 'checks deploy refuses the retired runtimes',
  'app/api/setup/deploy/route.ts': 'the message that refuses a retired runtime',
  'app/api/harnesses/retired/route.test.ts': 'retired-row fixture',
  'app/api/harnesses/__tests__/unknown-runtime-routes.test.ts': 'route sweep fixtures with a retired tag',
  'lib/services/surface-admins.ts': 'one comment; this file is left to a separate change',
  'lib/services/__tests__/surface-admins.test.ts': 'id fixtures; this file is left to a separate change',
  'scripts/sync-readme-zh.mjs': 'translator glossary: product names stay in English',
  'docs/runtimes.md': 'says what was removed and what comes next',
  'README.md': 'points at docs/runtimes.md for the retired runtime',
}

const removedPathAllowed = (f: string) => f === SELF || TRANSLATED(f)

/** May this file contain the bare word "letta"? */
const mayNameLetta = (f: string) => removedPathAllowed(f) || Object.hasOwn(MAY_SAY_LETTA, f)

describe('the old Letta server client stays deleted', () => {
  const allow = removedPathAllowed

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

describe('no Letta routes, page or sidebar entry', () => {
  it('there is no /api/letta route tree and no /letta page (so both are 404)', () => {
    // Next.js routes are files. No file under these paths means no route.
    expect(repoFiles().filter((f) => /^app\/(api\/letta|\(dashboard\)\/letta)(\/|$)/.test(f))).toEqual([])
    expect(fs.existsSync(path.join(ROOT, 'app/api/letta'))).toBe(false)
    expect(fs.existsSync(path.join(ROOT, 'app/(dashboard)/letta'))).toBe(false)
  })

  it('nothing links to /letta or /api/letta', () => {
    expect(hits(/['"`(]\/(api\/)?letta\b/, (f) => f === SELF || TRANSLATED(f))).toEqual([])
  })

  it('the sidebar has no Letta entry', () => {
    const sidebar = fs.readFileSync(path.join(ROOT, 'components/shell/sidebar.tsx'), 'utf-8')
    expect(sidebar).not.toMatch(/letta/i)
  })
})

describe('the sanitization gate needs no Letta exception', () => {
  it('sanitize.config.json allows no Letta connection string', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'sanitize.config.json'), 'utf-8')
    expect(raw).not.toMatch(/letta/i)
    // And it still parses, with its allow list intact.
    const cfg = JSON.parse(raw)
    expect(cfg.deterministic.allow_substrings).toContain('+1234567890')
  })
})
