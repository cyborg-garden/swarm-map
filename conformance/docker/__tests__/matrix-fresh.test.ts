// @vitest-environment node
//
// The Docker matrix is evidence from a run on a machine with Docker, and only
// `npm run conformance:docker` may write it. CI cannot repeat that run, but it
// can tell when the file no longer matches the suite: a check or a broken rig
// added since means the evidence is out of date and the run has to be done
// again. It also holds the file to what it may claim.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PI_VERSION } from '../../../lib/runtimes/pi/caps.ts'
import { buildMatrix, KNOWN_CHECK_IDS, type Matrix } from '../../matrix.ts'
import { MODEL_FAILURE_CHECKS } from '../../suites/failure-checks.ts'
import { BROKEN_RIGS as SHARED_RIGS, IN_CELL as SHARED_IN_CELL, MEMORY_IN_CELL, MEMORY_SKIPPED_IN_CELL, SKIPPED_IN_CELL, TOOL_RIGS, TOOLS_IN_CELL } from '../broken.ts'
import { MEMORY_CHECKS } from '../../suites/memory-checks.ts'
import { SEAL_CHECKS } from '../runner.ts'

const file = path.resolve(import.meta.dirname, '..', '..', 'matrix', `pi-${PI_VERSION}.docker.json`)
// Pi is put through the tool checks as well, with the gates that are broken for them.
const IN_CELL = [...SHARED_IN_CELL, ...TOOLS_IN_CELL, ...MEMORY_IN_CELL]
const BROKEN_RIGS = { ...SHARED_RIGS, ...TOOL_RIGS }
const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

describe('the committed Docker matrix for the pinned Pi', () => {
  it('[U:docker-matrix] is from a real Pi of the pinned version in a Docker cell, and says which Docker', () => {
    expect(committed).toMatchObject({ harness: 'pi', version: PI_VERSION, harnessBuild: 'real', substrate: 'docker', model: 'scripted' })
    expect(committed.runner).toMatchObject({ kind: 'docker' })
    expect(committed.runner?.server).toMatch(/^\d+\./)
    // It speaks for the machine it ran on and no other.
    expect(committed.caveats.join(' ')).toContain('Another Docker host, or another version, is not shown')
  })

  it('[U:docker-matrix] has a result for every check the Docker run makes today, under today\'s title', () => {
    // Plus Pi's own: the checks that a failed model call is told to the room.
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...MODEL_FAILURE_CHECKS.map((c) => c.id), ...MEMORY_CHECKS.map((c) => c.id)])].sort())
    for (const check of [...SEAL_CHECKS, ...IN_CELL]) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance:docker`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
    for (const [id, reason] of Object.entries({ ...SKIPPED_IN_CELL, ...MEMORY_SKIPPED_IN_CELL })) expect(rows[id]).toMatchObject({ status: 'not-run', reason })
  })

  it('[U:docker-matrix] names every broken rig the suite has today, and on that run each turned its checks red', () => {
    const today = Object.fromEntries(Object.entries(BROKEN_RIGS).map(([name, rig]) => [name, rig.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })

  it('[U:docker-matrix] every wall check has a rig that is broken for it', () => {
    const covered = new Set(Object.values(BROKEN_RIGS).flatMap((rig) => rig.red))
    for (const id of ['S0', 'S1', 'S2', 'S3', 'C8', 'C9', 'C10']) expect([...covered], id).toContain(id)
    // And so does a tool check of each kind: held for an admin, what ran is what was shown, the scratch folder, the limits.
    for (const id of ['C6', 'C6x', 'W1', 'L1', 'L2', 'C5v']) expect([...covered], id).toContain(id)
    for (const rig of Object.values(BROKEN_RIGS)) for (const id of [...rig.red, ...rig.green]) expect([...KNOWN_CHECK_IDS, ...MODEL_FAILURE_CHECKS.map((c) => c.id)]).toContain(id)
  })
})

describe('a matrix from a Docker run', () => {
  const meta = { harness: 'pi', version: '1.5.2', harnessBuild: 'real' as const, substrate: 'docker' as const, date: '2026-01-01', runner: { kind: 'docker' as const, server: '1.2.3', host: 'Some Docker, arm' } }
  const quiet = { caps: { ownsChat: false }, rows: [] }

  it('[U:docker-matrix] a check left out on purpose is not-run with its reason, never a pass', () => {
    const m = buildMatrix(meta, [], {}, quiet, undefined, { C9p: 'left out here' })
    expect(m.rows.find((r) => r.id === 'C9p')).toMatchObject({ status: 'not-run', reason: 'left out here' })
    expect(m.rows.find((r) => r.id === 'C1')).toMatchObject({ status: 'not-run', reason: 'no result from this run' })
  })

  it('[U:docker-matrix] a seal check that ran replaces its not-run row, and one that did not stays not-run', () => {
    const m = buildMatrix(meta, [{ id: 'S1', title: 't', pass: true, detail: 'ok' }], {}, quiet)
    expect(m.rows.filter((r) => r.id === 'S1')).toEqual([{ id: 'S1', title: 't', status: 'pass' }])
    expect(m.rows.find((r) => r.id === 'C10')?.status).toBe('not-run')
    expect(m.caveats.join(' ')).toContain('Some Docker, arm, Docker 1.2.3')
    expect(m.caveats.join(' ')).not.toContain('no wall')
  })

  it('[U:docker-matrix] the two wall rules of the model route are claimed only where the cell checks ran', () => {
    const pass = (id: string) => ({ id, title: id, pass: true, detail: 'ok' })
    const processOnly = buildMatrix({ ...meta, substrate: 'process', runner: undefined }, [pass('C12'), pass('C8p')], {}, quiet)
    expect(processOnly.rules.find((r) => r.rule === 'budget.cap')?.status).toBe('not-run')
    expect(processOnly.rules.find((r) => r.rule === 'keys.model-route')?.status).toBe('not-run')
    const inCell = buildMatrix(meta, [pass('C12'), pass('C8p'), pass('C8'), pass('C9')], {}, quiet)
    expect(inCell.rules.find((r) => r.rule === 'budget.cap')?.status).toBe('pass')
    expect(inCell.rules.find((r) => r.rule === 'keys.model-route')?.status).toBe('pass')
  })
})
