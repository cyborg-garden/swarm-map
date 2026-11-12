// @vitest-environment node
//
// D: properties of decide(), over seeded random policies and messages.
import { describe, expect, it } from 'vitest'
import { genInbound, genPolicy, rng, ROOMS } from '../../../conformance/gen.ts'
import { decide } from '../decide.ts'
import type { InboundEvent } from '../events.ts'
import { withHash } from '../policy/canonical.ts'
import { DEFERRED_FIELDS, UnrenderedError } from '../policy/deferred.ts'
import type { PolicyRecord } from '../policy/types.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'

const CASES = 500
const heard = (v: string): boolean => v === 'deliver' || v === 'observe'

function cases(seed: number, each: (policy: PolicyRecord, event: InboundEvent, i: number) => void): void {
  const r = rng(seed)
  for (let i = 0; i < CASES; i++) each(genPolicy(r), genInbound(r), i)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('decide() properties', () => {
  it('1. an empty list admits nobody', () => {
    let exercised = 0
    cases(101, (policy, event) => {
      const s = policy.surfaces.fake!
      const closed = withHash({
        ...policy,
        surfaces: { fake: { ...s, users: [], anyoneInAllowedRoom: false, dm: { ...s.dm, users: [], mode: s.dm.mode === 'open' ? 'allowlist' : s.dm.mode } } },
      })
      if (!event.sender.isBot) {
        exercised++
        expect(heard(decide(closed, event, {}).verdict), JSON.stringify(event)).toBe(false)
      }
      const noRooms = withHash({ ...policy, surfaces: { fake: { ...s, rooms: [] } } })
      if (!event.isDm) expect(heard(decide(noRooms, event, {}).verdict)).toBe(false)
    })
    expect(exercised).toBeGreaterThan(CASES / 2)
  })

  it('2. a drop routes nowhere: it carries no session key, and anything heard carries one', () => {
    const seen = new Set<string>()
    cases(102, (policy, event) => {
      const d = decide(policy, event, {})
      seen.add(d.verdict)
      if (d.verdict === 'drop') expect(d.sessionKey).toBeUndefined()
      else expect(d.sessionKey).toMatch(/^fake:(dm|room):/)
    })
    expect([...seen].sort()).toEqual(['deliver', 'drop', 'observe'])
  })

  it('3. an admin who is not admitted is not heard', () => {
    let exercised = 0
    cases(103, (policy, event) => {
      if (event.sender.isBot) return
      const s = policy.surfaces.fake!
      const outsider = { ...event, sender: { ...event.sender, id: 'u-outsider', roles: [] } }
      const p = withHash({
        ...policy,
        surfaces: { fake: {
          ...s, anyoneInAllowedRoom: false, admins: [{ kind: 'user', id: 'u-outsider' }],
          dm: { ...s.dm, mode: s.dm.mode === 'open' ? 'allowlist' : s.dm.mode },
        } },
      })
      exercised++
      expect(heard(decide(p, outsider, {}).verdict)).toBe(false)
    })
    expect(exercised).toBeGreaterThan(CASES / 2)
  })

  it('4. ignore beats every allow', () => {
    let exercised = 0
    cases(104, (policy, event) => {
      if (event.isDm) return
      const s = policy.surfaces.fake!
      const target = event.room.kind === 'thread' ? event.room.parentId! : event.room.id
      const r = rng(exercised)
      const rooms = [...ROOMS.map((room) => ({ match: { room }, mode: 'free' as const })), ...s.rooms]
      rooms.splice(r.int(rooms.length + 1), 0, { match: { room: target }, mode: 'ignore' })
      const p = withHash({ ...policy, surfaces: { fake: { ...s, anyoneInAllowedRoom: true, rooms } } })
      exercised++
      expect(heard(decide(p, event, {}).verdict)).toBe(false)
    })
    expect(exercised).toBeGreaterThan(CASES / 2)
  })

  it('5. decide() is pure: same input, same output, and nothing is mutated', () => {
    cases(105, (policy, event) => {
      const before = JSON.stringify([policy, event])
      deepFreeze(policy)
      deepFreeze(event)
      const first = decide(policy, event, {})
      const second = decide(policy, event, {})
      expect(second).toEqual(first)
      expect(JSON.stringify([policy, event])).toBe(before)
    })
  })

  describe('6. a deferred field set to anything but its resting value makes decide() refuse', () => {
    // One value per deferred field that asks for the unbuilt behaviour.
    const ASKS: Record<string, unknown> = {
      'mode': 'native',
      'surfaces.*.dm.mode': 'pairing',
      'surfaces.*.bots.roles': ['role-bots'],
      'surfaces.*.bots.maxAlternatingTurns': 9,
      'surfaces.*.invites.mode': 'open',
      'surfaces.*.approverRoles': ['role-mod'],
      'tools.ask': ['shell'],
      'tools.perRoom': { 'r-general': { deny: ['shell'] } },
      'tools.browserGuard': 'public-hosts-only',
      'keys': [{ ref: 'k-1', kind: 'model', hosts: [] }],
      'egress.default': 'allow',
      'egress.hosts': [{ host: 'example.com' }],
      'egress.blockPrivateRanges': false,
      'memory.threadsPoolIntoParent': false,
      'memory.dmIsolated': false,
      'memory.team.dm': 'read',
      'memory.team.group': 'read-write',
      'memory.team.public': 'read',
      'memory.store.kind': 'sqlite',
      'memory.store.repo': 'some/repo',
      'session.groupShared': false,
      'session.resetAtLocalHour': 3,
    }
    const event = genInbound(rng(106))
    const base = loadFixturePolicy('policy-team.json')

    it('the resting policy is accepted', () => {
      expect(() => decide(withHash(base), event, {})).not.toThrow()
    })

    it('every deferred field that can ask for something has a case here', () => {
      const labels = DEFERRED_FIELDS.filter((d) => d.atRest('anything-at-all') && d.atRest('pairing')).map((d) => d.path)
      expect(labels.sort()).toEqual(['surfaces.*.account', 'session.timezone'].sort())
      const need = DEFERRED_FIELDS.map((d) => d.path).filter((p) => !labels.includes(p))
      expect(Object.keys(ASKS).sort()).toEqual(need.sort())
    })

    it.each(Object.entries(ASKS))('%s', (path, value) => {
      const policy = withHash(applyPatch(base, { [path.replace('*', 'fake')]: value }))
      expect(() => decide(policy, event, {})).toThrow(UnrenderedError)
    })
  })

  it('an event kind with no rule yet is refused, not waved through', () => {
    const policy = withHash(loadFixturePolicy('policy-team.json'))
    const room = { id: 'r-general', kind: 'channel' as const }
    expect(() => decide(policy, { kind: 'egress', host: 'example.com', method: 'GET' }, {})).toThrow(UnrenderedError)
    expect(() => decide(policy, { kind: 'memory', op: 'read', scope: { kind: 'team' }, room }, {})).toThrow(UnrenderedError)
  })
})
