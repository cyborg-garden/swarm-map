// @vitest-environment node
//
// The Docker matrix for the Claude Agent SDK is evidence from a run on a machine with
// Docker, and only `npm run conformance:docker -- claude-sdk` may write it. CI cannot repeat that run, but it
// can tell when the file no longer matches the suite: a check or a broken rig
// added since means the evidence is out of date and the run has to be done
// again. It also holds the file to what it may claim.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_SDK_VERSION } from '../../../lib/runtimes/claude-sdk/caps.ts'
import { CLAUDE_SDK_CHECKS } from '../../harnesses/claude-sdk.ts'
import { KNOWN_CHECK_IDS, type Matrix } from '../../matrix.ts'
import { BROKEN_RIGS, IN_CELL as SHARED_IN_CELL, SKIPPED_IN_CELL } from '../broken.ts'
import { SEAL_CHECKS } from '../runner.ts'

const file = path.resolve(import.meta.dirname, '..', '..', 'matrix', `claude-sdk-${CLAUDE_SDK_VERSION}.docker.json`)
const IN_CELL = [...SHARED_IN_CELL, ...CLAUDE_SDK_CHECKS]
const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

describe('the committed Docker matrix for the pinned Claude Agent SDK', () => {
  it('[U:claude-sdk-docker-matrix] is from a real Claude Agent SDK of the pinned version in a Docker cell, and says which Docker', () => {
    expect(committed).toMatchObject({ harness: 'claude-sdk', version: CLAUDE_SDK_VERSION, harnessBuild: 'real', substrate: 'docker', model: 'scripted' })
    expect(committed.runner).toMatchObject({ kind: 'docker' })
    expect(committed.runner?.server).toMatch(/^\d+\./)
    // It speaks for the machine it ran on and no other.
    expect(committed.caveats.join(' ')).toContain('Another Docker host, or another version, is not shown')
  })

  it('[U:claude-sdk-docker-matrix] has a result for every check the Docker run makes today, under today\'s title', () => {
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...CLAUDE_SDK_CHECKS.map((c) => c.id)])].sort())
    for (const check of [...SEAL_CHECKS, ...IN_CELL]) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance:docker -- claude-sdk`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
    for (const [id, reason] of Object.entries(SKIPPED_IN_CELL)) expect(rows[id]).toMatchObject({ status: 'not-run', reason })
  })

  it('[U:claude-sdk-docker-matrix] names every broken rig the suite has today, and on that run each turned its checks red', () => {
    const today = Object.fromEntries(Object.entries(BROKEN_RIGS).map(([name, rig]) => [name, rig.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })

  it('[U:claude-sdk-docker-matrix] every wall check has a rig that is broken for it', () => {
    const covered = new Set(Object.values(BROKEN_RIGS).flatMap((rig) => rig.red))
    for (const id of ['S0', 'S1', 'S2', 'S3', 'C8', 'C9', 'C10']) expect([...covered], id).toContain(id)
    for (const rig of Object.values(BROKEN_RIGS)) for (const id of [...rig.red, ...rig.green]) expect(KNOWN_CHECK_IDS).toContain(id)
  })
})
