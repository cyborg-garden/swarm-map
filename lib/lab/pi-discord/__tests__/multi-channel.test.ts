// @vitest-environment node
//
// One agent in more than one Discord channel: its own, and others beside it, one of which may
// hear anyone with fewer tools. Run end to end like shared-channel.test.ts: the launcher's own
// policy, the real Discord connector and the door, against a fake Discord on loopback. No Docker,
// no model, no network: the tripwire is armed and must record nothing.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../../conformance/guards/tripwire.ts'
import { createMemoryStore } from '../../../door/memory.ts'
import type { Envelope, ToShim } from '../../../door/protocol.ts'
import { createSanitizer } from '../../../door/sanitizer.ts'
import { connectShim } from '../../../door/shim-client.ts'
import { IDS, startDiscordRig, type DiscordRig } from '../../../door/testing/discord-rig.ts'
import { ECHO_CAPS } from '../../../door/testing/echo-shim.ts'
import { decide } from '../../../core/decide.ts'
import { channelIdsOf, parseConfig, policyFor, systemPromptFor, withChannels, type LabConfig } from '../config.ts'

armTripwire()

/** A third channel in the same server, on no list. */
const THIRD = '7100000000000000003'
const THIRD_THREAD = '7200000000000000003'

const base = (discord: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: 'pi-lab',
  discord: { guildId: IDS.guild, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member], ...discord },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 2 },
  ...rest,
})
const parsed = (raw: Record<string, unknown>): LabConfig => {
  const { config, errors } = parseConfig(raw)
  expect(errors).toEqual([])
  return config as LabConfig
}
const refused = (raw: Record<string, unknown>): string => parseConfig(raw).errors.join('; ')

/** The agent's own channel, with shell (asks) and reading files, and a public one beside it: anyone, by mention, web only. */
const LAB_TOOLS = { enabled: ['shell', 'file_read'], web: { allow: ['example.org'], approval: 'ask' } }
const withPublic = (extra: Record<string, unknown> = {}): LabConfig => parsed(base({
  channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } }, ...extra,
}, { tools: LAB_TOOLS }))

let rig: DiscordRig | undefined
const dirs: string[] = []
afterEach(async () => {
  await rig?.close()
  rig = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})

/** The rig, with the connector scoped the way the launcher scopes it: to the config's channels. */
async function start(config: LabConfig, opts: Parameters<typeof startDiscordRig>[1] = {}): Promise<DiscordRig> {
  rig = await startDiscordRig(policyFor(config), { ...opts, connector: { sendScope: channelIdsOf(config), ...opts.connector } })
  rig.fake.addChannel({ id: THIRD })
  rig.fake.addChannel({ id: THIRD_THREAD, type: 11, parent: THIRD })
  return rig
}

interface Say { channel?: string; author?: string; text: string; mention?: boolean }
function say(r: DiscordRig, s: Say): string {
  const pinged = s.mention ?? true
  return r.fake.post({
    channel: s.channel ?? IDS.home, guild: IDS.guild, author: { id: s.author ?? IDS.member },
    content: pinged ? `<@${r.fake.selfId}> ${s.text}` : s.text, mentions: pinged ? [r.fake.selfId] : [],
  })
}
const verdicts = (r: DiscordRig, kind = 'inbound'): string[] =>
  r.receipts.all().filter((x) => x.event.kind === kind).map((x) => `${x.verdict}/${x.rule}`)
const arrive = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

describe('channel list: the config', () => {
  it('`channelId` alone is a list of one: the same config, written as it always was, and the same policy', () => {
    const alias = parsed(base({ channelId: IDS.home }))
    const list = parsed(base({ channelIds: [IDS.home] }))
    const both = parsed(base({ channelId: IDS.home, channelIds: [IDS.home] }))
    expect(list).toEqual(alias)
    expect(both).toEqual(alias)
    expect(alias.discord).not.toHaveProperty('channelIds')
    expect(alias.discord).not.toHaveProperty('perChannel')
    expect(policyFor(list).hash).toBe(policyFor(alias).hash)
    expect(channelIdsOf(alias)).toEqual([IDS.home])
    expect(policyFor(alias).tools).not.toHaveProperty('perRoom')
  })

  it('more than one channel: each is a room, the first is the agent\'s own, and an unchanged entry is not kept', () => {
    const c = parsed(base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: false, tools: 'inherit' } } }))
    expect(c.discord.channelId).toBe(IDS.home)
    expect(c.discord.channelIds).toEqual([IDS.home, IDS.other])
    expect(c.discord).not.toHaveProperty('perChannel')
    expect(policyFor(c).surfaces.discord!.rooms).toEqual([
      { match: { room: IDS.home }, mode: 'mention' }, { match: { room: IDS.other }, mode: 'mention' },
    ])
    // Saved and read again, it is the same.
    expect(parsed({ ...base(), discord: c.discord })).toEqual(c)
  })

  it('a public channel is a room that hears anyone, always by mention, with the web and the notes only', () => {
    const c = withPublic({ mentionRequired: false, readAllMessages: true })
    const p = policyFor(c)
    expect(p.posture).toBe('team')
    expect(p.surfaces.discord!.rooms).toEqual([
      { match: { room: IDS.home }, mode: 'free' }, { match: { room: IDS.other }, mode: 'mention', anyone: true },
    ])
    expect(p.tools.perRoom).toEqual({ [IDS.other]: { allow: ['network', 'search', 'memory'] } })
    expect(p.budget).toEqual({ monthlyUsd: 5, onExceed: 'refuse' })
    expect(p.surfaces.discord!.admins).toEqual([{ kind: 'user', id: IDS.admin }])
    const none = parsed(base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { tools: 'none' } } }, { tools: LAB_TOOLS }))
    expect(policyFor(none).tools.perRoom).toEqual({ [IDS.other]: { allow: ['memory'] } })
    // The agent is told, in words that are true for this config.
    expect(systemPromptFor(c)).toContain('a chat assistant in 2 Discord channels')
    expect(systemPromptFor(c)).toContain('What is said in one is never shown to you in another')
    expect(systemPromptFor(c)).toContain('never commands or files')
  })

  it('the dashboard\'s helper writes what the parser keeps', () => {
    const one = parsed(base({ channelId: IDS.home }))
    const two = withChannels(one.discord, IDS.home, [{ id: IDS.other, anyoneInChannel: true, tools: 'web-only' }])
    expect(two).toMatchObject({ channelId: IDS.home, channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } } })
    expect(parsed({ ...base(), discord: two }).discord).toEqual(two)
    const back = withChannels(two, IDS.home, [])
    expect(back).not.toHaveProperty('channelIds')
    expect(back).not.toHaveProperty('perChannel')
    expect(parsed({ ...base(), discord: back })).toEqual(one)
  })

  it.each([
    ['an empty list', { channelIds: [] }, /discord\.channelIds: a list of 1 to 10/],
    ['eleven channels', { channelIds: Array.from({ length: 11 }, (_, i) => `71000000000000001${String(i).padStart(2, '0')}`) }, /discord\.channelIds: a list of 1 to 10/],
    ['a channel twice', { channelIds: [IDS.home, IDS.home] }, /each channel at most once/],
    ['an id that is not one', { channelIds: [IDS.home, 'lobby'] }, /discord\.channelIds\[1\]: must be a Discord id/],
    ['channelId that is not the first of the list', { channelId: IDS.other, channelIds: [IDS.home, IDS.other] }, /discord\.channelId: when channelIds is given too/],
    ['an entry for the agent\'s own channel', { channelIds: [IDS.home, IDS.other], perChannel: { [IDS.home]: { anyoneInChannel: true } } }, new RegExp(`discord\\.perChannel\\.${IDS.home}: not a setting`)],
    ['an entry for a channel not on the list', { channelIds: [IDS.home, IDS.other], perChannel: { [THIRD]: { tools: 'none' } } }, new RegExp(`discord\\.perChannel\\.${THIRD}: not a setting`)],
    ['a tools setting it does not have', { channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { tools: 'shell-only' } } }, /tools: must be inherit, web-only, none/],
    ['a key it does not have', { channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { mentionRequired: false } } }, /mentionRequired: not a setting/],
  ])('refuses %s', (_what, discord, why) => {
    expect(refused(base(discord))).toMatch(why)
  })

  it('refuses a channel that hears anyone and keeps the agent\'s shell and file tools, or reads the public web with no yes', () => {
    const inherit = base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true } } }, { tools: LAB_TOOLS })
    expect(refused(inherit)).toMatch(new RegExp(`discord\\.perChannel\\.${IDS.other}\\.tools: a channel that hears anyone gets no shell or file tools`))
    const publicWeb = base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } } }, { tools: { enabled: [], web: { mode: 'public', allow: [] } } })
    expect(refused(publicWeb)).toMatch(/reads the public web only with an admin's yes/)
    // Positive controls: web only, or the public web with a yes for each address.
    parsed(base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } } }, { tools: LAB_TOOLS }))
    parsed(base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } } }, { tools: { enabled: [], web: { mode: 'public', allow: [], approval: 'ask' } } }))
  })

  it("with tools.web.anyoneRooms 'open', a channel that hears anyone reads the public web with no yes, and still gets no shell or file tools", () => {
    const open = (tools: Record<string, unknown>, ch: Record<string, unknown> = { tools: 'web-only' }) => base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, ...ch } } }, { tools })
    const config = parsed(open({ enabled: [], web: { mode: 'public', allow: [], anyoneRooms: 'open' } }))
    const policy = policyFor(config)
    expect(policy.egress).toMatchObject({ default: 'public', openToAnyone: true })
    const stranger = { id: '900000000000000099', display: 'x', isBot: false, isSelf: false, roles: [] }
    const call = (toolClass: 'network' | 'shell') => decide(policy, { kind: 'tool', surface: 'discord', room: { id: IDS.other, kind: 'channel' }, actor: stranger, toolClass, toolName: toolClass, argsDigest: '' }, {})
    expect(call('network')).toMatchObject({ verdict: 'allow', rule: 'tools.lists' })
    expect(call('shell').verdict).toBe('deny')
    // The shell and file tools are still refused there.
    expect(refused(open({ ...LAB_TOOLS, web: { mode: 'public', allow: [], anyoneRooms: 'open' } }, {}))).toMatch(/a channel that hears anyone gets no shell or file tools/)
    // 'ask', written out, is the default: still refused.
    expect(refused(open({ enabled: [], web: { mode: 'public', allow: [], anyoneRooms: 'ask' } }))).toMatch(/reads the public web only with an admin's yes/)
  })

  it('refuses more than one channel for a harness that keeps one memory for the whole agent', () => {
    expect(refused(base({ channelIds: [IDS.home, IDS.other] }, { harness: 'letta-code' }))).toMatch(/discord\.channelIds: Letta Code keeps one memory/)
    parsed(base({ channelIds: [IDS.home] }, { harness: 'letta-code' }))
  })
})

describe('two channels, end to end', () => {
  it('each listed channel is heard and answered in itself, as a conversation of its own; a message anywhere else is ignored', async () => {
    const r = await start(parsed(base({ channelIds: [IDS.home, IDS.other] })))
    const a = say(r, { channel: IDS.home, text: 'in the first' })
    const b = say(r, { channel: IDS.other, text: 'in the second' })
    await r.posts(2)
    say(r, { channel: THIRD, author: IDS.admin, text: 'in a third' })
    say(r, { channel: THIRD_THREAD, author: IDS.admin, text: 'in a thread of the third' })
    await r.settle()
    expect(r.shim.heard.map((e) => [e.id, e.room.id, e.sessionKey])).toEqual([
      [a, IDS.home, `discord:room:${IDS.home}`], [b, IDS.other, `discord:room:${IDS.other}`],
    ])
    expect(r.fake.posted.map((p) => [p.channel, p.replyTo]).sort()).toEqual([[IDS.home, a], [IDS.other, b]].sort())
    expect(verdicts(r)).toEqual(['deliver/addr.mention', 'deliver/addr.mention', 'drop/adm.rooms', 'drop/adm.rooms'])
  })

  it('the connector posts in the listed channels and their threads, and refuses any other before a request is made', async () => {
    const r = await start(parsed(base({ channelIds: [IDS.home, IDS.other] })))
    const before = r.fake.requests.length
    await expect(r.connector.send({ id: THIRD, kind: 'channel' }, { text: 'x' })).rejects.toThrow(/refusing to post outside/)
    await expect(r.connector.send({ id: THIRD_THREAD, kind: 'thread', parentId: THIRD }, { text: 'x' })).rejects.toThrow(/refusing to post outside/)
    expect(r.fake.requests.length).toBe(before)
    await r.connector.send({ id: IDS.home, kind: 'channel' }, { text: 'ok' })
    await r.connector.send({ id: IDS.other, kind: 'channel' }, { text: 'ok' })
    await r.connector.send({ id: IDS.strayThread, kind: 'thread', parentId: IDS.other }, { text: 'ok' })
    expect(r.fake.posted.map((p) => p.channel)).toEqual([IDS.home, IDS.other, IDS.strayThread])
  })

  it('a reply to a channel taken off the list while the turn ran is dropped', async () => {
    const r = await start(parsed(base({ channelIds: [IDS.home, IDS.other] })), { mode: 'never-settle' })
    say(r, { channel: IDS.other, text: 'slow one' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(r.shim.heard).toHaveLength(1)
    r.door.setPolicy(policyFor(parsed(base({ channelIds: [IDS.home] }))))
    r.shim.client.send({ t: 'settled', turnId: r.shim.heard[0].turnId })
    await r.door.idle()
    expect(r.fake.posted).toEqual([])
    expect(verdicts(r, 'outbound')).toEqual(['drop/out.still-allowed'])
  })
})

describe('a public channel beside the agent\'s own', () => {
  const opts = { shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 4000, connector: { reactions: true }, door: { approvalTimeoutMs: 600 } }

  it('anyone is heard there, by mention only, as a guest; the same stranger is not heard in the agent\'s own channel', async () => {
    const r = await start(withPublic(), opts)
    const a = say(r, { channel: IDS.other, author: IDS.stranger, text: 'hello' })
    await r.posts(1)
    say(r, { channel: IDS.other, author: IDS.stranger, mention: false, text: 'no mention' })
    say(r, { channel: IDS.home, author: IDS.stranger, text: 'and here' })
    await r.settle()
    expect(r.shim.heard.map((e) => [e.id, e.room.id, e.sender.id])).toEqual([[a, IDS.other, IDS.stranger]])
    expect(verdicts(r)).toEqual(['deliver/addr.mention', 'drop/addr.mention', 'drop/adm.users'])
  })

  it('there, a stranger, a listed person and an admin are offered no shell or file tool, and a request for one is refused', async () => {
    const r = await start(withPublic(), opts)
    for (const author of [IDS.stranger, IDS.member, IDS.admin]) say(r, { channel: IDS.other, author, text: '!tool bash=ls !tool read' })
    await r.posts(3)
    await r.settle()
    expect(r.shim.heard.map((e) => e.tools)).toEqual(Array(3).fill(['fetch']))
    expect(r.shim.toolsRan).toEqual([])
    expect(verdicts(r, 'tool')).toEqual(Array(6).fill('deny/tools.posture'))
    // Positive control: in the agent's own channel the same lists give a listed person file reading, and the shell waits for an admin.
    say(r, { channel: IDS.home, author: IDS.member, text: '!tool read' })
    await r.posts(4)
    expect(r.shim.heard.at(-1)!.tools).toEqual(expect.arrayContaining(['bash', 'read', 'fetch']))
    expect(r.shim.toolsRan.map((t) => t.tool)).toEqual(['read'])
  })

  it('a request from there waits for an admin: the stranger who asked, or anyone else who is not an admin, cannot answer it', async () => {
    const r = await start(withPublic(), opts)
    say(r, { channel: IDS.other, author: IDS.stranger, text: '!web https://example.org/page' })
    await expect.poll(() => r.fake.posted.length).toBe(1)
    const request = r.fake.posted[0]
    expect(request.channel).toBe(IDS.other)
    expect(request.content.split('\n')[0]).toMatch(/^Approval needed/)
    for (const author of [IDS.stranger, IDS.member]) r.fake.react({ channel: IDS.other, guild: IDS.guild, messageId: request.id, author: { id: author }, emoji: '✅' })
    r.fake.post({ channel: IDS.other, guild: IDS.guild, author: { id: IDS.stranger }, content: `<@${r.fake.selfId}> approve`, mentions: [r.fake.selfId], replyToMessage: request.id })
    await arrive()
    expect(verdicts(r, 'approval')).toEqual(Array(3).fill('deny/priv.approval'))
    // Nobody who may answer did, so it ran out: the page was never fetched.
    await expect.poll(() => r.shim.pages.length, { timeout: 3000 }).toBe(1)
    expect(r.shim.pages[0]).toMatchObject({ ok: false })
  })
})

describe('notes, with more than one channel', () => {
  it('a note kept in one channel is given in that channel only, never in another', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'door-multi-'))
    dirs.push(dir)
    const store = createMemoryStore({ dir: path.join(dir, 'memory'), sanitizer: createSanitizer() })
    const config = parsed(base({ channelIds: [IDS.home, IDS.other] }, { memory: { notes: true } }))
    const r = await start(config, { noShim: true, door: { memory: store } })
    // A shim that keeps a note on the first turn it is given, and answers "ok" to every turn.
    const client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: r.brainToken, caps: { ...ECHO_CAPS, toolMap: { ...ECHO_CAPS.toolMap, memory_note: 'memory' } }, verdictTimeoutMs: 3000 })
    const heard: Envelope[] = []
    let first = true
    client.onMessage(async (msg: ToShim) => {
      if (msg.t !== 'turn') return
      heard.push(msg.env)
      if (first) {
        first = false
        const answer = await client.requestTool(msg.env.turnId, 'memory_note', { file: 'room', op: 'add', text: 'the seed swap is on Saturday' })
        expect(answer.allow).toBe(true)
      }
      client.send({ t: 'reply', turnId: msg.env.turnId, text: 'ok', attachments: [] })
      client.send({ t: 'settled', turnId: msg.env.turnId })
    })
    await r.door.shimConnected()

    say(r, { channel: IDS.home, text: 'note the swap' })
    await r.posts(1)
    say(r, { channel: IDS.other, author: IDS.admin, text: 'what do you know?' })
    await r.posts(2)
    say(r, { channel: IDS.strayThread, author: IDS.admin, text: 'and in this thread?' })
    await r.posts(3)
    say(r, { channel: IDS.home, text: 'and here?' })
    await r.posts(4)
    expect(heard.map((e) => e.room.id)).toEqual([IDS.home, IDS.other, IDS.strayThread, IDS.home])
    for (const e of heard.slice(1, 3)) expect(JSON.stringify(e)).not.toContain('seed swap')
    expect(heard[3].context.memory).toContain('the seed swap is on Saturday')
    expect(store.render(`discord:${IDS.home}`)).toContain('seed swap')
    expect(store.render(`discord:${IDS.other}`)).toBeUndefined()
    client.close()
  })
})
