// The capability matrix: what one harness version actually passed, built
// from check results and never written by hand. A check that did not run is
// listed as not-run with the reason. It can never show as a pass.
import type { CheckResult } from './suites/checks.ts'
import { CHECKS } from './suites/checks.ts'

export interface MatrixMeta {
  harness: string
  version: string
  /** Was the harness the real one, or the CI stand-in? */
  harnessBuild: 'real' | 'fake'
  substrate: 'process' | 'docker'
  date: string
}

export interface MatrixRow { id: string; title: string; status: 'pass' | 'fail' | 'not-run' | 'n/a'; reason?: string }
export interface MustFailInput { mustFail: string[]; failed: string[] }

export interface Matrix extends MatrixMeta {
  model: 'scripted'
  caveats: string[]
  rows: MatrixRow[]
  mustFail: { shim: string; mustFail: string[]; failed: string[]; suiteCaughtIt: boolean }[]
  /** False if any broken shim passed a check it was meant to fail. */
  suiteTrusted: boolean
}

const NEEDS_DOCKER = 'needs the Docker cell, which is not built yet'
const NOT_BUILT = 'not built in this slice'

/** Checks in the spec that this suite does not run, and why. */
const NOT_RUN: MatrixRow[] = [
  { id: 'S0', title: 'fake-proof preflight for the Docker rig', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S1', title: 'the cell cannot reach the internet, only the sidecar', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S2', title: 'shim and gate are not writable from inside the cell', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S3', title: 'no host credential in the cell env or mounts', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'C6', title: 'ask: a tool waits for an admin yes', status: 'not-run', reason: NOT_BUILT },
  { id: 'C7', title: 'an unmapped tool is denied on a public agent', status: 'not-run', reason: 'needs a second tool surface (MCP), off in this slice' },
  { id: 'C8', title: 'no real secret readable anywhere in the cell (env, /proc, disk)', status: 'not-run', reason: `${NEEDS_DOCKER}; C8p covers the harness environment only` },
  { id: 'C9', title: 'nothing leaves the cell except through the sidecar', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'C10', title: 'with the gate removed, egress and secrets still hold', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'C11', title: 'memory scope isolation', status: 'not-run', reason: NOT_BUILT },
  { id: 'C14', title: 'busy, cancel, reset and resume behave as declared', status: 'not-run', reason: NOT_BUILT },
  { id: 'C16', title: 'a harness that owns chat runs with its channels off', status: 'n/a', reason: 'Pi owns no chat' },
  { id: 'C17', title: 'every declared capability has a passing probe', status: 'not-run', reason: NOT_BUILT },
]

export function buildMatrix(meta: MatrixMeta, results: CheckResult[], mustFail: Record<string, MustFailInput>): Matrix {
  if (meta.harnessBuild === 'fake') {
    throw new Error('a matrix is evidence about a real harness; refusing to build one from the fake harness')
  }
  const byId = new Map(results.map((r) => [r.id, r]))
  const ran: MatrixRow[] = CHECKS.map((check) => {
    const r = byId.get(check.id)
    if (!r) return { id: check.id, title: check.title, status: 'not-run', reason: 'no result from this run' }
    return r.pass ? { id: r.id, title: r.title, status: 'pass' } : { id: r.id, title: r.title, status: 'fail', reason: r.detail }
  })
  const extra: MatrixRow[] = results.filter((r) => !CHECKS.some((c) => c.id === r.id))
    .map((r) => (r.pass ? { id: r.id, title: r.title, status: 'pass' } : { id: r.id, title: r.title, status: 'fail', reason: r.detail }))
  const broken = Object.entries(mustFail).map(([shim, m]) => ({
    shim, mustFail: m.mustFail, failed: m.failed, suiteCaughtIt: m.mustFail.every((id) => m.failed.includes(id)),
  }))
  return {
    ...meta,
    model: 'scripted',
    caveats: [
      'Every row was run against a scripted model. That tests the plumbing, not what a real model would say.',
      meta.substrate === 'process'
        ? 'The harness ran as a plain process on this machine: no wall. Nothing here shows the cell is sealed.'
        : 'The harness ran in a Docker cell.',
      'A tool gate inside the harness is a guardrail. It stops mistakes, not an attacker with a shell.',
    ],
    rows: [...ran, ...extra, ...NOT_RUN],
    mustFail: broken,
    suiteTrusted: broken.every((b) => b.suiteCaughtIt),
  }
}
