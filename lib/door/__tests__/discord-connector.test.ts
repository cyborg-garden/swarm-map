// @vitest-environment node
//
// The Discord connector on its own, against the fake Discord: what it turns
// a gateway message into, how it posts, and how it copes with rate limits and
// a gateway that drops. Loopback only: the tripwire is armed and must record
// nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import type { ConnectorInbound, InviteEvent, NoticeEvent, SurfaceConnector } from '../connector.ts'
import { chunk, createDiscordConnector, DISCORD_API, type DiscordOptions } from '../connectors/discord.ts'
import { IDS, startDiscordRig } from '../testing/discord-rig.ts'
import { assertFakeDiscord, fakeDiscordToken, startFakeDiscord, type FakeDiscord } from '../testing/fake-discord.ts'

armTripwire()

type Seen = ConnectorInbound | InviteEvent | NoticeEvent
interface Bench { fake: FakeDiscord; connector: SurfaceConnector; events: Seen[]; logs: string[]; fatal: number[] }
let bench: Bench | undefined
afterEach(async () => {
  await bench?.connector.close()
  await bench?.fake.close()
  bench = undefined
  expect(tripwireAttempts()).toEqual([])
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!what() && Date.now() < end) await sleep(5)
  expect(what()).toBe(true)
}

async function start(opts: Partial<DiscordOptions> & { heartbeatMs?: number; connect?: boolean } = {}): Promise<Bench> {
  const { heartbeatMs, connect = true, ...connectorOpts } = opts
  const fake = await startFakeDiscord({ heartbeatMs })
  assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce })
  fake.addChannel({ id: IDS.home })
  fake.addChannel({ id: IDS.thread, type: 11, parent: IDS.home })
  const b: Bench = { fake, events: [], logs: [], fatal: [], connector: undefined as never }
  b.connector = createDiscordConnector({
    apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, sendScope: [IDS.home], guildId: IDS.guild,
    log: (l) => b.logs.push(l), onFatal: (code) => b.fatal.push(code),
    reconnect: { firstMs: 5, maxMs: 20 }, readyTimeoutMs: 1500, maxRateLimitWaitMs: 300, ...connectorOpts,
  })
  b.connector.onEvent((e) => b.events.push(e))
  bench = b
  if (connect) await b.connector.connect({ token: fake.token })
  return b
}
const home = { id: IDS.home, kind: 'channel' as const }
const inbound = (b: Bench): ConnectorInbound[] => b.events.filter((e): e is ConnectorInbound => e.kind === 'inbound')

describe('fake Discord: it has to prove it is a fake', () => {
  const nonce = '0badf00d'
  const good = { apiBase: 'http://127.0.0.1:1/api/v10', gatewayUrl: 'ws://127.0.0.1:1/gateway', token: fakeDiscordToken(nonce), nonce }
  // Built here, not written down, so the repo's secret scanner has nothing to stop on.
  const realLooking = ['M'.repeat(26), 'abcdef', 'x'.repeat(30)].join('.')

  it('accepts the fake on loopback with this run\'s token and a clean environment', () => {
    expect(() => assertFakeDiscord(good, {})).not.toThrow()
  })

  it.each([
    ['the real REST host', { apiBase: DISCORD_API }, /real Discord host \(discord\.com\)/],
    ['the real gateway host', { gatewayUrl: 'wss://gateway.discord.gg' }, /real Discord host \(gateway\.discord\.gg\)/],
    ['a host that is not this machine', { apiBase: 'http://192.0.2.7/api/v10' }, /not on this machine/],
    ['a name that only looks local', { gatewayUrl: 'ws://localhost.example.com/gateway' }, /not on this machine/],
    ['something that is not a URL', { apiBase: 'discord' }, /not a URL/],
    ['a token from another run', { token: fakeDiscordToken('deadbeef') }, /not the fake token/],
    ['a real-looking token', { token: realLooking }, /not the fake token/],
  ])('refuses %s', (_name, patch, why) => {
    expect(() => assertFakeDiscord({ ...good, ...patch }, {})).toThrow(/^REFUSING TO RUN: F7 /)
    expect(() => assertFakeDiscord({ ...good, ...patch }, {})).toThrow(why)
  })

  it.each([
    ['a bot token variable', { DISCORD_BOT_TOKEN: 'x' }, 'DISCORD_BOT_TOKEN'],
    ['the launcher\'s token file variable', { SMLAB_DISCORD_TOKEN_FILE: '/somewhere' }, 'SMLAB_DISCORD_TOKEN_FILE'],
    ['the launcher\'s model key file variable', { SMLAB_MODEL_KEY_FILE: '/somewhere' }, 'SMLAB_MODEL_KEY_FILE'],
    ['a token-shaped value under any name', { HARMLESS: realLooking }, 'HARMLESS'],
  ])('refuses an environment that holds %s, and never prints the value', (_name, env, named) => {
    let message = ''
    try { assertFakeDiscord(good, env) } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/^REFUSING TO RUN: F7 a real-looking Discord credential/)
    expect(message).toContain(named)
    for (const value of Object.values(env)) expect(message).not.toContain(value)
  })

  it('the rig does not start, and nothing connects, when the environment holds a real-looking token', async () => {
    const { policyFor, parseConfig } = await import('../../lab/pi-discord/config.ts')
    const { config } = parseConfig({
      agentId: 'pi-lab', discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin] },
      budget: { monthlyUsd: 1 }, model: { baseUrl: 'https://model.example/v1', id: 'm', usdPerMTokIn: 1, usdPerMTokOut: 1 },
    })
    await expect(startDiscordRig(policyFor(config!), { env: { DISCORD_TOKEN: realLooking } })).rejects.toThrow(/REFUSING TO RUN: F7/)
  })

  it('the fake refuses a bot that does not hold this run\'s token, on REST and on the gateway', async () => {
    const b = await start({ connect: false })
    await expect(b.connector.connect({ token: fakeDiscordToken('deadbeef') })).rejects.toThrow(/refused this bot \(close code 4004\)/)
    expect(b.fake.identifies).toEqual([])
    expect(b.fatal).toEqual([4004])
    // No retry after a refusal that cannot get better.
    await sleep(80)
    expect(b.fake.connections()).toBe(0)
    const viaRest = createDiscordConnector({ apiBase: b.fake.apiBase, sendScope: [IDS.home] })
    const err = await viaRest.connect({ token: realLooking }).catch((e: Error) => e)
    expect((err as Error).message).toBe('discord: GET failed with status 401')
    expect(b.fake.unauthorized).toBe(1)
    expect(JSON.stringify([b.logs, (err as Error).message])).not.toContain(realLooking)
  })
})

describe('Discord connector: what a message becomes', () => {
  it('a mention, a reply-ping and plain talk are told apart, with roles and a display name from the server', async () => {
    const b = await start()
    const self = b.fake.selfId
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member, name: 'mem', nick: 'Mem', roles: [IDS.role] }, content: `<@${self}> hi`, mentions: [self] })
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member, name: 'mem' }, content: 'replying', mentions: [self], replyTo: self })
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: '@everyone look', mentions: [] })
    b.fake.post({ channel: IDS.thread, guild: IDS.guild, author: { id: IDS.bot, bot: true }, content: `<@!${self}> beep`, mentions: [] })
    await until(() => inbound(b).length === 4)
    const [a, r, e, t] = inbound(b)
    expect(a).toMatchObject({
      surface: 'discord', room: { id: IDS.home, kind: 'channel' }, isDm: false, mention: true, inlineMention: true, replyToAgent: false,
      sender: { id: IDS.member, display: 'Mem', isBot: false, isSelf: false, roles: [IDS.role] },
    })
    expect(r).toMatchObject({ mention: true, inlineMention: false, replyToAgent: true, sender: { display: 'mem', roles: [] } })
    expect(e).toMatchObject({ mention: false, inlineMention: false, replyToAgent: false })
    expect(t).toMatchObject({ room: { id: IDS.thread, kind: 'thread', parentId: IDS.home }, inlineMention: true, sender: { isBot: true } })
  })

  it('joins, pins and other system messages are not messages', async () => {
    const b = await start()
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: '', type: 7 })
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'real' })
    await until(() => inbound(b).length === 1)
    expect(inbound(b)[0].text).toBe('real')
  })

  it('edits and deletes arrive as notices with ids only; the bot\'s own edits do not', async () => {
    const b = await start()
    b.fake.edit('555', IDS.home)
    b.fake.edit('556', IDS.home, { author: b.fake.selfId })
    b.fake.remove('555', IDS.home)
    await until(() => b.events.length === 2)
    expect(b.events).toEqual([
      { kind: 'notice', what: 'edit', surface: 'discord', room: IDS.home, messageId: '555' },
      { kind: 'notice', what: 'delete', surface: 'discord', room: IDS.home, messageId: '555' },
    ])
  })

  it('a message sent twice is passed on once', async () => {
    const b = await start()
    b.fake.post({ id: '777', channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'once' })
    b.fake.post({ id: '777', channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'once' })
    b.fake.post({ id: '778', channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'next' })
    await until(() => inbound(b).length === 2)
    expect(inbound(b).map((e) => e.messageId)).toEqual(['777', '778'])
  })
})

describe('Discord connector: the gateway', () => {
  it('keeps the connection alive with heartbeats', async () => {
    const b = await start({ heartbeatMs: 20 })
    await until(() => b.fake.heartbeats >= 3)
  })

  it('a dropped connection is resumed, and what was said meanwhile arrives once', async () => {
    const b = await start()
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'before' })
    await until(() => inbound(b).length === 1)
    b.fake.drop(4000)
    b.fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: 'while down' })
    await until(() => b.fake.resumes === 1)
    await until(() => inbound(b).length === 2)
    await sleep(50)
    expect(inbound(b).map((e) => e.text)).toEqual(['before', 'while down'])
    expect(b.fake.identifies).toHaveLength(1)
    // And it can post again.
    await b.connector.send(home, { text: 'back' })
    expect(b.fake.posted).toHaveLength(1)
  })

  it('reconnects when Discord asks it to, and identifies afresh when the session is gone', async () => {
    const b = await start()
    b.fake.sendOp(7)
    await until(() => b.fake.resumes === 1)
    b.fake.sendOp(9, false)
    await until(() => b.fake.identifies.length === 2)
    expect(b.fatal).toEqual([])
  })

  it('a connection that stops answering heartbeats is given up on and replaced', async () => {
    const b = await start({ heartbeatMs: 25 })
    b.fake.muteHeartbeats(true)
    await until(() => b.fake.resumes >= 1)
    b.fake.muteHeartbeats(false)
    expect(b.logs.join('\n')).toContain('code 4902')
  })

  it('once closed it does not reconnect, and it does not post', async () => {
    const b = await start()
    await b.connector.close()
    await sleep(80)
    expect(b.fake.connections()).toBe(0)
    expect(b.fake.identifies).toHaveLength(1)
    await expect(b.connector.send(home, { text: 'x' })).rejects.toThrow(/not connected/)
  })

  it('a gateway that never says ready fails the connect, and the connector then gives up for good', async () => {
    const b = await start({ connect: false, readyTimeoutMs: 100 })
    b.fake.holdReady(true)
    await expect(b.connector.connect({ token: b.fake.token })).rejects.toThrow(/did not say ready in time/)
    await sleep(150)
    expect(b.fake.identifies).toHaveLength(1)
    await expect(b.connector.send(home, { text: 'x' })).rejects.toThrow(/not connected/)
  })
})

describe('Discord connector: posting', () => {
  it('waits out a short rate limit and posts once', async () => {
    const b = await start()
    b.fake.rateLimit(2, 0.03)
    await b.connector.send(home, { text: 'patient' })
    expect(b.fake.posted.map((p) => p.content)).toEqual(['patient'])
    expect(b.logs.filter((l) => l.includes('rate limited'))).toHaveLength(2)
  })

  it('a rate limit longer than it will wait fails the post, and posts nothing', async () => {
    const b = await start()
    b.fake.rateLimit(1, 30)
    await expect(b.connector.send(home, { text: 'too slow' })).rejects.toThrow(/rate limited for longer/)
    expect(b.fake.posted).toEqual([])
  })

  it('retries a server error, and reports a refusal by its status alone', async () => {
    const b = await start()
    b.fake.failPosts(1, 502)
    await b.connector.send(home, { text: 'second try' })
    expect(b.fake.posted).toHaveLength(1)
    b.fake.failPosts(1, 403)
    await expect(b.connector.send(home, { text: 'SECRET-TEXT' })).rejects.toThrow('discord: POST failed with status 403')
  })

  it('a post whose answer was lost is tried again, and is still posted once', async () => {
    const b = await start()
    b.fake.loseAnswers(1)
    await b.connector.send(home, { text: 'said once' })
    expect(b.fake.requests.filter((r) => r.startsWith('POST'))).toHaveLength(2)
    expect(b.fake.posted.map((p) => p.content)).toEqual(['said once'])
    // Each piece is a post of its own: the same words said twice on purpose are two posts.
    await b.connector.send(home, { text: 'said once' })
    expect(b.fake.posted).toHaveLength(2)
  })

  it('the pieces of a long reply arrive in order, and a reply with nothing in it is not posted', async () => {
    const b = await start()
    const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n')
    await Promise.all([b.connector.send(home, { text: long }), b.connector.send(home, { text: 'after' })])
    expect(b.fake.posted.length).toBeGreaterThan(3)
    expect(b.fake.posted.slice(0, -1).map((p) => p.content).join('\n')).toBe(long)
    expect(b.fake.posted.at(-1)?.content).toBe('after')
    await expect(b.connector.send(home, { text: '  \n ' })).rejects.toThrow(/nothing to post/)
  })

  it('[U:discord-chunk] chunk() never makes a piece too long, loses nothing, and never splits a character', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('short')).toEqual(['short'])
    const words = 'word '.repeat(1000)
    for (const piece of chunk(words, 100)) expect(piece.length).toBeLessThanOrEqual(100)
    expect(chunk(words, 100).join(' ').replace(/\s+/g, ' ').trim()).toBe(words.trim())
    const emoji = '😀'.repeat(150)
    const pieces = chunk(emoji, 101)
    expect(pieces.join('')).toBe(emoji)
    for (const piece of pieces) { expect(piece.length).toBeLessThanOrEqual(101); expect(piece.length % 2).toBe(0) }
    expect(chunk('x'.repeat(250), 100).map((p) => p.length)).toEqual([100, 100, 50])
  })
})
