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

// Every value the record's type declares as a closed set. A value outside the
// set must stop the record at save time: decide() compares against the names
// it knows, so a typo would otherwise read as the permissive case.
const F = 'surfaces.fake.'
const BAD_VALUES: [string, Record<string, unknown>][] = [
  ['posture', { posture: 'Public' }],
  ['mode', { mode: 'Door' }],
  [`${F}rooms.0.mode`, { [F + 'rooms']: [{ match: { room: 'r-general' }, mode: 'Mention' }] }],
  [`${F}rooms.0.mode`, { [F + 'rooms']: [{ match: { room: 'r-general' }, mode: 'Ignore' }] }],
  [`${F}rooms.0.match`, { [F + 'rooms']: [{ match: { channel: 'r-general' }, mode: 'free' }] }],
  [`${F}bots.mode`, { [F + 'bots.mode']: 'off' }],
  [`${F}dm.mode`, { [F + 'dm.mode']: 'Closed' }],
  [`${F}invites.mode`, { [F + 'invites.mode']: 'nobody' }],
  [`${F}enabled`, { [F + 'enabled']: 'false' }],
  [`${F}anyoneInAllowedRoom`, { [F + 'anyoneInAllowedRoom']: 'no' }],
  [`${F}observeUnmentioned`, { [F + 'observeUnmentioned']: 0 }],
  [`${F}threadsRequireMention`, { [F + 'threadsRequireMention']: 'yes' }],
  [`${F}bots.inlineMentionOnly`, { [F + 'bots.inlineMentionOnly']: 'true' }],
  [`${F}users.0.kind`, { [F + 'users']: [{ kind: 'group', id: 'g-1' }] }],
  [`${F}admins.0.id`, { [F + 'admins']: [{ kind: 'user' }] }],
  [`${F}dm.users`, { [F + 'dm.users']: 'u-alice' }],
  ['surfaces.irc', { 'surfaces.irc': { enabled: true } }],
  ['tools.allow.0', { 'tools.allow': ['Shell'] }],
  ['tools.deny.0', { 'tools.deny': ['everything'] }],
  ['tools.deny', { 'tools.deny': 'shell' }],
  ['tools.browserGuard', { 'tools.browserGuard': 'on' }],
  ['budget.onExceed', { budget: { monthlyUsd: 5, onExceed: 'Warn' } }],
  ['budget.monthlyUsd', { budget: { monthlyUsd: '5', onExceed: 'refuse' } }],
  ['egress.default', { 'egress.default': 'allow' }],
  ['memory.dmIsolated', { 'memory.dmIsolated': false }],
  ['memory.team.group', { 'memory.team.group': 'write' }],
  ['session.groupShared', { 'session.groupShared': 'true' }],
]

describe('validatePolicy: closed sets', () => {
  it.each(BAD_VALUES)('[U:validate] refuses a value outside the declared set at %s', (where, patch) => {
    const errors = validatePolicy(withHash(applyPatch(team(), patch)), { testing: true })
    expect(errors.filter((e) => e.startsWith(`${where}:`)), errors.join('; ')).toHaveLength(1)
  })

  it('[U:validate] accepts an mcp tool class and every declared value', () => {
    const ok = withHash(applyPatch(team(), {
      posture: 'private', 'tools.allow': ['mcp:notion', 'unknown', 'chat_post'],
      [F + 'rooms']: [{ match: { category: 'c-1' }, mode: 'ignore' }, { match: { room: 'r-1' }, mode: 'free' }],
      [F + 'bots.mode']: 'all', [F + 'dm.mode']: 'allowlist', budget: { monthlyUsd: 0, onExceed: 'warn' },
    }))
    expect(validatePolicy(ok, { testing: true })).toEqual([])
  })

  it('[U:validate] does not throw on a record that is not even the right shape', () => {
    for (const junk of [null, 7, 'policy', [], {}, { surfaces: null, tools: 3 }]) {
      expect(validatePolicy(junk as never).length).toBeGreaterThan(0)
    }
  })
})
