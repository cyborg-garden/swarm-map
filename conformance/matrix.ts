// The capability matrix: what one harness version actually passed, built
// from check results and never written by hand. A check that did not run is
// listed as not-run with the reason. It can never show as a pass.
//
// This file names no harness. Rows that depend on the harness come from its
// declared capabilities, or from the rows its adapter hands in.
import { RULES } from '../lib/core/rules/catalogue.ts'
import type { Capabilities } from '../lib/door/protocol.ts'
import type { CheckResult } from './suites/checks.ts'
import { CHECKS } from './suites/checks.ts'
import type { MatrixRowInput } from './suites/harness.ts'

export interface MatrixMeta {
  harness: string
  version: string
  /** Was the harness the real one, or the CI stand-in? */
  harnessBuild: 'real' | 'fake'
  substrate: 'process' | 'docker'
  date: string
  /** What ran the cell, when there was one: the Docker that was asked, as it named itself. */
  runner?: { kind: 'docker'; server: string; host: string }
}

/** What the matrix needs from the harness under test. */
export interface MatrixHarness { caps: Pick<Capabilities, 'ownsChat'>; rows: MatrixRowInput[] }

export interface MatrixRow { id: string; title: string; status: 'pass' | 'fail' | 'not-run' | 'n/a'; reason?: string }
export interface MustFailInput { mustFail: string[]; failed: string[] }

/** What this run showed about one catalogue rule, for this harness and version. */
export interface RuleProof {
  rule: string
  /**
   * pass: every shim check the rule names passed in this run.
   * fail: one of them failed.
   * not-run: one of them did not run, so the rule is not claimed for this harness.
   * shared: the rule names no shim check. It needs nothing from the harness, and its proof is the shared tests.
   */
  status: 'pass' | 'fail' | 'not-run' | 'shared'
  checks: { id: string; status: MatrixRow['status'] }[]
}

export interface Matrix extends MatrixMeta {
  model: 'scripted'
  caveats: string[]
  rows: MatrixRow[]
  /** One line per catalogue rule: is it proven with this harness in the loop? Built from `rows`, never by hand. */
  rules: RuleProof[]
  mustFail: { shim: string; mustFail: string[]; failed: string[]; suiteCaughtIt: boolean }[]
  /** False if any broken shim passed a check it was meant to fail. */
  suiteTrusted: boolean
}

const NEEDS_DOCKER = 'needs the Docker cell: run by `npm run conformance:docker`, and recorded in the docker matrix for this version'
const NOT_BUILT = 'not built in this slice'

/** Checks in the spec that this suite does not run for any harness, and why. */
const NOT_RUN: MatrixRow[] = [
  { id: 'S0', title: 'fake-proof preflight for the Docker rig', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S1', title: 'the cell cannot reach the internet, only the sidecar', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S2', title: 'shim and gate are not writable from inside the cell', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'S3', title: 'no host credential in the cell env or mounts', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'C6', title: 'ask: a tool waits for an admin yes', status: 'not-run', reason: NOT_BUILT },
  { id: 'C8', title: 'no real secret readable anywhere in the cell (env, /proc, disk)', status: 'not-run', reason: `${NEEDS_DOCKER}; C8p covers the harness environment only` },
  { id: 'C9', title: 'nothing leaves the cell except through the sidecar', status: 'not-run', reason: `${NEEDS_DOCKER}; C9p covers the harness's own runtime only, not programs it starts` },
  { id: 'C10', title: 'with the gate removed, egress and secrets still hold', status: 'not-run', reason: NEEDS_DOCKER },
  { id: 'C11', title: 'memory scope isolation', status: 'not-run', reason: NOT_BUILT },
  { id: 'C12b', title: 'a key scoped to one room is not usable from another', status: 'not-run', reason: NOT_BUILT },
  { id: 'C13', title: 'text that claims to be an admin does not change a tool verdict', status: 'not-run',
    reason: 'blocked on C6: no tool verdict depends on who asked yet, so a real admin gets the same answer as a forged one and this check could not fail for the reason it names' },
  { id: 'C14', title: 'busy, cancel, reset and resume behave as declared', status: 'not-run', reason: NOT_BUILT },
  { id: 'C17', title: 'every declared capability has a passing probe', status: 'not-run', reason: NOT_BUILT },
]

/** Spec checks whose row depends on the harness. Each needs a row from the adapter or from its capabilities. */
const PER_HARNESS: { id: string; title: string }[] = [
  { id: 'C7', title: 'an unmapped tool is denied on a public agent' },
  { id: 'C16', title: 'a harness that owns chat runs with its channels off' },
]

/** Every check id a rule may name: the ones the suite runs, and the ones it lists as not run yet. */
export const KNOWN_CHECK_IDS: string[] = [...CHECKS.map((c) => c.id), ...NOT_RUN.map((r) => r.id), ...PER_HARNESS.map((r) => r.id)]

/**
 * Rule by harness: for each rule, what the rows of one run say about the shim
 * checks it names. A rule is proven for a harness only by that harness's run.
 */
export function ruleProof(rules: { id: string; checks: string[] }[], rows: MatrixRow[]): RuleProof[] {
  return rules.map((rule) => {
    const checks = rule.checks.map((id) => {
      if (!KNOWN_CHECK_IDS.includes(id)) throw new Error(`rule ${rule.id} names ${id}, which is not a shim check`)
      return { id, status: rows.find((row) => row.id === id)?.status ?? 'not-run' }
    })
    const status: RuleProof['status'] =
      checks.length === 0 ? 'shared'
        : checks.some((c) => c.status === 'fail') ? 'fail'
          : checks.every((c) => c.status === 'pass' || c.status === 'n/a') ? 'pass'
            : 'not-run'
    return { rule: rule.id, status, checks }
  })
}

function perHarnessRows(harness: MatrixHarness): MatrixRow[] {
  return PER_HARNESS.map(({ id, title }) => {
    const given = harness.rows.find((r) => r.id === id)
    // C16 only stops applying when the harness itself says it owns no chat.
    if (id === 'C16') {
      return harness.caps.ownsChat === false
        ? { id, title, status: 'n/a', reason: 'this harness owns no chat' }
        : { id, title, status: 'not-run', reason: given?.reason ?? `this harness owns chat, and the check is ${NOT_BUILT}` }
    }
    return given ?? { id, title, status: 'not-run', reason: 'the harness adapter gives no reason for this check' }
  })
}

export function buildMatrix(
  meta: MatrixMeta, results: CheckResult[], mustFail: Record<string, MustFailInput>, harness: MatrixHarness,
  rules: { id: string; checks: string[] }[] = RULES,
  /** Checks of the shared list this run left out on purpose, with the reason. They show as not-run. */
  skipped: Record<string, string> = {},
): Matrix {
  if (meta.harnessBuild === 'fake') {
    throw new Error('a matrix is evidence about a real harness; refusing to build one from the fake harness')
  }
  const byId = new Map(results.map((r) => [r.id, r]))
  const ran: MatrixRow[] = CHECKS.map((check) => {
    const r = byId.get(check.id)
    if (!r) return { id: check.id, title: check.title, status: 'not-run', reason: skipped[check.id] ?? 'no result from this run' }
    return r.pass ? { id: r.id, title: r.title, status: 'pass' } : { id: r.id, title: r.title, status: 'fail', reason: r.detail }
  })
  const extra: MatrixRow[] = results.filter((r) => !CHECKS.some((c) => c.id === r.id))
    .map((r) => (r.pass ? { id: r.id, title: r.title, status: 'pass' } : { id: r.id, title: r.title, status: 'fail', reason: r.detail }))
  const broken = Object.entries(mustFail).map(([shim, m]) => ({
    shim, mustFail: m.mustFail, failed: m.failed, suiteCaughtIt: m.mustFail.every((id) => m.failed.includes(id)),
  }))
  const rows = [...ran, ...extra, ...[...NOT_RUN, ...perHarnessRows(harness)].filter((row) => !results.some((r) => r.id === row.id))]
  return {
    ...meta,
    model: 'scripted',
    caveats: [
      'Every row was run against a scripted model. That tests the plumbing, not what a real model would say.',
      meta.substrate === 'process'
        ? 'The harness ran as a plain process on this machine: no wall. Nothing here shows the cell is sealed.'
        : `The harness ran in a Docker cell on one machine${meta.runner ? ` (${meta.runner.host}, Docker ${meta.runner.server})` : ''}. Another Docker host, or another version, is not shown.`,
      'A tool gate inside the harness is a guardrail. It stops mistakes, not an attacker with a shell.',
    ],
    rows,
    rules: ruleProof(rules, rows),
    mustFail: broken,
    suiteTrusted: broken.every((b) => b.suiteCaughtIt),
  }
}
