// @vitest-environment node
/**
 * One way in to a Hermes home.
 *
 * An id or agent name becomes `~/.hermes-<name>` in exactly one function,
 * agentHomeForName() in lib/services/data-dir.ts, and code that starts from
 * an id it was handed (a URL, a request body, a stored key assignment) must
 * reach it through agentHome(), which refuses a row Swarm Map does not
 * manage. Before this there were a dozen private copies of the mapping, and
 * each one treated a retired row's id as a Hermes agent.
 *
 * These checks read the source. They keep a new private copy, or a new
 * unchecked caller, from landing unnoticed.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')

// Everything the Next.js server loads. scripts/ is left out on purpose: the
// one script that builds these paths (scripts/token-broker/rollout.mjs) walks
// the directories that exist on disk and never starts from a stored id.
const SCANNED = ['lib', 'app/api', 'instrumentation.ts', 'proxy.ts']

/** Server-side source: everything that runs with the operator's file access. */
function serverSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCANNED], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !/(\.test\.tsx?$|\/__tests__\/)/.test(f))
    .filter((f) => fs.lstatSync(path.join(ROOT, f), { throwIfNoEntry: false })?.isFile() === true)
}

function linesMatching(pattern: RegExp, files = serverSources()): string[] {
  const found: string[] = []
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), 'utf-8')
      .split('\n')
      .forEach((line, i) => {
        if (pattern.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line) && !READS_DIR_LISTING.test(line)) found.push(`${file}:${i + 1}`)
      })
  }
  return found
}

const filesOf = (hits: string[]) => [...new Set(hits.map((h) => h.split(':')[0]))].sort()

// A Hermes home being put together by hand. Any string literal that ENDS in
// `.hermes-` or is exactly `.hermes` is one half of such a path, however the
// other half is joined on (+, a template, .concat, a constant). So is a bare
// '.' glued to a variable, which is how the old guessDataDir did it.
// `.hermes-swarm-map` (Swarm Map's own data dir) and `.hermes-swarm` do not
// match: the literal goes on past the hyphen.
const BUILDS_HOME = /\.hermes-(\$\{|['"`])|['"`]\.hermes['"`]|['"`]\.['"`]\s*\+|`\.\$\{/

// The one line that names these prefixes without building a path: the port
// scan lists the home directory and keeps the entries that look like agents.
const READS_DIR_LISTING = /entry\.name (!==|===) '\.hermes' && !entry\.name\.startsWith\('\.hermes-'\)/

describe('the scan can see the code (a scan over nothing passes everything)', () => {
  it('lists the server sources, without tests', () => {
    const files = serverSources()
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain('lib/services/data-dir.ts')
    expect(files).toContain('app/api/harnesses/[id]/settings/route.ts')
    expect(files).toContain('instrumentation.ts')
    expect(files.some((f) => f.includes('.test.'))).toBe(false)
  })

  it('finds the one place a Hermes home is built', () => {
    expect(filesOf(linesMatching(BUILDS_HOME))).toContain('lib/services/data-dir.ts')
  })

  it('the pattern catches every shape the old private copies used', () => {
    for (const line of [
      'return path.join(os.homedir(), `.hermes-${name}`)',
      "return path.join(home, '.hermes-' + serviceName)",
      "const dir = path.join(os.homedir(), '.hermes')",
      "return path.join(home, '.' + serviceName)",
      "return path.join(home, '.' + containerName)",
      'return path.join(home, `.${serviceName}`)',
      "return path.join(home, '.hermes-'.concat(name))",
      "return path.join(home, '.hermes' + '-' + name)",
      "const PREFIX = '.hermes-'",
    ]) {
      expect(BUILDS_HOME.test(line), line).toBe(true)
    }
    for (const line of [
      ": path.join(os.homedir(), '.hermes-swarm-map')",
      "const swarmDir = path.join(os.homedir(), '.hermes-swarm')",
    ]) {
      expect(BUILDS_HOME.test(line), line).toBe(false)
    }
    // The directory-listing line matches the pattern and is let through by
    // its own exact shape, not by a looser pattern.
    const listing = "    if (entry.name !== '.hermes' && !entry.name.startsWith('.hermes-')) continue"
    expect(BUILDS_HOME.test(listing)).toBe(true)
    expect(READS_DIR_LISTING.test(listing)).toBe(true)
    expect(READS_DIR_LISTING.test("const d = entry.name === 'x' ? '.hermes-' + entry.name : ''")).toBe(false)
  })
})

describe('a Hermes home is built in one place', () => {
  it('only lib/services/data-dir.ts puts `.hermes-<name>` together', () => {
    expect(filesOf(linesMatching(BUILDS_HOME))).toEqual(['lib/services/data-dir.ts'])
  })
})

describe('the unchecked mapping is only used where the name is already known to be Hermes', () => {
  // agentHomeForName() (and its older name, agentDataDirForName) does no
  // check. Each file here either got the name from HarnessService.list() or
  // get(), which leave unmanaged rows out, or is making a brand-new agent
  // after refusing a held name. Adding a file to this list is a decision:
  // say in the file where the name comes from.
  const UNCHECKED_ALLOWED = [
    'app/api/harnesses/[id]/migrate-db/route.ts', // harness from get()
    'app/api/setup/deploy/route.ts', // new agent, after the held-name refusal
    'lib/services/agent-home.ts', // the checked wrapper itself
    'lib/services/data-dir.ts', // the definition
    'lib/services/db-snapshot.ts', // names from list()
    'lib/services/discord-thread-gate-fleet.ts', // names from list()
    'lib/services/harness.ts', // discovery, and create/duplicate/import/remove after their own checks
    'lib/services/index.ts', // names from list()
    'lib/services/integrity.ts', // sweep targets from list()
    'lib/services/runtime-adapter.ts', // asks only whether a home exists
  ]

  it('the unchecked helpers appear only in the allowed files', () => {
    expect(filesOf(linesMatching(/\b(agentHomeForName|agentDataDirForName|newAgentHomeForName|personalAgentHome)\b/))).toEqual(UNCHECKED_ALLOWED)
  })

  it('agentHomeForSelfRead is only used by the endpoints an agent calls about itself', () => {
    expect(filesOf(linesMatching(/\bagentHomeForSelfRead\b/))).toEqual([
      'app/api/harnesses/[id]/policy/route.ts',
      'lib/services/agent-home.ts',
      'lib/services/surface-admins.ts',
    ])
  })
})
