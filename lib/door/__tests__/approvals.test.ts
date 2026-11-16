// @vitest-environment node
//
// P: a tool in ask mode. The door holds the call, shows it in the room, and
// lets it run only on an admin's yes to that exact call. Fake connector and
// echo shim: no Docker, no model, no network.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import type { PolicyRecord } from '../../core/policy/types.ts'
import { callHash, MAX_SHOWN_CHARS, readShown } from '../../core/tools/call.ts'
import { MAX_REQUEST_CHARS, readAnswer, readReaction, requestText, shownIn } from '../approvals.ts'
import type { DoorOptions } from '../door.ts'
import { startRig, type Rig } from '../testing/rig.ts'

armTripwire()

const F = 'surfaces.fake.'
// The fixture's one admin is u-root. u-alice is heard and is not an admin.
const ASK = { 'tools.allow': ['file_read'], 'tools.ask': ['shell'] }
const team = (patch: Record<string, unknown> = {}): PolicyRecord =>
  withHash(applyPatch(loadFixturePolicy('policy-team.json'), { ...ASK, ...patch }))

let rig: Rig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const start = async (patch: Record<string, unknown> = {}, door: Partial<DoorOptions> = {}): Promise<Rig> => {
  rig = await startRig(team(patch), { shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 4000, door: { approvalTimeoutMs: 3000, ...door } })
  return rig
}
const ask = (r: Rig, text: string, room = 'r-general'): string => r.fake.say({ room, sender: 'u-alice', mention: true, text })
const requests = (r: Rig) => r.fake.ledger.filter((p) => p.text.startsWith('Approval needed.'))
/** Wait for the door's nth request to be posted, and hand it back. */
async function request(r: Rig, n = 1) {
  await expect.poll(() => requests(r).length, { timeout: 2000 }).toBeGreaterThanOrEqual(n)
  return requests(r)[n - 1]
}
const reply = (r: Rig, to: string, text: string, sender: Parameters<Rig['fake']['say']>[0]['sender'] = 'u-root', room = 'r-general'): string =>
  r.fake.say({ room, sender, text, replyTo: to })
const trail = (r: Rig): string[] => r.receipts.all().filter((x) => x.event.kind === 'tool' || x.event.kind === 'approval').map((x) => `${x.event.kind}:${x.verdict}/${x.rule}`)

describe('door: a tool in ask mode', () => {
  it('[P:approval] is held until an admin replies approve, then runs with a yes that names the call', async () => {
    const r = await start()
    ask(r, 'please !tool bash=ls')
    const req = await request(r)
    await sleep(60)
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts).toEqual([])
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan.map((t) => t.tool)).toEqual(['bash'])
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: true, hash: callHash('bash', { command: 'ls' }) }])
    // The request, then the harness's own reply. Nothing else was posted.
    expect(r.fake.ledger.map((p) => p.text.split('\n')[0])).toEqual(['Approval needed. The agent wants to run bash:', 'echo: please !tool bash=ls'])
  })

  it.each([
    ['a reply that says yes', (r: Rig, id: string) => { reply(r, id, 'Yes') }, true],
    ['a reply that starts with a mention', (r: Rig, id: string) => { reply(r, id, '<@123456789012345678> approve') }, true],
    ['a tick put on the request', (r: Rig, id: string) => { r.fake.react({ room: 'r-general', sender: 'u-root', messageId: id, emoji: '✅' }) }, true],
    ['a reply that says deny', (r: Rig, id: string) => { reply(r, id, 'deny') }, false],
    ['a reply that says no', (r: Rig, id: string) => { reply(r, id, ' NO ') }, false],
    ['a cross put on the request', (r: Rig, id: string) => { r.fake.react({ room: 'r-general', sender: 'u-root', messageId: id, emoji: '❌' }) }, false],
  ])('[P:approval] an admin can answer with %s', async (_how, answer, runs) => {
    const r = await start()
    ask(r, '!tool bash=ls')
    answer(r, (await request(r)).id)
    await r.door.idle()
    expect(r.shim.toolsRan.length).toBe(runs ? 1 : 0)
    expect(r.shim.verdicts[0]).toMatchObject(runs ? { allow: true } : { allow: false, reason: 'An admin said no, so the call does not run.' })
  })

  it('[P:approval] a class on the allow list is not asked about, and a class on both lists is', async () => {
    const r = await start({ 'tools.allow': ['file_read', 'shell'] })
    ask(r, '!tool read=x and !tool bash=ls')
    const req = await request(r)
    expect(r.shim.verdicts).toEqual([{ tool: 'read', allow: true, hash: callHash('read', { command: 'x' }) }])
    reply(r, req.id, 'deny')
    await r.door.idle()
    expect(requests(r)).toHaveLength(1)
  })

  it('[P:approval] a tool that would have to wait is only offered to a harness that can hold a call, and is refused if it asks anyway', async () => {
    rig = await startRig(team(), { verdictTimeoutMs: 2000 })
    ask(rig, '!tool bash=ls')
    await rig.door.idle()
    expect(rig.shim.heard[0].tools).toEqual(['read'])
    expect(rig.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'This harness cannot hold a call while an admin answers.' }])
    expect(requests(rig)).toEqual([])
    await rig.close()
    const r = await start()
    ask(r, 'nothing to run')
    await r.door.idle()
    expect(r.shim.heard[0].tools.sort()).toEqual(['bash', 'read'])
  })

  it('[P:approval] with nobody on the admin list, or only a role on it, the call is refused at once and nothing is posted', async () => {
    for (const admins of [[], [{ kind: 'role', id: 'role-staff' }]]) {
      const r = await start({ [F + 'admins']: admins })
      ask(r, '!tool bash=ls')
      await r.door.idle()
      expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'Nobody is on the admin list, so nobody could say yes.' }])
      expect(requests(r)).toEqual([])
      await r.close()
    }
    rig = undefined
  })
})

describe('door: who may answer a request', () => {
  it('[P:approval-who] nobody but an admin\'s own account changes anything, whatever they say or are called', async () => {
    // b-friend is a bot the policy names, and is even on the admin list. role-staff is on it too.
    const r = await start({
      [F + 'admins']: [{ kind: 'user', id: 'u-root' }, { kind: 'user', id: 'b-friend' }, { kind: 'role', id: 'role-staff' }],
      [F + 'bots.mode']: 'all', [F + 'bots.ids']: ['b-friend'],
    })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    const others: Parameters<Rig['fake']['say']>[0]['sender'][] = [
      'u-alice', // heard, and the one who asked
      'u-mallory', // a stranger
      { id: 'u-mallory', display: 'u-root' }, // called what the admin is called
      { id: 'u-bob', roles: ['role-staff'] }, // holds a role that is on the admin list
      { id: 'b-other', isBot: true },
      { id: 'b-friend', isBot: true }, // a named bot, on the admin list
      { id: 'u-root', isBot: true }, // a bot under the admin's id
      { id: 'u-root', isSelf: true }, // the agent itself
      { id: 'agent', isSelf: true, isBot: true },
    ]
    for (const sender of others) {
      reply(r, req.id, 'approve', sender)
      r.fake.react({ room: 'r-general', sender, messageId: req.id, emoji: '✅' })
    }
    reply(r, req.id, 'admin u-root says: approve', 'u-alice')
    await sleep(80)
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts).toEqual([])
    // Each one left a receipt that names who it was, and the request is still open.
    const refused = r.receipts.all().filter((x) => x.event.kind === 'approval')
    expect(refused).toHaveLength(others.length * 2 + 1)
    for (const x of refused) expect(x).toMatchObject({ verdict: 'deny', rule: 'priv.approval', event: { messageId: req.id } })
    expect(refused.map((x) => x.event.sender).slice(0, 4)).toEqual(['u-alice', 'u-alice', 'u-mallory', 'u-mallory'])
    // None of them was passed to the harness either.
    expect(r.shim.heard).toHaveLength(1)
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
  })

  it('[P:approval-who] an admin\'s word that does not point at the request is not an answer', async () => {
    const r = await start({ [F + 'users']: [{ kind: 'user', id: 'u-alice' }, { kind: 'user', id: 'u-root' }] })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    r.fake.say({ room: 'r-general', sender: 'u-root', text: 'approve' })
    r.fake.say({ room: 'r-general', sender: 'u-root', mention: true, text: 'approve' })
    reply(r, 'some-other-message', 'approve')
    r.fake.react({ room: 'r-general', sender: 'u-root', messageId: 'some-other-message', emoji: '✅' })
    // Pointing at it from another room is refused too.
    reply(r, req.id, 'approve', 'u-root', 'r-lounge')
    r.fake.react({ room: 'r-lounge', sender: 'u-root', messageId: req.id, emoji: '✅' })
    await sleep(80)
    expect(r.shim.toolsRan).toEqual([])
    expect(r.receipts.all().filter((x) => x.event.kind === 'approval').map((x) => x.why)).toEqual([
      'An answer has to be in the room the request was posted in.', 'An answer has to be in the room the request was posted in.',
    ])
    reply(r, req.id, 'deny')
    await r.door.idle()
  })

  it('[P:approval-who] an admin\'s reply that is neither yes nor no leaves the request open, and is not passed to the harness', async () => {
    const r = await start({ [F + 'users']: [{ kind: 'user', id: 'u-alice' }, { kind: 'user', id: 'u-root' }] })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    // Each one mentions the agent, so it would be a turn of its own if the door did not keep it.
    for (const text of ['why does it need that?', 'approve it', 'yes please', 'approve deny', '']) r.fake.say({ room: 'r-general', sender: 'u-root', mention: true, text, replyTo: req.id })
    r.fake.react({ room: 'r-general', sender: 'u-root', messageId: req.id, emoji: '👍' })
    await sleep(80)
    expect(r.shim.verdicts).toEqual([])
    expect(r.shim.heard).toHaveLength(1)
    expect(r.receipts.all().filter((x) => x.why === 'That is not an answer. The request is still open.')).toHaveLength(6)
    // The yes itself is kept from the harness too: it was for the door.
    r.fake.say({ room: 'r-general', sender: 'u-root', mention: true, text: 'approve', replyTo: req.id })
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
    expect(r.shim.heard).toHaveLength(1)
  })

  it('[P:approval-who] an admin taken off the list while the call waits can no longer say yes', async () => {
    const r = await start()
    ask(r, '!tool bash=ls')
    const req = await request(r)
    r.door.setPolicy(team({ version: 2, [F + 'admins']: [{ kind: 'user', id: 'u-carol' }] }))
    reply(r, req.id, 'approve')
    await sleep(60)
    expect(r.shim.verdicts).toEqual([])
    reply(r, req.id, 'approve', 'u-carol')
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
  })
})

describe('door: a yes is for one call, once', () => {
  it('[P:approval-once] the same call asked again needs its own yes, and answering the first request again does nothing', async () => {
    const r = await start({}, { approvalTimeoutMs: 400 })
    ask(r, '!tool bash=ls then !tool bash=ls')
    const first = await request(r)
    reply(r, first.id, 'approve')
    const second = await request(r, 2)
    expect(second.id).not.toBe(first.id)
    expect(shownIn(second.text)).toEqual(shownIn(first.text))
    // The first request is closed. A yes on it, by reply or by reaction, is not a yes to the second call.
    reply(r, first.id, 'approve')
    r.fake.react({ room: 'r-general', sender: 'u-root', messageId: first.id, emoji: '✅' })
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
    expect(r.shim.verdicts.map((v) => v.allow)).toEqual([true, false])
    expect(r.shim.verdicts[1].reason).toBe('No admin answered in time, so the call does not run.')
  })

  it('[P:approval-once] with two calls waiting, a yes to one runs that one only, and each yes names its own call', async () => {
    const r = await start()
    ask(r, '!tool bash=one')
    ask(r, '!tool bash=two', 'r-lounge')
    await request(r, 2)
    const [one, two] = ['one', 'two'].map((word) => requests(r).find((p) => p.text.includes(`"${word}"`))!)
    reply(r, two.id, 'approve', 'u-root', 'r-lounge')
    await expect.poll(() => r.shim.verdicts.length).toBe(1)
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: true, hash: callHash('bash', { command: 'two' }) }])
    reply(r, one.id, 'deny')
    await r.door.idle()
    expect(r.shim.verdicts.map((v) => v.allow)).toEqual([true, false])
  })

  it('[P:approval-once] a second answer to a request that was refused does not turn the no into a yes', async () => {
    const r = await start({}, { turnDeadlineMs: 300 })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    reply(r, req.id, 'deny')
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts).toHaveLength(1)
  })
})

describe('door: what a request shows', () => {
  it('[P:approval-shown] the request shows the whole call, and the yes carries the hash of exactly what was shown', async () => {
    const r = await start()
    ask(r, '!tool bash=rm$IFS-rf$IFS"/tmp/x"')
    const req = await request(r)
    const { shown, call } = shownIn(req.text)!
    expect(readShown(shown)).toEqual({ command: 'rm$IFS-rf$IFS"/tmp/x"' })
    expect(callHash('bash', readShown(shown)).slice(0, 12)).toBe(call)
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.verdicts[0].hash).toBe(callHash('bash', readShown(shown)))
  })

  it('[P:approval-shown] a request says plainly that a yes reaches past the call: what it leaves in the cell stays', async () => {
    const r = await start()
    ask(r, '!tool bash=ls')
    const req = await request(r)
    const last = req.text.split('\n').at(-1)!
    expect(last).toContain('Whatever it starts or changes in the agent\'s cell stays until the agent is stopped.')
    // It sits on the line the call's short hash ends, so a request still reads back the same way.
    expect(shownIn(req.text)).toBeDefined()
    reply(r, req.id, 'deny')
    await r.door.idle()
  })

  it('[P:approval-shown] nothing in a request can ping anyone, hide a character or break out of its block', async () => {
    const r = await start()
    ask(r, '!tool bash=@everyone<@123456789012345678>```‮​<#1>')
    const req = await request(r)
    expect(req.text).not.toMatch(/@|<|‮|​/)
    expect(req.text.match(/```/g)).toHaveLength(2)
    expect(readShown(shownIn(req.text)!.shown)).toEqual({ command: '@everyone<@123456789012345678>```‮​<#1>' })
    reply(r, req.id, 'deny')
    await r.door.idle()
  })

  it('[P:approval-shown] a call too long to show whole is refused, never cut and then approved', async () => {
    const r = await start()
    ask(r, `!tool bash=${'x'.repeat(MAX_SHOWN_CHARS)}`)
    await r.door.idle()
    expect(requests(r)).toEqual([])
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'It cannot be shown for approval: the call is too long to show in full.' }])
    // The longest call that is shown still fits in one message.
    expect(requestText('x'.repeat(64), 'y'.repeat(MAX_SHOWN_CHARS), 'f'.repeat(64), 600_000).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS)
  })

  it('[P:approval-shown] a call with something secret-shaped in it is refused rather than shown with a part blanked out', async () => {
    const secret = 'ghp_' + 'q7W3'.repeat(9) // minted here so none is ever committed
    // The secret comes from the harness's side, as one read in the cell would: the door scrubs what a person pastes before any harness sees it.
    rig = await startRig(team(), { mode: 'never-settle', shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 4000 })
    const r = rig
    ask(r, 'hello')
    await expect.poll(() => r.shim.heard.length).toBe(1)
    const turnId = r.shim.heard[0].turnId
    expect(await r.shim.client.requestTool(turnId, 'bash', { command: `curl -H ${secret}` }))
      .toEqual({ allow: false, reason: 'The call holds something secret-shaped, so it is not shown and does not run.' })
    expect(requests(r)).toEqual([])
    expect(JSON.stringify(r.receipts.all())).not.toContain(secret)
    // Positive control: the same call without the secret is shown.
    void r.shim.client.requestTool(turnId, 'bash', { command: 'curl -H x' })
    await request(r)
  })

  it('[P:approval-shown] a request that cannot be posted is a no', async () => {
    const r = await start()
    r.fake.connector.send = async () => { throw new Error('the room is gone') }
    ask(r, '!tool bash=ls')
    await expect.poll(() => r.shim.verdicts.length).toBe(1)
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'The request could not be posted, so the call does not run.' }])
  })

  it('[U:approval-words] only one plain word, or one of two marks, is read as an answer', () => {
    for (const yes of ['approve', 'Approve', ' YES ', '<@1234567890> approve', '<@!1234567890>  yes']) expect(readAnswer(yes), yes).toBe('approve')
    for (const no of ['deny', 'No', ' no\n']) expect(readAnswer(no), no).toBe('deny')
    for (const neither of ['', 'approved', 'yes!', 'y', 'ok', 'approve deny', 'do not approve', 'approve\nrm -rf', 'xapprove', '<@abc> approve']) expect(readAnswer(neither), neither).toBeUndefined()
    expect(readReaction('✅')).toBe('approve')
    expect(readReaction('❌')).toBe('deny')
    for (const neither of ['👍', '✔️', 'white_check_mark', '', '✅✅']) expect(readReaction(neither), neither).toBeUndefined()
  })
})

describe('door: no answer, and answers that come too late', () => {
  it('[P:approval-timeout] no answer in time is a no, and a yes after that does nothing', async () => {
    const r = await start({}, { approvalTimeoutMs: 120 })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    await r.door.idle()
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'No admin answered in time, so the call does not run.' }])
    reply(r, req.id, 'approve')
    await sleep(60)
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts).toHaveLength(1)
  })

  it('[P:approval-timeout] the turn\'s own clock stops while a person is asked, and starts again after', async () => {
    // The turn has 150 ms. The admin takes 400 ms. The call still runs and the reply is still posted.
    const r = await start({}, { turnDeadlineMs: 150, approvalTimeoutMs: 2000 })
    ask(r, '!tool bash=ls')
    const req = await request(r)
    await sleep(400)
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
    expect(r.fake.ledger.at(-1)?.text).toBe('echo: !tool bash=ls')
    expect(r.receipts.all().some((x) => x.why === 'The harness did not finish the turn in time.')).toBe(false)
  })

  it('[P:approval-timeout] after the answer the turn is on the clock again: a harness that then never finishes is given up on', async () => {
    rig = await startRig(team(), { mode: 'never-settle', shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 4000, door: { turnDeadlineMs: 150, approvalTimeoutMs: 2000 } })
    const r = rig
    ask(r, '!tool bash=ls')
    reply(r, (await request(r)).id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toHaveLength(1)
    expect(r.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', why: 'The harness did not finish the turn in time.' })
  }, 3000)

  it('[P:approval-timeout] positive control: the same turn with nobody asked is given up on at its deadline', async () => {
    rig = await startRig(team(), { mode: 'never-settle', door: { turnDeadlineMs: 150 } })
    ask(rig, 'no tools here')
    await rig.door.idle()
    expect(rig.receipts.all().some((x) => x.why === 'The harness did not finish the turn in time.')).toBe(true)
  })
})

describe('door: a yes is checked again when it lands', () => {
  it('[P:approval-recheck] rules that changed to no while the call waited win over the yes', async () => {
    const r = await start()
    ask(r, '!tool bash=ls')
    const req = await request(r)
    r.door.setPolicy(team({ version: 2, 'tools.ask': [] }))
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toEqual([])
    expect(r.shim.verdicts[0]).toEqual({ tool: 'bash', allow: false, reason: 'The rules changed while the call waited: shell tools are not on the allow list.' })
    expect(trail(r).at(-1)).toBe('tool:deny/tools.lists')
  })

  it('[P:approval-recheck] an agent made public while the call waited does not run it', async () => {
    const r = await start()
    ask(r, '!tool bash=ls')
    const req = await request(r)
    r.door.setPolicy(team({ version: 2, posture: 'public' }))
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.shim.toolsRan).toEqual([])
    expect(trail(r).at(-1)).toBe('tool:deny/tools.posture')
  })

  it('[P:approval-recheck] a turn that ended while the call waited does not run it, and its request can no longer be answered', async () => {
    const r = await start()
    const id = ask(r, '!tool bash=ls')
    const req = await request(r)
    r.fake.notice('delete', id, 'r-general')
    await expect.poll(() => r.shim.verdicts.length).toBe(1)
    expect(r.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'the turn is over' }])
    reply(r, req.id, 'approve')
    await sleep(60)
    expect(r.shim.toolsRan).toEqual([])
    expect(r.receipts.all().filter((x) => x.event.kind === 'approval')).toEqual([])
    expect(trail(r)).toEqual(['tool:ask/priv.approval', 'tool:deny/turn.known'])
  })

  it('[P:approval-recheck] a harness that says its turn is finished while a call of it waits gets a no for that call, and a yes after that does nothing', async () => {
    rig = await startRig(team(), { mode: 'never-settle', shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 4000 })
    const r = rig
    ask(r, 'hello')
    await expect.poll(() => r.shim.heard.length).toBe(1)
    const turnId = r.shim.heard[0].turnId
    const pending = r.shim.client.requestTool(turnId, 'bash', { command: 'ls' })
    const req = await request(r)
    r.shim.client.send({ t: 'settled', turnId })
    expect(await pending).toEqual({ allow: false, reason: 'the turn is over' })
    reply(r, req.id, 'approve')
    await r.door.idle()
    expect(r.receipts.all().filter((x) => x.event.kind === 'approval')).toEqual([])
    expect(trail(r)).toEqual(['tool:ask/priv.approval', 'tool:deny/turn.known'])
  })
})

describe('door: receipts for an approval', () => {
  it('[P:approval-receipts] every step leaves a receipt, with the call\'s hash and never its text', async () => {
    const r = await start()
    const canary = 'CANARY-in-a-command'
    const id = ask(r, `!tool bash=${canary}`)
    const req = await request(r)
    reply(r, req.id, 'approve', 'u-alice')
    reply(r, req.id, 'approve')
    await r.door.idle()
    const call = callHash('bash', { command: canary }).slice(0, 12)
    const steps = r.receipts.all().filter((x) => x.event.kind === 'tool' || x.event.kind === 'approval')
    expect(steps.map((x) => `${x.event.kind}:${x.verdict}/${x.rule} ${x.event.sender} ${x.note}`)).toEqual([
      `tool:ask/priv.approval u-alice tool=bash call=${call} request=${req.id}`,
      `approval:deny/priv.approval u-alice tool=bash call=${call}`,
      `approval:allow/priv.approval u-root answer=approve tool=bash call=${call}`,
      `tool:allow/priv.approval u-alice tool=bash call=${call}`,
    ])
    expect(steps.map((x) => x.why)).toEqual([
      'shell tools need an admin\'s yes in the room.', 'Only an admin can answer a request to run a tool.',
      'An admin answered.', 'An admin said yes, so the call runs.',
    ])
    // The asking and the running are tied to the message that started the turn; the answers to the request.
    expect(steps.map((x) => x.event.messageId)).toEqual([id, req.id, req.id, id])
    expect(JSON.stringify(r.receipts.all())).not.toContain(canary)
  })

  it('[P:approval-receipts] a no and a timeout each leave their own', async () => {
    const r = await start({}, { approvalTimeoutMs: 100 })
    ask(r, '!tool bash=one')
    reply(r, (await request(r)).id, 'deny')
    await r.door.idle()
    ask(r, '!tool bash=two')
    await request(r, 2)
    await r.door.idle()
    expect(trail(r)).toEqual([
      'tool:ask/priv.approval', 'approval:allow/priv.approval', 'tool:deny/priv.approval',
      'tool:ask/priv.approval', 'tool:deny/priv.approval',
    ])
    expect(r.receipts.all().filter((x) => x.event.kind === 'tool' && x.verdict === 'deny').map((x) => x.why)).toEqual([
      'An admin said no, so the call does not run.', 'No admin answered in time, so the call does not run.',
    ])
  })
})

describe('door: tool calls per conversation', () => {
  it('[P:tool-limit] past the limit a call is refused, a refused call costs nothing, and another conversation has its own count', async () => {
    rig = await startRig(team({ 'tools.allow': ['shell'], 'tools.ask': [] }), { door: { toolCallsPerHour: 2 } })
    ask(rig, '!tool read=a !tool bash=1 !tool read=b !tool bash=2 !tool bash=3')
    await rig.door.idle()
    expect(rig.shim.verdicts.map((v) => `${v.tool}:${v.allow}`)).toEqual(['read:false', 'bash:true', 'read:false', 'bash:true', 'bash:false'])
    expect(rig.shim.verdicts[4].reason).toBe('This conversation has made as many tool calls as it may in an hour.')
    expect(rig.receipts.all().filter((x) => x.rule === 'tools.limits').map((x) => `${x.verdict} ${x.event.room}`)).toEqual(['deny r-general'])
    ask(rig, '!tool bash=4')
    ask(rig, '!tool bash=5', 'r-lounge')
    await rig.door.idle()
    expect(rig.shim.verdicts.slice(5).map((v) => v.allow).sort()).toEqual([false, true])
    expect(rig.shim.toolsRan).toHaveLength(3)
  })

  it('[P:tool-limit] a call that waits for an admin counts when it is asked about, whatever the answer', async () => {
    const r = await start({}, { toolCallsPerHour: 1 })
    ask(r, '!tool bash=1 !tool bash=2')
    reply(r, (await request(r)).id, 'deny')
    await r.door.idle()
    expect(requests(r)).toHaveLength(1)
    expect(r.shim.verdicts.map((v) => v.reason)).toEqual(['An admin said no, so the call does not run.', 'This conversation has made as many tool calls as it may in an hour.'])
  })
})
