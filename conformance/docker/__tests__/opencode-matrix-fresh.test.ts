// @vitest-environment node
//
// The Docker matrix for OpenCode is evidence from a run on a machine with
// Docker, and only `npm run conformance:docker -- opencode` may write it. CI
// cannot repeat that run, but it can tell when the file no longer matches the
// suite: a check or a broken rig added since means the run has to be done again.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENCODE_VERSION } from '../../../lib/runtimes/opencode/caps.ts'
import { OPENCODE_TOOL_CHECKS } from '../../harnesses/opencode.ts'
import type { Matrix } from '../../matrix.ts'
import { BROKEN_RIGS, IN_CELL as SHARED_IN_CELL, SKIPPED_IN_CELL } from '../broken.ts'
import { SEAL_CHECKS } from '../runner.ts'

const file = path.resolve(import.meta.dirname, '..', '..', 'matrix', `opencode-${OPENCODE_VERSION}.docker.json`)
const IN_CELL = [...SHARED_IN_CELL, ...OPENCODE_TOOL_CHECKS]
const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

describe('the committed Docker matrix for the pinned OpenCode', () => {
  it('[U:opencode-docker-matrix] is from a real OpenCode of the pinned version in a Docker cell, and says which Docker', () => {
    expect(committed).toMatchObject({ harness: 'opencode', version: OPENCODE_VERSION, harnessBuild: 'real', substrate: 'docker', model: 'scripted' })
    expect(committed.runner).toMatchObject({ kind: 'docker' })
    expect(committed.runner?.server).toMatch(/^\d+\./)
    expect(committed.caveats.join(' ')).toContain('Another Docker host, or another version, is not shown')
    // What no cell changes: the agent runs its own tools, and a no is only caught after the fact.
    expect(committed.caveats.join(' ')).toContain('ACP permission requests are advisory')
  })

  it('[U:opencode-docker-matrix] every check the Docker run makes today passed, under today\'s title', () => {
    for (const check of [...SEAL_CHECKS, ...IN_CELL]) {
      expect(rows[check.id], `${check.id}: run npm run conformance:docker -- opencode`).toMatchObject({ status: 'pass', title: check.title })
    }
    for (const [id, reason] of Object.entries(SKIPPED_IN_CELL)) expect(rows[id]).toMatchObject({ status: 'not-run', reason })
  })

  it('[U:opencode-docker-matrix] names every broken rig the suite has today, and each was caught', () => {
    const today = Object.fromEntries(Object.entries(BROKEN_RIGS).map(([name, rig]) => [name, rig.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })
})
