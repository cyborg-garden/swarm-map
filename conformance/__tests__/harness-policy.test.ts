// @vitest-environment node
//
// A harness may patch the policy every lab starts from, because the fixture
// opens more rooms than a one-room harness can be given. That patch comes from
// the adapter of the harness under test, so it may only take rooms away. A
// patch that could allow a tool, admit a sender, open a room or change the
// posture would let an adapter make its own checks easier to pass.
import { describe, expect, it } from 'vitest'
import { fakeLettaCodeCommand, lettaCodeHarness, ONE_ROOM } from '../harnesses/letta-code.ts'
import { fakePiCommand, piHarness } from '../harnesses/pi.ts'
import { loadFixturePolicy } from '../scenarios/load.ts'
import { narrowingProblems, startLab } from '../suites/lab.ts'

const fixture = loadFixturePolicy('policy-team.json')
const R = 'surfaces.fake.rooms'
const general = { match: { room: 'r-general' }, mode: 'mention' }

describe('what a harness may change in the policy a lab starts from', () => {
  it('[U:harness-policy] taking rooms away is allowed, down to none', () => {
    expect(narrowingProblems(fixture, undefined)).toEqual([])
    expect(narrowingProblems(fixture, {})).toEqual([])
    expect(narrowingProblems(fixture, { [R]: [general] })).toEqual([])
    expect(narrowingProblems(fixture, { [R]: [] })).toEqual([])
    expect(narrowingProblems(fixture, ONE_ROOM)).toEqual([])
  })

  it.each([
    ['a tool allowed', { 'tools.allow': ['shell', 'code_exec'] }],
    ['a tool list emptied, which would make a tool check pass with nothing to refuse', { 'tools.allow': [] }],
    ['the posture', { posture: 'private' }],
    ['a budget', { budget: null }],
    ['who is heard', { 'surfaces.fake.users': [{ kind: 'user', id: 'u-mallory' }] }],
    ['anyone in a room', { 'surfaces.fake.anyoneInAllowedRoom': true }],
    ['direct messages', { 'surfaces.fake.dm': { mode: 'open', users: [] } }],
    ['admins', { 'surfaces.fake.admins': [{ kind: 'user', id: 'u-alice' }] }],
    ['a whole surface', { 'surfaces.fake': { ...fixture.surfaces.fake, anyoneInAllowedRoom: true } }],
    ['a room the fixture does not open', { [R]: [general, { match: { room: 'r-secret' }, mode: 'free' }] }],
    ['a room that needs a mention made free', { [R]: [{ match: { room: 'r-general' }, mode: 'free' }] }],
    ['a whole category', { [R]: [{ match: { category: 'c-other' }, mode: 'mention' }] }],
    ['rooms on a surface the fixture does not have', { 'surfaces.discord.rooms': [] }],
    ['something that is not a list', { [R]: 'r-general' }],
    ['the memory rule', { 'memory.dmIsolated': false }],
  ])('[U:harness-policy] %s is refused', (_what, patch) => {
    expect(narrowingProblems(fixture, patch as Record<string, unknown>).length).toBeGreaterThan(0)
  })

  it('[U:harness-policy] a lab refuses to start for a harness whose patch does more than take rooms away', async () => {
    const harness = { ...lettaCodeHarness(fakeLettaCodeCommand(), 'fake'), policy: { ...ONE_ROOM, 'tools.allow': [] } }
    await expect(startLab({ harness, shim: 'good' })).rejects.toThrow(/^REFUSING TO RUN: a harness may only take rooms away from the lab's starting policy: tools\.allow/)
  })

  it('[U:harness-policy] the harnesses the suite has today ask for nothing more', () => {
    for (const h of [piHarness(fakePiCommand(), 'fake'), lettaCodeHarness(fakeLettaCodeCommand(), 'fake')]) {
      expect(narrowingProblems(fixture, h.policy)).toEqual([])
    }
  })
})
