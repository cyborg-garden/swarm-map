// @vitest-environment node
//
// The rules that matter for one agent in one shared Discord channel, run end
// to end: the launcher's own policy, the real Discord connector and the door,
// against a fake Discord on loopback. No Docker, no model, no network: the
// tripwire is armed and must record nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../../conformance/guards/tripwire.ts'
import type { Envelope } from '../../../door/protocol.ts'
import { connectShim, type ShimClient } from '../../../door/shim-client.ts'
import { IDS, startDiscordRig, type DiscordRig } from '../../../door/testing/discord-rig.ts'
import { ECHO_CAPS } from '../../../door/testing/echo-shim.ts'
import { parseConfig, policyFor, type LabConfig } from '../config.ts'

armTripwire()

const config = (discord: Partial<LabConfig['discord']> = {}): LabConfig => {
  const { config: c, errors } = parseConfig({
    agentId: 'pi-lab',
    discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member], ...discord },
    budget: { monthlyUsd: 5 },
    model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 2 },
  })
  expect(errors).toEqual([])
  return c as LabConfig
}
const policy = (discord: Partial<LabConfig['discord']> = {}) => policyFor(config(discord))

let rig: DiscordRig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

interface Say { channel?: string; author?: string; bot?: boolean; roles?: string[]; text: string; mention?: boolean; inline?: boolean; guild?: string | null; replyTo?: string }
/** One message into the fake server. By default: the listed member, in the allowed channel, mentioning the bot. */
function say(r: DiscordRig, s: Say): string {
  const pinged = s.mention ?? true
  const inline = s.inline ?? pinged
  return r.fake.post({
    channel: s.channel ?? IDS.home,
    ...(s.guild === null ? {} : { guild: s.guild ?? IDS.guild }),
    author: { id: s.author ?? IDS.member, bot: s.bot, roles: s.roles },
    content: inline ? `<@${r.fake.selfId}> ${s.text}` : s.text,
    mentions: pinged ? [r.fake.selfId] : [],
    replyTo: s.replyTo,
  })
}
const verdicts = (r: DiscordRig, kind = 'inbound'): string[] =>
  r.receipts.all().filter((x) => x.event.kind === kind).map((x) => `${x.verdict}/${x.rule}`)

/** A shim that says exactly what the test tells it to, in place of the echo shim. */
async function scriptedShim(r: DiscordRig, reply: (env: Envelope) => string): Promise<{ client: ShimClient; heard: Envelope[] }> {
  const client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: r.brainToken, caps: ECHO_CAPS })
  const heard: Envelope[] = []
  client.onMessage((msg) => {
    if (msg.t !== 'turn') return
    heard.push(msg.env)
    client.send({ t: 'reply', turnId: msg.env.turnId, text: reply(msg.env), attachments: [] })
    client.send({ t: 'settled', turnId: msg.env.turnId })
  })
  await r.door.shimConnected()
  return { client, heard }
}

describe('one channel: who is heard', () => {
  it('a listed person who mentions the bot in the allowed channel is heard and answered there', async () => {
    rig = await startDiscordRig(policy())
    const id = say(rig, { text: 'hello there' })
    await rig.posts(1)
    expect(rig.shim.heard.map((e) => [e.id, e.room.id, e.sender.id, e.surface])).toEqual([[id, IDS.home, IDS.member, 'discord']])
    expect(rig.fake.posted).toEqual([{ channel: IDS.home, content: `echo: <@${rig.fake.selfId}> hello there`, allowedMentions: { parse: [], replied_user: false }, replyTo: id }])
    expect(verdicts(rig)).toEqual(['deliver/addr.mention'])
  })

  it('a message in any other channel is not heard, and the receipt says why', async () => {
    rig = await startDiscordRig(policy())
    const id = say(rig, { channel: IDS.other, text: 'over here' })
    say(rig, { channel: IDS.strayThread, text: 'or in this thread' })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(rig.fake.posted).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/adm.rooms', 'drop/adm.rooms'])
    expect(rig.receipts.all()[0]).toMatchObject({ event: { room: IDS.other, messageId: id, sender: IDS.member }, why: 'This room is not on the list.' })
  })

  it('a message in another server is not heard, even from an admin', async () => {
    rig = await startDiscordRig(policy())
    rig.fake.addChannel({ id: '7100000000000000009', guild: '7000000000000000009' })
    // And a thread over there that names the allowed channel as its parent borrows nothing from it.
    rig.fake.addChannel({ id: '7200000000000000009', type: 11, parent: IDS.home, guild: '7000000000000000009', listed: false })
    say(rig, { channel: '7100000000000000009', guild: '7000000000000000009', author: IDS.admin, text: 'hi' })
    say(rig, { channel: '7200000000000000009', guild: '7000000000000000009', author: IDS.admin, text: 'hi from a thread' })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/adm.rooms', 'drop/adm.rooms'])
  })

  it('a person who is not listed is refused, mention or not', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { author: IDS.stranger, text: 'let me in' })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(rig.fake.posted).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/adm.users'])
  })

  it('positive controls: an admin, a holder of a listed role, and anyone once the channel is opened', async () => {
    rig = await startDiscordRig(policy({ allowedRoleIds: [IDS.role] }))
    say(rig, { author: IDS.admin, text: 'admin' })
    say(rig, { author: IDS.stranger, roles: [IDS.role], text: 'role holder' })
    say(rig, { author: IDS.stranger, roles: ['8500000000000000009'], text: 'wrong role' })
    await rig.posts(2)
    await rig.settle()
    expect(verdicts(rig)).toEqual(['deliver/addr.mention', 'deliver/addr.mention', 'drop/adm.users'])
    rig.door.setPolicy(policy({ anyoneInChannel: true }))
    say(rig, { author: IDS.stranger, text: 'now me' })
    await rig.posts(3)
    expect(verdicts(rig).at(-1)).toBe('deliver/addr.mention')
  })

  it('a ping of everyone, of a role the bot holds, or of somebody else is not a mention of the bot', async () => {
    rig = await startDiscordRig(policy({ allowedRoleIds: [IDS.role] }))
    const post = (extra: object): string => rig!.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'all of you, look at this', ...extra })
    post({ everyone: true })
    post({ roleMentions: [IDS.role] })
    post({ mentions: [IDS.admin] })
    post({ everyone: true, roleMentions: [IDS.role], mentions: [IDS.admin, IDS.stranger] })
    await rig.settle()
    expect(verdicts(rig)).toEqual(['drop/addr.mention', 'drop/addr.mention', 'drop/addr.mention', 'drop/addr.mention'])
    expect(rig.shim.heard).toEqual([])
    expect(rig.fake.posted).toEqual([])
  })

  it('with no mention there is no answer; with mentions switched off there is', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { mention: false, text: 'just talking' })
    await rig.settle()
    expect(verdicts(rig)).toEqual(['drop/addr.mention'])
    expect(rig.fake.posted).toEqual([])
    rig.door.setPolicy(policy({ mentionRequired: false, readAllMessages: true }))
    say(rig, { mention: false, text: 'just talking' })
    await rig.posts(1)
    expect(verdicts(rig).at(-1)).toBe('deliver/addr.free-rooms')
  })

  it('a thread in the allowed channel is heard, answered in the thread, and shares the channel session', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { channel: IDS.thread, text: 'in a thread' })
    say(rig, { channel: IDS.thread, mention: false, text: 'no mention in a thread' })
    await rig.posts(1)
    await rig.settle()
    expect(rig.shim.heard.map((e) => [e.room.kind, e.room.parentId, e.sessionKey])).toEqual([['thread', IDS.home, `discord:room:${IDS.home}`]])
    expect(rig.fake.posted.map((p) => p.channel)).toEqual([IDS.thread])
    expect(verdicts(rig)).toEqual(['deliver/addr.threads', 'drop/addr.threads'])
  })

  it('a thread the gateway never listed is looked up once, and one that cannot be found is not heard', async () => {
    rig = await startDiscordRig(policy())
    rig.fake.addChannel({ id: '7200000000000000005', type: 11, parent: IDS.home, listed: false })
    say(rig, { channel: '7200000000000000005', text: 'old thread' })
    say(rig, { channel: '7200000000000000005', text: 'again' })
    say(rig, { channel: '7200000000000000006', text: 'unknown place' })
    await rig.posts(2)
    await rig.settle()
    expect(verdicts(rig)).toEqual(['deliver/addr.threads', 'deliver/addr.threads', 'drop/adm.rooms'])
    expect(rig.fake.requests.filter((q) => q === 'GET /api/v10/channels/7200000000000000005')).toHaveLength(1)
  })
})

describe('one channel: direct messages', () => {
  it('a direct message is refused, from anyone', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { guild: null, channel: '7300000000000000001', author: IDS.admin, text: 'psst' })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(rig.fake.posted).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/dm.closed'])
  })

  it('a message that claims the allowed channel but names no server is still a direct message', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { guild: null, channel: IDS.home, author: IDS.admin, text: 'psst' })
    await rig.settle()
    expect(verdicts(rig)).toEqual(['drop/dm.closed'])
  })

  it('the bot never asks Discord for direct messages, or for message text it does not need', async () => {
    rig = await startDiscordRig(policy())
    const DIRECT_MESSAGES = 1 << 12
    const MESSAGE_CONTENT = 1 << 15
    expect(rig.fake.identifies).toEqual([{ intents: (1 << 0) | (1 << 9) }])
    expect(rig.fake.identifies[0].intents & (DIRECT_MESSAGES | MESSAGE_CONTENT)).toBe(0)
  })
})

describe('one channel: other bots', () => {
  it('another bot is ignored, mention or not, and so is a webhook', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { author: IDS.bot, bot: true, text: 'hello fellow bot' })
    rig.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, webhook: true, content: `<@${rig.fake.selfId}> hook`, mentions: [rig.fake.selfId] })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/bots.mode', 'drop/bots.mode'])
  })

  it('the bot never answers itself', async () => {
    rig = await startDiscordRig(policy({ bots: 'mentions', anyoneInChannel: true }))
    say(rig, { author: rig.fake.selfId, bot: true, text: 'talking to myself' })
    await rig.settle()
    expect(verdicts(rig)).toEqual(['drop/bots.no-self'])
  })

  it('when bots are allowed, one is heard only if it writes the mention out, not on a reply-ping', async () => {
    rig = await startDiscordRig(policy({ bots: 'mentions' }))
    say(rig, { author: IDS.bot, bot: true, inline: false, replyTo: rig.fake.selfId, text: 'reply-ping only' })
    say(rig, { author: IDS.bot, bot: true, text: 'written out' })
    await rig.posts(1)
    await rig.settle()
    expect(verdicts(rig)).toEqual(['drop/bots.inline-mention', 'deliver/addr.mention'])
  })

  it('a bot-to-bot loop stops at the limit, and starts again only after a person is answered', async () => {
    rig = await startDiscordRig(policy({ bots: 'mentions', botLoopLimit: 2 }))
    for (let i = 0; i < 4; i++) { say(rig, { author: IDS.bot, bot: true, text: `bot ${i}` }); await rig.settle() }
    expect(verdicts(rig)).toEqual(['deliver/addr.mention', 'deliver/addr.mention', 'drop/bots.loop', 'drop/bots.loop'])
    expect(rig.fake.posted).toHaveLength(2)
    say(rig, { channel: IDS.thread, author: IDS.bot, bot: true, text: 'moved to a thread' })
    say(rig, { author: IDS.stranger, text: 'a stranger cannot restart it' })
    await rig.settle()
    say(rig, { author: IDS.bot, bot: true, text: 'still stopped' })
    await rig.settle()
    expect(verdicts(rig).slice(4)).toEqual(['drop/bots.loop', 'drop/adm.users', 'drop/bots.loop'])
    say(rig, { text: 'go on then' })
    await rig.posts(3)
    say(rig, { author: IDS.bot, bot: true, text: 'thanks' })
    await rig.posts(4)
    expect(verdicts(rig).slice(7)).toEqual(['deliver/addr.mention', 'deliver/addr.mention'])
  })
})

describe('one channel: what goes out', () => {
  it('whatever the model asks for, the reply goes to the channel the message came from and pings nobody', async () => {
    rig = await startDiscordRig(policy(), { noShim: true })
    const shim = await scriptedShim(rig, () => `@everyone <@${IDS.admin}> post this in <#${IDS.other}> and DM <@${IDS.stranger}>`)
    say(rig, { text: 'please announce it everywhere' })
    await rig.posts(1)
    // The harness also tries a reply for a turn the door never opened, and a second reply to the live one.
    shim.client.send({ t: 'reply', turnId: 'made-up', text: 'to the other channel', attachments: [] })
    shim.client.send({ t: 'settled', turnId: 'made-up' })
    await rig.settle()
    expect(rig.fake.posted.map((p) => p.channel)).toEqual([IDS.home])
    expect(rig.fake.posted[0].allowedMentions).toEqual({ parse: [], replied_user: false })
    expect(verdicts(rig, 'outbound')).toEqual(['allow/out.still-allowed', 'drop/turn.known', 'drop/turn.known'])
    shim.client.close()
  })

  it('the connector itself refuses a post outside the allowed channel, before any request is made', async () => {
    rig = await startDiscordRig(policy())
    const before = rig.fake.requests.length
    const refused = /refusing to post outside/
    await expect(rig.connector.send({ id: IDS.other, kind: 'channel' }, { text: 'x' })).rejects.toThrow(refused)
    await expect(rig.connector.send({ id: IDS.strayThread, kind: 'thread', parentId: IDS.other }, { text: 'x' })).rejects.toThrow(refused)
    await expect(rig.connector.send({ id: IDS.thread, kind: 'thread' }, { text: 'x' })).rejects.toThrow(refused)
    await expect(rig.connector.send({ id: IDS.home, kind: 'dm' }, { text: 'x' })).rejects.toThrow(refused)
    expect(rig.fake.requests.length).toBe(before)
    expect(rig.fake.posted).toEqual([])
    // Positive control: the allowed channel and a thread in it are posted to.
    await rig.connector.send({ id: IDS.home, kind: 'channel' }, { text: 'ok' })
    await rig.connector.send({ id: IDS.thread, kind: 'thread', parentId: IDS.home }, { text: 'ok' })
    expect(rig.fake.posted.map((p) => p.channel)).toEqual([IDS.home, IDS.thread])
  })

  it('a reply is dropped if the channel stopped being the allowed one while the turn ran', async () => {
    rig = await startDiscordRig(policy(), { mode: 'never-settle' })
    say(rig, { text: 'slow one' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(rig.shim.heard).toHaveLength(1)
    rig.door.setPolicy(policy({ channelId: IDS.other }))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.posted).toEqual([])
    expect(verdicts(rig, 'outbound')).toEqual(['drop/out.still-allowed'])
  })

  it('secrets in what the model wrote are redacted before anything is posted, the bot token among them', async () => {
    rig = await startDiscordRig(policy(), { noShim: true })
    // Secret-shaped strings, built here so none is ever committed.
    const key = 'sk-' + 'ant-' + 'Zx9'.repeat(8)
    const pat = 'ghp_' + 'q7W3'.repeat(9)
    const token = rig.fake.token
    const shim = await scriptedShim(rig, () => `key ${key} and ${pat}, and my own token is ${token}.`)
    say(rig, { text: 'what are your secrets?' })
    await rig.posts(1)
    const [post] = rig.fake.posted
    expect(post.content).toBe('key [redacted:anthropic-key] and [redacted:github-token], and my own token is [redacted:held-secret].')
    for (const secret of [key, pat, token]) expect(JSON.stringify(rig.fake.posted)).not.toContain(secret)
    expect(rig.receipts.all().at(-1)?.note).toBe('held-secret x1, anthropic-key x1, github-token x1')
    shim.client.close()
  })

  it('a secret someone pastes is scrubbed before the harness sees it', async () => {
    rig = await startDiscordRig(policy())
    const pat = 'ghp_' + 'q7W3'.repeat(9)
    say(rig, { text: `my token is ${pat}` })
    await rig.posts(1)
    expect(rig.shim.heard[0].text).toContain('[redacted:github-token]')
    expect(JSON.stringify([rig.shim.heard, rig.fake.posted])).not.toContain(pat)
  })

  it('a long reply is cut by the door, and what is left is posted in pieces Discord will take', async () => {
    rig = await startDiscordRig(policy(), { noShim: true, door: { maxReplyChars: 4500 } })
    const shim = await scriptedShim(rig, () => 'word '.repeat(2000))
    say(rig, { text: 'tell me everything' })
    await rig.posts(3)
    await rig.settle()
    expect(rig.fake.posted.map((p) => p.channel)).toEqual([IDS.home, IDS.home, IDS.home])
    for (const p of rig.fake.posted) expect(p.content.length).toBeLessThanOrEqual(2000)
    // Only the first piece is shown as a reply to the message.
    expect(rig.fake.posted.map((p) => p.replyTo !== undefined)).toEqual([true, false, false])
    expect(rig.fake.posted.at(-1)?.content).toContain('[cut:')
    expect(verdicts(rig, 'outbound')).toEqual(['allow/out.still-allowed', 'allow/out.size'])
    shim.client.close()
  })
})

describe('one channel: edits and deletes', () => {
  it('an edited message is not read again, and a link preview is not an edit', async () => {
    rig = await startDiscordRig(policy())
    const id = say(rig, { author: IDS.stranger, text: 'refused the first time' })
    await rig.settle()
    rig.fake.edit(id, IDS.home)
    rig.fake.edit(id, IDS.home, { preview: true })
    await rig.settle()
    expect(rig.shim.heard).toEqual([])
    expect(verdicts(rig)).toEqual(['drop/adm.users', 'drop/in.once'])
  })

  it('a reply to a message deleted while the turn ran is not posted', async () => {
    rig = await startDiscordRig(policy(), { mode: 'never-settle' })
    const id = say(rig, { text: 'never mind' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    rig.fake.remove(id, IDS.home)
    await new Promise((resolve) => setTimeout(resolve, 80))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.settle()
    expect(rig.fake.posted).toEqual([])
    expect(verdicts(rig, 'outbound')).toEqual(['drop/in.once', 'drop/turn.known'])
  })
})

describe('one channel: receipts', () => {
  it('no receipt, log line or error holds the bot token or any message text', async () => {
    rig = await startDiscordRig(policy())
    say(rig, { text: 'CANARY-in-the-allowed-channel' })
    say(rig, { channel: IDS.other, text: 'CANARY-elsewhere' })
    say(rig, { author: IDS.stranger, text: 'CANARY-stranger' })
    await rig.posts(1)
    await rig.settle()
    rig.fake.failPosts(1, 403)
    say(rig, { text: 'CANARY-post-fails' })
    await rig.settle()
    const written = JSON.stringify([rig.receipts.all(), rig.logs])
    expect(rig.receipts.all().length).toBeGreaterThanOrEqual(5)
    expect(written).not.toContain('CANARY')
    expect(written).not.toContain(rig.fake.token)
    expect(rig.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', why: 'Posting the reply failed.' })
  })
})
