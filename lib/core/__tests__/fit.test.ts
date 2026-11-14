// @vitest-environment node
//
// A policy has to fit the harness it is for. One kind of misfit exists so
// far: a harness that keeps one memory for the whole agent, with no way to
// turn it off or split it, may be given one conversation and no more.
import { describe, expect, it } from 'vitest'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../policy/canonical.ts'
import { fitProblems, sessionsOpened } from '../policy/fit.ts'
import type { PolicyRecord } from '../policy/types.ts'

const F = 'surfaces.fake.'
const room = (id: string, mode = 'mention') => ({ match: { room: id }, mode })
const user = (id: string) => ({ kind: 'user', id })
const policy = (patch: Record<string, unknown>): PolicyRecord =>
  withHash(applyPatch(loadFixturePolicy('policy-team.json'), { [F + 'rooms']: [], [F + 'dm']: { mode: 'closed', users: [] }, ...patch }))

const ONE_MEMORY = { nativeMemory: 'always-on' as const }

describe('how many conversations a policy opens', () => {
  it.each([
    ['nothing', {}, 0],
    ['one room', { [F + 'rooms']: [room('r-a')] }, 1],
    ['one room named twice', { [F + 'rooms']: [room('r-a'), room('r-a', 'free')] }, 1],
    ['one room and an ignored one', { [F + 'rooms']: [room('r-a'), room('r-b', 'ignore')] }, 1],
    ['two rooms', { [F + 'rooms']: [room('r-a'), room('r-b', 'free')] }, 2],
    ['a category, which is any number of rooms', { [F + 'rooms']: [{ match: { category: 'c-x' }, mode: 'mention' }] }, 'many'],
    ['an ignored category', { [F + 'rooms']: [room('r-a'), { match: { category: 'c-x' }, mode: 'ignore' }] }, 1],
    ['one listed person\'s direct messages', { [F + 'dm']: { mode: 'allowlist', users: [user('u-a')] } }, 1],
    ['two listed people\'s direct messages', { [F + 'dm']: { mode: 'allowlist', users: [user('u-a'), user('u-b')] } }, 2],
    ['direct messages for a role, which is any number of people', { [F + 'dm']: { mode: 'allowlist', users: [{ kind: 'role', id: 'r' }] } }, 'many'],
    ['open direct messages', { [F + 'dm']: { mode: 'open', users: [] } }, 'many'],
    ['a room and one person\'s direct messages', { [F + 'rooms']: [room('r-a')], [F + 'dm']: { mode: 'allowlist', users: [user('u-a')] } }, 2],
    ['a surface that is switched off', { [F + 'enabled']: false, [F + 'rooms']: [room('r-a'), room('r-b')] }, 0],
  ])('[U:one-scope] %s', (_what, patch, want) => {
    expect(sessionsOpened(policy(patch))).toBe(want)
  })

  it('[U:one-scope] rooms on two surfaces add up', () => {
    const p = policy({ [F + 'rooms']: [room('r-a')] })
    const two = { ...p, surfaces: { ...p.surfaces, discord: { ...p.surfaces.fake!, rooms: [{ match: { room: 'r-a' }, mode: 'mention' as const }] } } }
    expect(sessionsOpened(two)).toBe(2)
  })
})

describe('a harness with one memory for the whole agent', () => {
  it('[U:one-scope] fits a policy that opens one room, one person\'s direct messages, or nothing', () => {
    expect(fitProblems(policy({}), ONE_MEMORY)).toEqual([])
    expect(fitProblems(policy({ [F + 'rooms']: [room('r-a')] }), ONE_MEMORY)).toEqual([])
    expect(fitProblems(policy({ [F + 'dm']: { mode: 'allowlist', users: [user('u-a')] } }), ONE_MEMORY)).toEqual([])
  })

  it('[U:one-scope] is refused a policy that opens more, and is told why', () => {
    for (const patch of [
      { [F + 'rooms']: [room('r-a'), room('r-b')] },
      { [F + 'rooms']: [{ match: { category: 'c-x' }, mode: 'mention' }] },
      { [F + 'dm']: { mode: 'open', users: [] } },
      { [F + 'rooms']: [room('r-a')], [F + 'dm']: { mode: 'allowlist', users: [user('u-a')] } },
    ]) {
      const problems = fitProblems(policy(patch), ONE_MEMORY)
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatch(/^mem\.one-scope: this harness keeps one memory for the whole agent/)
    }
    // The fixture every other test starts from opens two rooms and a category.
    expect(fitProblems(withHash(loadFixturePolicy('policy-team.json')), ONE_MEMORY)).toHaveLength(1)
  })

  it('[U:one-scope] a harness with no memory of its own, or one that can be turned off, fits any policy', () => {
    const wide = policy({ [F + 'rooms']: [room('r-a'), room('r-b')], [F + 'dm']: { mode: 'open', users: [] } })
    expect(fitProblems(wide, { nativeMemory: 'none' })).toEqual([])
    expect(fitProblems(wide, { nativeMemory: 'off-able' })).toEqual([])
  })

  it('[U:one-scope] a harness that does not say what memory it keeps is treated as keeping one', () => {
    const wide = policy({ [F + 'rooms']: [room('r-a'), room('r-b')] })
    expect(fitProblems(wide, { nativeMemory: undefined as never })).toHaveLength(1)
    expect(fitProblems(wide, { nativeMemory: 'sometimes' as never })).toHaveLength(1)
  })
})
