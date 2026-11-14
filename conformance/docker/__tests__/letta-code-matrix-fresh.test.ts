// @vitest-environment node
//
// The Docker matrix for Letta Code is evidence from a run on a machine with
// Docker, and only `npm run conformance:docker -- letta-code` may write it. CI cannot repeat that run, but it
// can tell when the file no longer matches the suite: a check or a broken rig
// added since means the evidence is out of date and the run has to be done
// again. It also holds the file to what it may claim.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LETTA_CODE_VERSION } from '../../../lib/runtimes/letta-code/caps.ts'
import { LETTA_CODE_CHECKS } from '../../harnesses/letta-code.ts'
import { KNOWN_CHECK_IDS, type Matrix } from '../../matrix.ts'
import { BROKEN_RIGS, IN_CELL as SHARED_IN_CELL, SKIPPED_IN_CELL } from '../broken.ts'
import { SEAL_CHECKS } from '../runner.ts'

const file = path.resolve(import.meta.dirname, '..', '..', 'matrix', `letta-code-${LETTA_CODE_VERSION}.docker.json`)
const IN_CELL = [...SHARED_IN_CELL, ...LETTA_CODE_CHECKS]
const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

describe('the committed Docker matrix for the pinned Letta Code', () => {
  it('[U:letta-code-docker-matrix] is from a real Letta Code of the pinned version in a Docker cell, and says which Docker', () => {
    expect(committed).toMatchObject({ harness: 'letta-code', version: LETTA_CODE_VERSION, harnessBuild: 'real', substrate: 'docker', model: 'scripted' })
    expect(committed.runner).toMatchObject({ kind: 'docker' })
    expect(committed.runner?.server).toMatch(/^\d+\./)
    // It speaks for the machine it ran on and no other.
    expect(committed.caveats.join(' ')).toContain('Another Docker host, or another version, is not shown')
  })

  it('[U:letta-code-docker-matrix] has a result for every check the Docker run makes today, under today\'s title', () => {
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...LETTA_CODE_CHECKS.map((c) => c.id)])].sort())
    for (const check of [...SEAL_CHECKS, ...IN_CELL]) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance:docker -- letta-code`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
    for (const [id, reason] of Object.entries(SKIPPED_IN_CELL)) expect(rows[id]).toMatchObject({ status: 'not-run', reason })
  })

  it('[U:letta-code-docker-matrix] names every broken rig the suite has today, and on that run each turned its checks red', () => {
    const today = Object.fromEntries(Object.entries(BROKEN_RIGS).map(([name, rig]) => [name, rig.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })

  it('[U:letta-code-docker-matrix] every wall check has a rig that is broken for it', () => {
    const covered = new Set(Object.values(BROKEN_RIGS).flatMap((rig) => rig.red))
    for (const id of ['S0', 'S1', 'S2', 'S3', 'C8', 'C9', 'C10']) expect([...covered], id).toContain(id)
    for (const rig of Object.values(BROKEN_RIGS)) for (const id of [...rig.red, ...rig.green]) expect(KNOWN_CHECK_IDS).toContain(id)
  })
})
