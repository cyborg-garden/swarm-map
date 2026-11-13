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

/** Server-side source: everything that runs with the operator's file access. */
function serverSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'lib', 'app/api'], {
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
        if (pattern.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) found.push(`${file}:${i + 1}`)
      })
  }
  return found
}

const filesOf = (hits: string[]) => [...new Set(hits.map((h) => h.split(':')[0]))].sort()

// `.hermes-${name}`, '.hermes-' + name, '.' + serviceName: a Hermes home
// being put together by hand. `.hermes-swarm-map` (Swarm Map's own data dir)
// and `.hermes-swarm` do not match: a literal follows the hyphen.
const BUILDS_HOME = /\.hermes-(\$\{|['"`]\s*\+)|['"`]\.hermes['"`]\s*[),]|['"`]\.['"`]\s*\+\s*serviceName/

describe('the scan can see the code (a scan over nothing passes everything)', () => {
  it('lists the server sources, without tests', () => {
    const files = serverSources()
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain('lib/services/data-dir.ts')
    expect(files).toContain('app/api/harnesses/[id]/settings/route.ts')
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
    ]) {
      expect(BUILDS_HOME.test(line), line).toBe(true)
    }
    for (const line of [
      ": path.join(os.homedir(), '.hermes-swarm-map')",
      "const swarmDir = path.join(os.homedir(), '.hermes-swarm')",
      "if (entry.name !== '.hermes' && !entry.name.startsWith('.hermes-')) continue",
    ]) {
      expect(BUILDS_HOME.test(line), line).toBe(false)
    }
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
