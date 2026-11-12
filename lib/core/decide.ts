// decide(): the one place a rule is evaluated. Pure: no I/O, no clock, no
// mutation. The sidecar, the "why didn't it answer?" view and the tests all
// call this same function. Spec section 4.3.
import type { Decision, Event, Facts, InboundEvent, Principal, RoomRef, Verdict } from './events.ts'
import { assertRendered } from './policy/deferred.ts'
import type { PolicyRecord, PrincipalRef, RoomRule, SurfacePolicy } from './policy/types.ts'

type Trace = Decision['trace']
type Privilege = Decision['privilege']

function rolesOf(p: Principal, facts: Facts): string[] {
  return [...p.roles, ...(facts.rolesOf?.[p.id] ?? [])]
}

function matches(refs: PrincipalRef[], p: Principal, facts: Facts): boolean {
  const roles = rolesOf(p, facts)
  return refs.some((ref) => (ref.kind === 'user' ? ref.id === p.id : roles.includes(ref.id)))
}

function ruleMatchesRoom(rule: RoomRule, room: RoomRef): boolean {
  if ('room' in rule.match) return rule.match.room === room.id || rule.match.room === room.parentId
  return room.categoryId !== undefined && rule.match.category === room.categoryId
}

/** 'ignore' beats everything; otherwise the first matching rule wins. */
function roomMode(surface: SurfacePolicy, room: RoomRef): RoomRule['mode'] | undefined {
  const hits = surface.rooms.filter((rule) => ruleMatchesRoom(rule, room))
  if (hits.some((rule) => rule.mode === 'ignore')) return 'ignore'
  return hits[0]?.mode
}

function privilegeOf(surface: SurfacePolicy | undefined, p: Principal, facts: Facts, admitted: 'listed' | 'open'): Privilege {
  if (surface && matches(surface.admins, p, facts)) return 'admin'
  return admitted === 'listed' ? 'member' : 'guest'
}

function decideInbound(policy: PolicyRecord, e: InboundEvent, facts: Facts): Omit<Decision, 'policyHash'> {
  const trace: Trace = []
  const surface = policy.surfaces[e.surface]
  const done = (verdict: Verdict, rule: string, why: string, privilege: Privilege = 'guest') => {
    trace.push({ rule, outcome: verdict === 'drop' ? 'fail' : 'pass' })
    return { verdict, rule, why, privilege, trace }
  }
  const pass = (rule: string) => { trace.push({ rule, outcome: 'pass' }) }

  if (!surface || !surface.enabled) return done('drop', 'adm.surface', `The ${e.surface} surface is switched off.`)
  pass('adm.surface')

  // Where
  if (surface.rooms.length === 0) return done('drop', 'adm.empty-is-closed', 'No rooms are listed, so no room is heard.')
  const mode = roomMode(surface, e.room)
  if (mode === 'ignore') return done('drop', 'adm.rooms.ignore', 'This room is on the ignore list.')
  if (mode === undefined) return done('drop', 'adm.rooms', 'This room is not on the list.')
  pass('adm.rooms')

  // Who
  let admitted: 'listed' | 'open'
  if (matches(surface.users, e.sender, facts)) {
    admitted = 'listed'
    pass('adm.users')
  } else if (surface.anyoneInAllowedRoom) {
    admitted = 'open'
    pass('adm.anyone-in-room')
  } else if (surface.users.length === 0) {
    return done('drop', 'adm.empty-is-closed', 'Nobody is listed, so nobody is heard.')
  } else {
    return done('drop', 'adm.users', 'The sender is not on the list.')
  }
  const privilege = privilegeOf(surface, e.sender, facts, admitted)

  // Addressing
  const addressed = e.mention || e.inlineMention || e.replyToAgent
  if (addressed) return done('deliver', 'addr.mention', 'The agent was addressed in an approved room.', privilege)
  return done('drop', 'addr.mention', 'This room needs a mention and there was none.', privilege)
}

/**
 * Decide what happens to one event under one policy.
 * Throws UnrenderedError (fail closed) when the policy or the event asks for
 * something this slice does not enforce yet.
 */
export function decide(policy: PolicyRecord, event: Event, facts: Facts): Decision {
  assertRendered(policy)
  if (event.kind === 'inbound') return { ...decideInbound(policy, event, facts), policyHash: policy.hash }
  throw new Error(`decide: no rule yet for '${event.kind}' events`)
}
