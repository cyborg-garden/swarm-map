// @vitest-environment node
//
// D: the decide() table. One scenario pair per rule. The base outcome and the
// twin outcome must both match the file AND differ from each other, and the
// rule under test must have taken part in the difference.
import { describe, expect, it } from 'vitest'
import { decide } from '../decide.ts'
import {
  loadScenarios, scenarioFacts, scenarioPolicy, scenarioSteps, stepEvent, type Scenario,
} from '../../../conformance/scenarios/load.ts'

function run(s: Scenario, which: 'base' | 'twin') {
  const policy = scenarioPolicy(s, which)
  const facts = scenarioFacts(s, which)
  let last = undefined as ReturnType<typeof decide> | undefined
  for (const step of scenarioSteps(s, which)) last = decide(policy, stepEvent(step, 'CANARY-table'), facts)
  return last!
}

const scenarios = loadScenarios()

describe('decide() table', () => {
  it('has scenarios to run', () => {
    expect(scenarios.length).toBeGreaterThan(0)
  })

  describe.each(scenarios.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    it('base outcome matches', () => {
      const d = run(s, 'base')
      expect({ verdict: d.verdict, rule: d.rule }).toEqual(s.expect.receipt)
      if (s.expect.privilege) expect(d.privilege).toBe(s.expect.privilege)
    })

    it('twin outcome matches', () => {
      const d = run(s, 'twin')
      expect({ verdict: d.verdict, rule: d.rule }).toEqual(s.twin.expect.receipt)
      if (s.twin.expect.privilege) expect(d.privilege).toBe(s.twin.expect.privilege)
    })

    it('the twin flips the outcome, and the rule under test decided one side', () => {
      const base = run(s, 'base')
      const twin = run(s, 'twin')
      const outcome = (d: typeof base) => `${d.verdict}/${d.privilege}`
      expect(outcome(twin)).not.toBe(outcome(base))
      // The rule under test decided one side, or it is in exactly one side's trace.
      const witness = s.witness ?? s.rule
      const inTrace = (d: typeof base) => d.trace.find((t) => t.rule === witness)?.outcome
      const decided = base.rule === s.rule || twin.rule === s.rule
      expect(decided || inTrace(base) !== inTrace(twin), `${witness} did not take part`).toBe(true)
    })

    it('every decision carries the hash of the policy that made it', () => {
      expect(run(s, 'base').policyHash).toBe(scenarioPolicy(s, 'base').hash)
    })
  })
})
