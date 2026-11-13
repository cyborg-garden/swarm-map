// @vitest-environment node
//
// decide() is the last line, not validatePolicy(). If a record with a value
// it does not recognise ever reaches it, the answer is no: a message is
// dropped, a tool and a model call are denied. It must never fall through to
// the permissive branch because a comparison against a known name was false.
import { describe, expect, it } from 'vitest'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { decide } from '../decide.ts'
import type { Event, InboundEvent } from '../events.ts'
import { toPrincipal, toRoom } from '../normalise.ts'
import { withHash } from '../policy/canonical.ts'

const F = 'surfaces.fake.'
const team = (patch: Record<string, unknown> = {}) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
const say = (o: Omit<Partial<InboundEvent>, 'room' | 'sender'> & { room: string; sender: Parameters<typeof toPrincipal>[0] }): InboundEvent => ({
  kind: 'inbound', surface: 'fake', isDm: false, mention: false, inlineMention: false, replyToAgent: false,
  text: 'hi', attachments: [], ...o, room: toRoom(o.room), sender: toPrincipal(o.sender),
})
const shell: Event = {
  kind: 'tool', surface: 'fake', room: toRoom('r-general'), actor: toPrincipal('u-alice'),
  toolClass: 'shell', toolName: 'bash', argsDigest: '',
}

describe('decide() fails closed on a value it does not recognise', () => {
  it('positive controls: the same events under the valid record', () => {
    expect(decide(team(), shell, {}).verdict).toBe('allow')
    expect(decide(team(), say({ room: 'r-general', sender: 'u-alice', mention: true }), {}).verdict).toBe('deliver')
    expect(decide(team(), { kind: 'model', provider: 'p', model: 'm' }, {}).verdict).toBe('allow')
  })

  it("[U:fail-closed] posture 'Public' does not hand out a shell", () => {
    const d = decide(team({ posture: 'Public' }), shell, {})
    expect(d).toMatchObject({ verdict: 'deny', rule: 'ctl.valid' })
  })

  it("[U:fail-closed] room mode 'Mention' does not become a free room", () => {
    const p = team({ [F + 'rooms']: [{ match: { room: 'r-general' }, mode: 'Mention' }] })
    expect(decide(p, say({ room: 'r-general', sender: 'u-alice' }), {})).toMatchObject({ verdict: 'drop', rule: 'ctl.valid' })
  })

  it("[U:fail-closed] room mode 'Ignore' does not let the room be heard", () => {
    const p = team({ [F + 'rooms']: [{ match: { room: 'r-general' }, mode: 'free' }, { match: { room: 'r-general' }, mode: 'Ignore' }] })
    expect(decide(p, say({ room: 'r-general', sender: 'u-alice', mention: true }), {})).toMatchObject({ verdict: 'drop', rule: 'ctl.valid' })
  })

  it("[U:fail-closed] bots.mode 'off' does not hear every bot", () => {
    const p = team({ [F + 'bots.mode']: 'off' })
    const bot = say({ room: 'r-lounge', sender: { id: 'b-1', isBot: true } })
    expect(decide(p, bot, {})).toMatchObject({ verdict: 'drop', rule: 'ctl.valid' })
  })

  it('[U:fail-closed] a truthy string is not a yes', () => {
    const p = team({ [F + 'anyoneInAllowedRoom']: 'false' })
    expect(decide(p, say({ room: 'r-lounge', sender: 'u-stranger' }), {})).toMatchObject({ verdict: 'drop', rule: 'ctl.valid' })
  })

  it('[U:fail-closed] an outbound post and a model call are refused too, and the reason names the field', () => {
    const p = team({ posture: 'Public' })
    expect(decide(p, { kind: 'outbound', surface: 'fake', room: toRoom('r-general'), text: 'x' }, { turnLive: true }))
      .toMatchObject({ verdict: 'drop', rule: 'ctl.valid' })
    const d = decide(p, { kind: 'model', provider: 'p', model: 'm' }, {})
    expect(d).toMatchObject({ verdict: 'deny', rule: 'ctl.valid', privilege: 'guest' })
    expect(d.why).toContain('posture')
  })
})
