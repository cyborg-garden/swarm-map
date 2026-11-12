// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { policyHash, withHash } from '../policy/canonical.ts'
import { validatePolicy } from '../policy/validate.ts'

const team = () => withHash(loadFixturePolicy('policy-team.json'))

describe('validatePolicy', () => {
  it('[U:validate] accepts a well-formed test policy', () => {
    expect(validatePolicy(team(), { testing: true })).toEqual([])
  })

  it('[U:validate] refuses the fake surface outside tests', () => {
    expect(validatePolicy(team())).toEqual(["surfaces.fake: the 'fake' surface is for tests only"])
  })

  it('[U:validate] refuses a stale hash', () => {
    const edited = { ...team(), posture: 'public' as const }
    expect(validatePolicy(edited, { testing: true })).toEqual(['hash: does not match the record'])
  })

  it('[U:validate] refuses a wrong schema, an empty agent id and a bad version', () => {
    const broken = withHash(applyPatch(team(), { schema: 2, agentId: '', version: 0 }))
    expect(validatePolicy(broken, { testing: true })).toEqual([
      'schema: must be 1', 'agentId: must not be empty', 'version: must be a positive whole number',
    ])
  })

  it('[U:validate] refuses a policy that asks for a rule that is not built', () => {
    const asks = withHash(applyPatch(team(), { 'tools.ask': ['shell'] }))
    expect(validatePolicy(asks, { testing: true })).toEqual([
      'tools.ask: the rule that reads it (priv.approval) is not built yet',
    ])
  })

  it('the hash ignores key order and the hash field itself', () => {
    const p = team()
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as typeof p
    expect(policyHash(reordered)).toBe(p.hash)
    expect(policyHash({ ...p, hash: 'something else' })).toBe(p.hash)
    expect(policyHash({ ...p, version: p.version + 1 })).not.toBe(p.hash)
  })
})
