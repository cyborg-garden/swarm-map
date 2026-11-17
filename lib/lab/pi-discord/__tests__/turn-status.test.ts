// @vitest-environment node
//
// A sign that the agent is working: 👀 on the message it is handling, Discord's
// typing indicator while the turn runs, then ✅ when the reply is posted or ⚠️
// when there is none. Run end to end with the launcher's own policy, the real
// Discord connector and the door, against a fake Discord on loopback. No Docker,
// no model, no network: the tripwire is armed and must record nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../../conformance/guards/tripwire.ts'
import { STATUS_EMOJI } from '../../../door/turn-status.ts'
import { IDS, startDiscordRig, type DiscordRig } from '../../../door/testing/discord-rig.ts'
import type { EchoMode } from '../../../door/testing/echo-shim.ts'
import type { StatusCall } from '../../../door/testing/fake-discord.ts'
import { parseConfig, policyFor, statusOf, type LabConfig } from '../config.ts'

armTripwire()

const EVERY_MS = 40
const raw = (discord: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  agentId: 'pi-lab',
  discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member], allowedBotIds: [IDS.bot], ...discord },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 2 },
  ...extra,
})
const config = (discord: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): LabConfig => {
  const { config: c, errors } = parseConfig(raw(discord, extra))
  expect(errors).toEqual([])
  return c as LabConfig
}

let rig: DiscordRig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

/** A rig whose door shows status the way the launcher would start it from this config. */
async function start(c: LabConfig = config(), o: { mode?: EchoMode; door?: Record<string, unknown>; shimCaps?: Record<string, unknown>; connector?: Record<string, unknown> } = {}): Promise<DiscordRig> {
  rig = await startDiscordRig(policyFor(c), {
    mode: o.mode, shimCaps: o.shimCaps,
    connector: { maxStatusWaitMs: 200, ...o.connector },
    door: { status: { ...statusOf(c), typingEveryMs: EVERY_MS }, ...o.door },
  })
  return rig
}
function say(r: DiscordRig, s: { text: string; channel?: string; author?: string; bot?: boolean; mention?: boolean }): string {
  const pinged = s.mention ?? true
  return r.fake.post({
    channel: s.channel ?? IDS.home, guild: IDS.guild, author: { id: s.author ?? IDS.member, bot: s.bot },
    content: pinged ? `<@${r.fake.selfId}> ${s.text}` : s.text, mentions: pinged ? [r.fake.selfId] : [],
  })
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const reactionsTo = (r: DiscordRig, id: string): string[] =>
  r.fake.status.filter((c): c is Extract<StatusCall, { what: 'reaction' }> => c.what === 'reaction' && c.messageId === id).map((c) => `${c.on ? '+' : '-'}${c.emoji}`)
const typings = (r: DiscordRig): StatusCall[] => r.fake.status.filter((c) => c.what === 'typing')
const statusReceipts = (r: DiscordRig) => r.receipts.all().filter((x) => x.rule === 'out.status')
/** Wait until the turn's last reaction is in place: the door does not wait for it, so neither can idle(). */
const finalReaction = async (r: DiscordRig, id: string, emoji: string): Promise<void> => {
  await expect.poll(() => r.fake.reactionsOn(id), { timeout: 3000 }).toEqual([emoji])
}

describe('turn status: the rules record', () => {
  it('both are on by default, each can be switched off, and anything but true or false is refused', () => {
    expect(statusOf(config())).toEqual({ reactions: true, typing: true })
    expect(statusOf(config({ statusReactions: false }))).toEqual({ reactions: false, typing: true })
    expect(statusOf(config({ typing: false }))).toEqual({ reactions: true, typing: false })
    expect(parseConfig(raw({ statusReactions: 'yes', typing: 1 })).errors).toEqual([
      'discord.statusReactions: must be true or false', 'discord.typing: must be true or false',
    ])
  })

  it('a config that never named them is written as it always was, and neither changes the policy', () => {
    expect(Object.keys(config().discord)).not.toContain('statusReactions')
    expect(Object.keys(config().discord)).not.toContain('typing')
    // They change how a turn looks, not who is heard or what is allowed: the policy, and its hash, are the same.
    expect(policyFor(config({ statusReactions: false, typing: false })).hash).toBe(policyFor(config()).hash)
  })
})

describe('turn status: a message the agent is handling', () => {
  it('[P:turn-status] 👀 and typing while it works, then ✅ in place of 👀 once the reply is posted', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    const id = say(r, { text: 'look this up' })
    await expect.poll(() => r.shim.heard.length).toBe(1)
    await expect.poll(() => r.fake.reactionsOn(id)).toEqual([STATUS_EMOJI.working])
    await expect.poll(() => typings(r).length).toBeGreaterThanOrEqual(1)
    expect(typings(r).every((c) => c.channel === IDS.home)).toBe(true)
    // The reply comes later, as a slow model's would.
    r.shim.client.send({ t: 'reply', turnId: r.shim.heard[0].turnId, text: 'found it', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await r.posts(1)
    await finalReaction(r, id, STATUS_EMOJI.done)
    expect(reactionsTo(r, id)).toEqual(['+👀', '+✅', '-👀'])
    expect(statusReceipts(r)).toEqual([])
  })

  it('[P:turn-status] typing is sent again about every interval while the turn runs, and never after it ends', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    say(r, { text: 'take your time' })
    await expect.poll(() => r.shim.heard.length).toBe(1)
    await expect.poll(() => typings(r).length, { timeout: 2000 }).toBeGreaterThanOrEqual(4)
    r.shim.client.send({ t: 'reply', turnId: r.shim.heard[0].turnId, text: 'done', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await r.posts(1)
    const after = typings(r).length
    await sleep(EVERY_MS * 5)
    expect(typings(r).length).toBe(after)
    // Renewed on the interval, not in a burst.
    const at = typings(r).map((c) => c.at)
    expect(at[3] - at[0]).toBeGreaterThanOrEqual(EVERY_MS * 2)
  })

  it('[P:turn-status] a turn with no answer gets ⚠️: a model call that failed, an error, and no reply', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    const failed = say(r, { text: 'one' })
    await expect.poll(() => r.shim.heard.length).toBe(1)
    r.door.modelFailed({ rule: 'model.provider', why: 'The model provider refused the call (status 400).' })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await finalReaction(r, failed, STATUS_EMOJI.failed)
    const errored = say(r, { text: 'two' })
    await expect.poll(() => r.shim.heard.length).toBe(2)
    r.shim.client.send({ t: 'error', turnId: r.shim.heard[1].turnId, message: 'boom' })
    await finalReaction(r, errored, STATUS_EMOJI.failed)
    expect(reactionsTo(r, failed)).toEqual(['+👀', '+⚠️', '-👀'])
    const after = typings(r).length
    await sleep(EVERY_MS * 4)
    expect(typings(r).length).toBe(after)
  })

  it('[P:turn-status] a reply the door refuses after the message was delivered gets ⚠️, not ✅', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    const id = say(r, { text: 'hello' })
    await expect.poll(() => r.shim.heard.length).toBe(1)
    // The member is taken off the list mid-turn: the reply is not posted.
    r.door.setPolicy(policyFor(config({ allowedUserIds: [] })))
    r.shim.client.send({ t: 'reply', turnId: r.shim.heard[0].turnId, text: 'hi', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await finalReaction(r, id, STATUS_EMOJI.failed)
    expect(r.fake.posted).toEqual([])
  })

  it('[P:turn-status] a turn that runs out of time gets ⚠️, and typing stops', async () => {
    const r = await start(config(), { mode: 'silent-later', door: { turnDeadlineMs: 150 } })
    const id = say(r, { text: 'slow' })
    await finalReaction(r, id, STATUS_EMOJI.failed)
    const after = typings(r).length
    await sleep(EVERY_MS * 4)
    expect(typings(r).length).toBe(after)
  })

  it('[P:turn-status] a message deleted mid-turn: typing stops, and nothing more is put on a message that is gone', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    const id = say(r, { text: 'never mind' })
    await expect.poll(() => r.fake.reactionsOn(id)).toEqual([STATUS_EMOJI.working])
    r.fake.remove(id, IDS.home)
    await r.settle()
    const after = typings(r).length
    await sleep(EVERY_MS * 4)
    expect(typings(r).length).toBe(after)
    expect(reactionsTo(r, id)).toEqual(['+👀'])
  })

  it('[P:turn-status] shutting the door down stops typing: no timer outlives it', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    say(r, { text: 'still going' })
    await expect.poll(() => typings(r).length).toBeGreaterThanOrEqual(1)
    await r.door.close()
    const after = typings(r).length
    await sleep(EVERY_MS * 4)
    expect(typings(r).length).toBe(after)
  })
})

describe('turn status: never on a message the agent is not handling', () => {
  it('[P:turn-status] chatter with no mention, a stranger, an unnamed bot and another channel get nothing', async () => {
    const r = await start()
    say(r, { text: 'just talking', mention: false })
    say(r, { text: 'let me in', author: IDS.stranger })
    say(r, { text: 'beep', author: '8900000000000000009', bot: true })
    say(r, { text: 'over here', channel: IDS.other })
    // A message it does handle, last, so the others have been decided by the time it is answered.
    const heard = say(r, { text: 'and me' })
    await r.posts(1)
    await finalReaction(r, heard, STATUS_EMOJI.done)
    expect(r.fake.status.filter((c) => c.what === 'reaction' && c.messageId !== heard)).toEqual([])
    expect(r.fake.status.every((c) => c.channel === IDS.home)).toBe(true)
    // Not even an attempt: the REST log has reactions on one message only, and nothing in the other channel.
    expect(r.fake.requests.filter((q) => q.includes('/reactions/') && !q.includes(`/messages/${heard}/`))).toEqual([])
    expect(r.fake.requests.filter((q) => q.includes(IDS.other))).toEqual([])
  })

  it('[P:turn-status] positive control: the same messages from a listed person, mentioning the bot, are handled and marked', async () => {
    const r = await start()
    const ids = [say(r, { text: 'one' }), say(r, { text: 'two' })]
    await r.posts(2)
    for (const id of ids) await finalReaction(r, id, STATUS_EMOJI.done)
  })

  it('switched off, nothing is sent: no reaction, no typing', async () => {
    const r = await start(config({ statusReactions: false, typing: false }))
    say(r, { text: 'quiet please' })
    await r.posts(1)
    await sleep(EVERY_MS * 3)
    expect(r.fake.status).toEqual([])
    expect(r.fake.requests.filter((q) => q.includes('/reactions/') || q.endsWith('/typing'))).toEqual([])
  })

  it('each switch is its own: reactions without typing, typing without reactions', async () => {
    const r = await start(config({ typing: false }), { mode: 'silent-later' })
    const id = say(r, { text: 'a' })
    await expect.poll(() => r.fake.reactionsOn(id)).toEqual([STATUS_EMOJI.working])
    await sleep(EVERY_MS * 3)
    expect(typings(r)).toEqual([])
    await r.close()
    rig = undefined
    const t = await start(config({ statusReactions: false }), { mode: 'silent-later' })
    say(t, { text: 'b' })
    await expect.poll(() => typings(t).length).toBeGreaterThanOrEqual(1)
    expect(t.fake.status.filter((c) => c.what === 'reaction')).toEqual([])
  })
})

describe('turn status: a call that fails never holds up or breaks the turn', () => {
  it('[P:turn-status] a short rate limit on reactions is waited out off the turn\'s path, and the swap still lands in order', async () => {
    const r = await start()
    r.fake.refuseStatus('reaction', 2, { retryAfterSec: 0.05 })
    const id = say(r, { text: 'hi' })
    await r.posts(1)
    await finalReaction(r, id, STATUS_EMOJI.done)
    expect(reactionsTo(r, id)).toEqual(['+👀', '+✅', '-👀'])
    expect(statusReceipts(r)).toEqual([])
  })

  it('[P:turn-status] a long rate limit, or a missing permission, is a receipt and nothing more: the reply is posted at once', async () => {
    const r = await start(config(), { mode: 'silent-later' })
    // Longer than the connector waits for a status call (200 ms here), so it gives up on it.
    r.fake.refuseStatus('reaction', 1, { retryAfterSec: 30 })
    r.fake.refuseStatus('typing', 99, { retryAfterSec: 30 })
    const id = say(r, { text: 'hi' })
    await expect.poll(() => r.shim.heard.length).toBe(1)
    const sent = Date.now()
    r.shim.client.send({ t: 'reply', turnId: r.shim.heard[0].turnId, text: 'answer', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await r.posts(1)
    expect(Date.now() - sent).toBeLessThan(1000)
    expect(r.fake.posted.map((p) => p.content)).toEqual(['answer'])
    await finalReaction(r, id, STATUS_EMOJI.done)
    // One receipt for each kind of call that failed in the turn, however often it failed.
    await expect.poll(() => statusReceipts(r).map((x) => `${x.verdict} ${x.note}`).sort()).toEqual(['drop what=reaction code=rate-limited', 'drop what=typing code=rate-limited'])
    expect(statusReceipts(r).every((x) => x.event.messageId === id)).toBe(true)

    const denied = say(r, { text: 'again' })
    r.fake.refuseStatus('reaction', 99, { status: 403 })
    await expect.poll(() => r.shim.heard.length).toBe(2)
    r.shim.client.send({ t: 'reply', turnId: r.shim.heard[1].turnId, text: 'second', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[1].turnId })
    await r.posts(2)
    await expect.poll(() => statusReceipts(r).filter((x) => x.event.messageId === denied).map((x) => x.note)).toContain('what=reaction code=403')
    expect(statusReceipts(r).find((x) => x.note === 'what=reaction code=403')?.why).toMatch(/Add Reactions/)
  })
})

describe('turn status: waiting for an admin', () => {
  const asking = (): LabConfig => config({}, { tools: { enabled: ['shell'] } })

  it('[P:turn-status] 👀 stays and typing stops while a call waits for a yes; typing comes back after it', async () => {
    const r = await start(asking(), { shimCaps: { approvalRoundTrip: true }, door: { approvalTimeoutMs: 3000 }, connector: { reactions: true } })
    const id = say(r, { text: '!tool bash=touch' })
    await expect.poll(() => r.fake.posted.length).toBe(1)
    const request = r.fake.posted[0].id
    await sleep(EVERY_MS) // a typing call that was already on its way is let land
    const held = typings(r).length
    await sleep(EVERY_MS * 5)
    expect(typings(r).length).toBe(held)
    expect(r.fake.reactionsOn(id)).toEqual([STATUS_EMOJI.working])
    // Nothing is put on the door's own request.
    expect(r.fake.reactionsOn(request)).toEqual([])
    r.fake.react({ channel: IDS.home, guild: IDS.guild, messageId: request, author: { id: IDS.admin }, emoji: '✅' })
    await r.posts(2)
    await finalReaction(r, id, STATUS_EMOJI.done)
    expect(r.fake.reactionsOn(request)).toEqual([])
  })
})
