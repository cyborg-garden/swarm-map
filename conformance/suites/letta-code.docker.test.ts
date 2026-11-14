// @vitest-environment node
//
// The same checks as letta-code.real.test.ts, with Letta Code in a sealed
// Docker cell, plus the checks that need one: S0-S3, C8, C9 and C10. It is
// the Pi suite (pi.docker.test.ts) with another cell: the rig, the probe and
// the ten broken rigs are the same. Not part of the default test run (CI has
// no Docker). Run it with:
//
//   npm run conformance:docker:build -- letta-code     (once)
//   npm run conformance:docker -- letta-code
//
// Each check gets a rig of its own: a cell, the sidecar's side, a sink that
// stands in for the internet, and a control that proves the sink can be hit.
// It refuses to run, rather than skip, when Docker is not local or the images
// are not built. A complete run writes the Docker matrix from what it saw.
//
// Must-fail: the same checks against rigs that are broken on purpose. A wall
// check that stays green on a cell with a route out is not a check.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LETTA_CODE_VERSION } from '../../lib/runtimes/letta-code/caps.ts'
import { BROKEN_RIGS as BROKEN, IN_CELL as SHARED_IN_CELL, SKIPPED_IN_CELL as SKIPPED } from '../docker/broken.ts'
import { LETTA_CODE_BIN, LETTA_CODE_CELL as CELL } from '../docker/cells.ts'
import type { RigVariant } from '../docker/compose.ts'
import {
  cellRefuses, labObjects, preflight, runInRig, runSealChecks, SEAL_CHECKS, startHostListener, withRig,
  type DockerFacts, type HostListener,
} from '../docker/runner.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { LETTA_CODE_CHECKS, lettaCodeHarness } from '../harnesses/letta-code.ts'
import { buildMatrix, type MustFailInput } from '../matrix.ts'
import type { CheckResult } from './checks.ts'

armTripwire()

const harness = lettaCodeHarness([LETTA_CODE_BIN], 'real')
// The shared checks that run in a cell, then the two that are this harness's own.
const IN_CELL = [...SHARED_IN_CELL, ...LETTA_CODE_CHECKS]
const EXPECTED = SEAL_CHECKS.length + IN_CELL.length

const results: CheckResult[] = []
const mustFail: Record<string, MustFailInput> = {}
const hostCanary = { name: `LABHOST_CANARY_${randomBytes(4).toString('hex').toUpperCase()}`, value: `host-env-${randomBytes(6).toString('hex')}` }
let facts: DockerFacts | undefined
let host: HostListener
let before: ReturnType<typeof labObjects>

const run = (id: string, variant: RigVariant, gate?: 'real' | 'allows-all'): Promise<CheckResult> => {
  const check = IN_CELL.find((c) => c.id === id)!
  return runInRig(id, check.title, {
    cell: CELL, variant, gate: gate ?? (id === 'C10' ? 'allows-all' : 'real'), targets: facts!.targets,
    verdictTimeoutMs: check.lab?.verdictTimeoutMs, vetoTimeoutMs: check.lab?.vetoTimeoutMs,
  }, host)
}

beforeAll(async () => {
  // Throws REFUSING TO RUN when Docker is not this machine's, or an image is missing. This suite never skips.
  facts = preflight(CELL)
  before = labObjects(CELL.tag)
  process.env[hostCanary.name] = hostCanary.value
  host = await startHostListener()
}, 60_000)

afterAll(async () => {
  await host?.close()
  delete process.env[hostCanary.name]
  expect(tripwireAttempts()).toEqual([])
  // Every rig took itself down: nothing of the lab's is left that was not there before.
  if (facts) expect(labObjects(CELL.tag)).toEqual(before)
  // Only a complete run may write the matrix.
  if (!facts || results.length !== EXPECTED || Object.keys(mustFail).length !== Object.keys(BROKEN).length) return
  const matrix = buildMatrix(
    {
      harness: harness.caps.harness, version: LETTA_CODE_VERSION, harnessBuild: harness.build, substrate: 'docker', date: new Date().toISOString().slice(0, 10),
      runner: { kind: 'docker', server: facts.server, host: `${facts.os}, ${facts.arch}` },
    },
    results, mustFail, harness, undefined, SKIPPED,
  )
  const dir = path.resolve(import.meta.dirname, '..', 'matrix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `letta-code-${LETTA_CODE_VERSION}.docker.json`), JSON.stringify(matrix, null, 2) + '\n')
})

describe(`real Letta Code ${LETTA_CODE_VERSION} in a sealed Docker cell`, () => {
  it('S0-S3: the cell, looked at from outside', async () => {
    const seal = await runSealChecks('good', host, facts!.targets, hostCanary, CELL)
    results.push(...seal)
    for (const r of seal) expect(r.detail, r.id).toBe('ok')
  }, 180_000)

  it.each(IN_CELL.map((c) => [c.id, c.title] as const))('%s %s', async (id) => {
    const result = await run(id, 'good')
    results.push(result)
    expect(result.detail).toBe('ok')
  }, 180_000)
})

describe('must-fail: a rig broken on purpose turns its named checks red', () => {
  it.each(Object.entries(BROKEN))('%s', async (name, rig) => {
    const got: CheckResult[] = []
    if (rig.seal) got.push(...await runSealChecks(rig.variant, host, facts!.targets, hostCanary, CELL))
    for (const id of rig.checks) got.push(await run(id, rig.variant, rig.gate))
    const failed = got.filter((r) => !r.pass).map((r) => r.id)
    mustFail[name] = { mustFail: rig.red, failed }
    const detail = (id: string): string => got.find((r) => r.id === id)?.detail ?? 'not run'
    for (const id of rig.red) expect(failed, `${name} must fail ${id}`).toContain(id)
    for (const id of rig.green) expect(failed, `${name} must still pass ${id}: ${detail(id)}`).not.toContain(id)

    // Red for the reason it names, not for another.
    if (name === 'route-out') {
      expect(detail('S1')).toContain('reached the sink, by address')
      expect(detail('S1')).toContain('the sink was reached from inside the rig')
      expect(detail('C9')).toContain('the sink was reached from inside the rig')
      expect(detail('C10')).toContain('reached the sink, by address')
    }
    if (name === 'open') {
      // This is also the answer to "can the probes succeed at all?": on an ordinary network they do.
      expect(detail('S1')).toContain('reached a public address')
      expect(detail('S1')).toContain('reached a public name, asked of DNS')
      expect(detail('S1')).toContain('a listener on this machine was reached from inside the rig')
      expect(detail('S1')).toContain('reached a public resolver, asked directly over UDP')
      expect(detail('S1')).toContain('reached a listener on this machine, by address')
      expect(detail('C9')).toContain('reached a public address')
    }
    if (name === 'leaks-env') {
      expect(detail('S3')).toContain('a secret of this run is in the cell\'s environment')
      expect(detail('C8')).toContain('a secret of this run is readable at /proc/')
    }
    if (name === 'leaks-file') {
      // The key is in no environment and no command line here, so only the search of the disk can have found it.
      expect(detail('S3')).toContain('a secret of this run is readable at /tmp/leak-')
      expect(detail('S3')).not.toContain('/proc/')
      expect(detail('S3')).not.toContain('environment')
      expect(detail('C8')).toContain('a secret of this run is readable at /tmp/leak-')
      expect(detail('C8')).not.toContain('/proc/')
    }
    if (name === 'writable') {
      expect(detail('S2')).toContain('the gate could be written from inside')
      expect(detail('S2')).toContain('the container runs as root')
      expect(detail('S2')).toContain('the container holds capabilities')
      expect(detail('S2')).toContain('the cell\'s disk is not read-only')
      expect(detail('S2')).toContain('the cell: capabilities were added (CAP_DAC_OVERRIDE)')
    }
    if (name === 'socket') {
      expect(detail('S1')).toContain('a Docker socket is in the container')
      expect(detail('S3')).toContain('a Docker socket is in the cell')
    }
    if (name === 'door-out') {
      expect(detail('S1')).toContain('from the sidecar container: reached the sink, by address')
      expect(detail('S1')).toContain('the sidecar container is on ')
      expect(detail('S1')).toContain('the sink was reached from inside the rig')
      // The cell itself is still sealed: nothing in S1 is the cell's own doing.
      expect(detail('S1').split('; ').filter((problem) => problem.startsWith('reached '))).toEqual([])
    }
    if (name === 'host-mount') {
      expect(detail('S3')).toContain('mounted in the cell: bind ')
      expect(detail('S3')).toContain('the cell: a host path is bound (')
    }
    if (name === 'blind-sink') {
      expect(detail('S0')).toContain('the control reached the sink 0 times')
      expect(detail('C9')).toContain('the control reached the sink 0 times')
    }
    if (name === 'gate-kept') expect(detail('C10')).toContain('this cell still has its gate')
  }, 900_000)
})

describe('a cell handed a real-looking key is refused', () => {
  // Minted here so no key-shaped string is ever committed.
  const shaped = ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-')

  it('by the runner, before Docker is asked for anything', async () => {
    const started: string[] = []
    for (const extraCellEnv of [{ NOTES: shaped }, { OPENAI_API_KEY: 'x' }] as Record<string, string>[]) {
      await expect(withRig({ check: 'hold', variant: 'good', extraCellEnv, cell: CELL }, async (rig) => { started.push(rig.project) }))
        .rejects.toThrow(/^REFUSING TO RUN: F2 \(service cell\)/)
    }
    expect(started).toEqual([])
    expect(labObjects(CELL.tag)).toEqual(before)
  })

  it('and by the cell itself, if it is started some other way', () => {
    for (const env of [{ NOTES: shaped }, { OPENAI_API_KEY: 'x' }] as Record<string, string>[]) {
      const refused = cellRefuses({ SWARMLAB_NONCE: 'deadbeef', ...env }, CELL)
      expect(refused.code).toBe(2)
      expect(refused.out).toMatch(/REFUSING TO RUN: F2 /)
      expect(refused.out).not.toContain(shaped)
    }
    // Positive control: with nothing credential-shaped it gets past the guard (and then finds no door, with no network).
    const plain = cellRefuses({ SWARMLAB_NONCE: 'deadbeef' }, CELL)
    expect(plain.out).not.toMatch(/REFUSING TO RUN/)
  }, 180_000)
})
