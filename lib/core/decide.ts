// decide(): the one place a rule is evaluated. Pure: no I/O, no clock, no
// mutation. The sidecar, the "why didn't it answer?" view and the tests all
// call this same function. Spec section 4.3.
import type { Decision, Event, Facts, InboundEvent, Principal, RoomRef, Verdict } from './events.ts'
import { assertRendered, UnrenderedError } from './policy/deferred.ts'
import { shapeErrors } from './policy/shape.ts'
import type { PolicyRecord, PrincipalRef, RoomRule, SurfacePolicy, ToolClass } from './policy/types.ts'
import { sessionKeyFor } from './session-key.ts'

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

function decideInbound(policy: PolicyRecord, e: InboundEvent, facts: Facts): Omit<Decision, 'policyHash'> {
  const trace: Trace = []
  const surface = policy.surfaces[e.surface]
  const pass = (rule: string) => { trace.push({ rule, outcome: 'pass' }) }
  const drop = (rule: string, why: string) => {
    trace.push({ rule, outcome: 'fail' })
    return { verdict: 'drop' as Verdict, rule, why, privilege: 'guest' as Privilege, trace }
  }

  if (!surface || !surface.enabled) return drop('adm.surface', `The ${e.surface} surface is switched off.`)
  pass('adm.surface')

  if (e.sender.isSelf) return drop('bots.no-self', 'The agent never answers itself.')
  if (e.sender.isBot) {
    if (surface.bots.mode === 'none') return drop('bots.mode', 'Other bots are ignored here.')
    pass('bots.mode')
  }

  // Privilege comes from the admin list and the sender's id as the surface
  // reported it. Nothing in the text or the display name can change it.
  const privilegeFor = (admitted: 'listed' | 'open'): Privilege => {
    const admin = matches(surface.admins, e.sender, facts)
    trace.push({ rule: 'priv.admins', outcome: admin ? 'pass' : 'n/a' })
    return admin ? 'admin' : admitted === 'listed' ? 'member' : 'guest'
  }
  const heard = (verdict: 'deliver' | 'observe', rule: string, why: string, privilege: Privilege) => {
    pass(rule)
    return { verdict: verdict as Verdict, rule, why, privilege, trace,
      sessionKey: sessionKeyFor(e.surface, e.room, e.sender.id, e.isDm) }
  }

  // Direct messages have their own admission. The room and user lists do not apply.
  if (e.isDm) {
    const dm = surface.dm
    if (dm.mode === 'closed') return drop('dm.closed', 'Direct messages are off.')
    if (dm.mode === 'open') return heard('deliver', 'dm.open', 'Direct messages are open to anyone.', privilegeFor('open'))
    if (dm.users.length === 0) return drop('adm.empty-is-closed', 'Nobody is listed for direct messages, so nobody is heard.')
    if (!matches(dm.users, e.sender, facts)) return drop('dm.allowlist', 'The sender is not on the direct-message list.')
    return heard('deliver', 'dm.allowlist', 'The sender is on the direct-message list.', privilegeFor('listed'))
  }

  // Where
  if (surface.rooms.length === 0) return drop('adm.empty-is-closed', 'No rooms are listed, so no room is heard.')
  const mode = roomMode(surface, e.room)
  if (mode === 'ignore') return drop('adm.rooms.ignore', 'This room is on the ignore list.')
  if (mode === undefined) return drop('adm.rooms', 'This room is not on the list.')
  pass('adm.rooms')

  // Who. A bot was already admitted by the bots rule above.
  let admitted: 'listed' | 'open'
  if (e.sender.isBot) {
    admitted = 'open'
  } else if (matches(surface.users, e.sender, facts)) {
    admitted = 'listed'
    pass('adm.users')
  } else if (surface.anyoneInAllowedRoom) {
    admitted = 'open'
    pass('adm.anyone-in-room')
  } else if (surface.users.length === 0) {
    return drop('adm.empty-is-closed', 'Nobody is listed, so nobody is heard.')
  } else {
    return drop('adm.users', 'The sender is not on the list.')
  }

  // Addressing. From a bot, a reply-ping only counts when the policy says so.
  const pinged = e.mention || e.inlineMention || e.replyToAgent
  const addressed = e.sender.isBot && surface.bots.inlineMentionOnly ? e.inlineMention : pinged
  if (e.sender.isBot && surface.bots.mode === 'mentions' && !addressed) {
    return pinged
      ? drop('bots.inline-mention', 'From a bot, a reply-ping is not a mention.')
      : drop('bots.mode', 'Bots are heard only when they address the agent.')
  }

  const privilege = privilegeFor(admitted)
  const isThread = e.room.kind === 'thread'
  const needsMention = isThread ? surface.threadsRequireMention : mode === 'mention'
  const rule = isThread ? 'addr.threads' : 'addr.mention'
  if (!needsMention) {
    return heard('deliver', isThread ? 'addr.threads' : 'addr.free-rooms', 'This room needs no mention.', privilege)
  }
  if (addressed) return heard('deliver', rule, 'The agent was addressed in an approved room.', privilege)
  if (surface.observeUnmentioned) {
    return heard('observe', 'addr.observe', 'Not addressed: kept as context, not answered.', privilege)
  }
  trace.push({ rule, outcome: 'fail' })
  return { verdict: 'drop', rule, why: 'This room needs a mention and there was none.', privilege, trace }
}

/** Tool classes a public agent never gets, whatever its allow list says. */
const PUBLIC_LOSES: ToolClass[] = ['shell', 'file_read', 'file_write', 'code_exec', 'chat_admin']

type Partial_ = Omit<Decision, 'policyHash'>

function decideTool(policy: PolicyRecord, e: Extract<Event, { kind: 'tool' }>, facts: Facts): Partial_ {
  const trace: Trace = []
  const surface = e.surface ? policy.surfaces[e.surface] : undefined
  // The privilege of whoever triggered the turn, from the door's own record.
  const privilege: Privilege = surface && matches(surface.admins, e.actor, facts) ? 'admin' : 'guest'
  const end = (verdict: 'allow' | 'deny', rule: string, why: string): Partial_ => {
    trace.push({ rule, outcome: verdict === 'allow' ? 'pass' : 'fail' })
    return { verdict, rule, why, privilege, trace }
  }
  if (policy.posture === 'public') {
    if (e.toolClass === 'unknown') return end('deny', 'tools.unknown', 'This tool is not classified, and this agent is public.')
    if (PUBLIC_LOSES.includes(e.toolClass)) return end('deny', 'tools.posture', `Public agents do not get ${e.toolClass} tools.`)
    trace.push({ rule: 'tools.posture', outcome: 'pass' })
  }
  if (policy.tools.deny.includes(e.toolClass)) return end('deny', 'tools.lists', `${e.toolClass} tools are on the deny list.`)
  if (!policy.tools.allow.includes(e.toolClass)) return end('deny', 'tools.lists', `${e.toolClass} tools are not on the allow list.`)
  return end('allow', 'tools.lists', `${e.toolClass} tools are allowed.`)
}

function decideModel(policy: PolicyRecord, facts: Facts): Partial_ {
  const budget = policy.budget
  const spent = facts.spentUsdThisMonth ?? 0
  const end = (verdict: 'allow' | 'deny', why: string): Partial_ => ({
    verdict, rule: 'budget.cap', why, privilege: 'guest',
    trace: [{ rule: 'budget.cap', outcome: verdict === 'allow' ? 'pass' : 'fail' }],
  })
  if (!budget) return end('allow', 'No budget is set.')
  if (spent < budget.monthlyUsd) return end('allow', 'Spend is under the monthly cap.')
  if (budget.onExceed === 'warn') return end('allow', 'Spend is over the monthly cap, and the cap is set to warn only.')
  return end('deny', 'The monthly budget is spent.')
}

function decideOutbound(policy: PolicyRecord, e: Extract<Event, { kind: 'outbound' }>, facts: Facts): Partial_ {
  const surface = policy.surfaces[e.surface]
  const end = (verdict: 'allow' | 'drop', why: string): Partial_ => ({
    verdict, rule: 'out.still-allowed', why, privilege: 'guest',
    trace: [{ rule: 'out.still-allowed', outcome: verdict === 'allow' ? 'pass' : 'fail' }],
  })
  if (!surface || !surface.enabled) return end('drop', `The ${e.surface} surface is switched off.`)
  if (facts.turnLive === false) return end('drop', 'The turn this reply belongs to is no longer live.')
  if (e.room.kind === 'dm') {
    return surface.dm.mode === 'closed'
      ? end('drop', 'Direct messages are off now.')
      : end('allow', 'Direct messages are still on.')
  }
  const mode = roomMode(surface, e.room)
  if (mode === undefined || mode === 'ignore') return end('drop', 'This room is no longer approved.')
  return end('allow', 'The room is still approved.')
}

/** Event kinds this slice has no rule for, and the rule that will cover each. */
const UNBUILT_EVENTS: Partial<Record<Event['kind'], string>> = {
  invite: 'invite.policy',
  memory: 'mem.scope',
  egress: 'sub.g1',
}

/** The answer under a record that is not valid: nothing is heard, posted, run or spent. */
function refuseAll(event: Event, problem: string): Partial_ | undefined {
  const verdict: Verdict | undefined =
    event.kind === 'inbound' || event.kind === 'outbound' ? 'drop'
      : event.kind === 'tool' || event.kind === 'model' ? 'deny'
        : undefined
  if (!verdict) return undefined
  return {
    verdict, rule: 'ctl.valid', why: `The policy record is not valid (${problem}), so nothing is allowed.`,
    privilege: 'guest', trace: [{ rule: 'ctl.valid', outcome: 'fail' }],
  }
}

/**
 * Decide what happens to one event under one policy.
 * A record with a value outside its declared set gets a plain no for every
 * event (rule `ctl.valid`): each comparison below is against a known name, so
 * an unknown one would otherwise read as the permissive case.
 * Throws UnrenderedError (fail closed) when the policy or the event asks for
 * something this slice does not enforce yet.
 */
export function decide(policy: PolicyRecord, event: Event, facts: Facts): Decision {
  const done = (d: Partial_): Decision => ({ ...d, policyHash: typeof policy?.hash === 'string' ? policy.hash : '' })
  assertRendered(policy)
  const problems = shapeErrors(policy)
  if (problems.length > 0) {
    const refused = refuseAll(event, problems[0])
    if (refused) return done(refused)
  }
  switch (event.kind) {
    case 'inbound': return done(decideInbound(policy, event, facts))
    case 'tool': return done(decideTool(policy, event, facts))
    case 'model': return done(decideModel(policy, facts))
    case 'outbound': return done(decideOutbound(policy, event, facts))
    default: throw new UnrenderedError(`event.${event.kind}`, UNBUILT_EVENTS[event.kind] ?? 'unknown')
  }
}
