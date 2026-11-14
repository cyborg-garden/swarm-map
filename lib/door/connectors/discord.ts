// The Discord connector: one gateway connection in, REST posts out.
//
// Like every connector it decides nothing. Every message it is sent becomes
// an event for the door, which asks decide(); every post is one the door
// already allowed, redacted and cut to size. This file holds the bot token,
// and uses it in two places only: the gateway identify and the REST
// Authorization header. It is never logged and never put in an error.
//
// No library: Node 24 has a WebSocket client and fetch built in, and the
// gateway is a small JSON protocol. That keeps a chat token out of the
// reach of any third-party package.
//
// What it asks Discord for (gateway intents):
//   GUILDS            the channel and thread list, to tell a thread from a channel
//   GUILD_MESSAGES    messages in server channels
//   MESSAGE_CONTENT   only when `messageContent` is set. Without it Discord
//                     still sends the text of messages that mention the bot,
//                     which is all a mention-only room needs.
// It never asks for direct messages, so none arrive. One that did would be
// passed to the door as a DM like any other event.
import { randomBytes } from 'node:crypto'
import type { Facts, RoomRef } from '../../core/events.ts'
import type { ConnectorInbound, InviteEvent, NoticeEvent, OutboundMessage, SendReceipt, SurfaceConnector } from '../connector.ts'

export const DISCORD_API = 'https://discord.com/api/v10'
export const INTENTS = { GUILDS: 1 << 0, GUILD_MESSAGES: 1 << 9, MESSAGE_CONTENT: 1 << 15 } as const
/** Discord's limit on one message. */
export const MAX_MESSAGE_CHARS = 2000

export interface DiscordOptions {
  /** REST base. Default: Discord's own. */
  apiBase?: string
  /** Gateway URL. Default: whatever the REST API says it is. */
  gatewayUrl?: string
  /**
   * The one server this bot is for. When set, the channels of any other
   * server are not learned, so a message there reaches the door as a bare
   * room with no parent or category to borrow an approval from.
   */
  guildId?: string
  /** Ask for the text of messages that do not mention the bot. A privileged intent: it must also be switched on for the application. */
  messageContent?: boolean
  /**
   * The channels send() may post to. A thread counts by its parent. A post
   * anywhere else throws before any request is made, whatever the caller
   * says. The door has its own check; this is the second one.
   */
  sendScope: string[]
  /** State changes, as plain lines. Never a token, never message text. */
  log?: (line: string) => void
  /** Called once if Discord closes the gateway for good (a bad token, an intent that is not switched on). */
  onFatal?: (code: number) => void
  reconnect?: { firstMs: number; maxMs: number }
  readyTimeoutMs?: number
  /** A rate limit longer than this fails the post instead of holding it. */
  maxRateLimitWaitMs?: number
  restTimeoutMs?: number
}

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Close codes that end the session, so the next connection must identify afresh. */
const SESSION_GONE = new Set([4007, 4009])
/** Our own close codes. In the 4xxx range so Discord keeps the session for a resume. */
const CLOSE = { reconnect: 4900, invalid: 4901, zombie: 4902 } as const
const THREAD_TYPES = new Set([10, 11, 12])
/** A person's message, or a reply. Joins, pins and the like are not messages to answer. */
const MESSAGE_TYPES = new Set([0, 19])

interface Channel { type: number; parent?: string }
interface Payload { op: number; d?: unknown; s?: number | null; t?: string | null }
/* eslint-disable @typescript-eslint/no-explicit-any -- gateway payloads are read field by field, each checked where it is used */
type Raw = Record<string, any>

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Cut text into pieces Discord will take, at a line or a space where there is one. */
export function chunk(text: string, max = MAX_MESSAGE_CHARS): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max)
    if (at < max / 2) at = rest.lastIndexOf(' ', max)
    if (at < max / 2) at = max
    // Never between the two halves of one character.
    if (at === max && /[\uD800-\uDBFF]/.test(rest[at - 1])) at--
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^[ \n]/, '')
  }
  if (rest.trim() !== '') out.push(rest)
  return out
}

export function createDiscordConnector(opts: DiscordOptions): SurfaceConnector {
  const apiBase = (opts.apiBase ?? DISCORD_API).replace(/\/$/, '')
  const scope = new Set(opts.sendScope)
  const log = opts.log ?? (() => {})
  const backoff = opts.reconnect ?? { firstMs: 1000, maxMs: 60_000 }
  const maxWait = opts.maxRateLimitWaitMs ?? 30_000
  const listeners: ((e: ConnectorInbound | InviteEvent | NoticeEvent) => void)[] = []
  const channels = new Map<string, Channel | null>()
  const seen = new Set<string>()

  let token = ''
  let gatewayUrl = opts.gatewayUrl
  let ws: WebSocket | undefined
  let selfId: string | undefined
  let session: { id: string; url: string } | undefined
  let seq: number | null = null
  let beat: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let acked = true
  let attempts = 0
  let closed = false
  let dead = false
  let ready = false
  let first: { resolve: () => void; reject: (err: Error) => void } | undefined
  // Messages are handed on in the order they came, even when one has to wait for a channel lookup.
  let line: Promise<void> = Promise.resolve()
  // Posts to one channel go one at a time, so the pieces of a long reply stay in order.
  const posting = new Map<string, Promise<unknown>>()
  const holdUntil = new Map<string, number>()

  const emit = (e: ConnectorInbound | NoticeEvent): void => { for (const cb of listeners) cb(e) }

  async function rest(method: string, path: string, body?: unknown): Promise<{ json: Raw; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          'user-agent': 'DiscordBot (swarm-door, 1)',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.restTimeoutMs ?? 15_000),
      })
      if (res.status === 429 && attempt < 3) {
        const told = (await res.json().catch(() => ({}))) as Raw
        const seconds = typeof told.retry_after === 'number' ? told.retry_after : Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : maxWait + 1
        if (wait > maxWait) throw new Error(`discord: rate limited for longer than this connector will wait (${method})`)
        log(`discord: rate limited, waiting ${Math.ceil(wait)}ms`)
        await sleep(wait)
        continue
      }
      if (res.status >= 500 && attempt < 2) { await sleep(250 * (attempt + 1)); continue }
      // The status only. A body could repeat what was sent.
      if (!res.ok) throw new Error(`discord: ${method} failed with status ${res.status}`)
      return { json: (await res.json().catch(() => ({}))) as Raw, headers: res.headers }
    }
  }

  const sendOp = (op: number, d: unknown): void => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }))
  }

  function stopBeat(): void {
    if (beat) clearTimeout(beat)
    beat = undefined
  }
  function startBeat(intervalMs: number): void {
    stopBeat()
    acked = true
    const tick = (): void => {
      // No answer to the last heartbeat: the connection is dead but does not know it.
      if (!acked) { ws?.close(CLOSE.zombie, 'no heartbeat ack'); return }
      acked = false
      sendOp(1, seq)
      beat = setTimeout(tick, intervalMs)
    }
    beat = setTimeout(tick, intervalMs * Math.random())
  }

  function open(): void {
    if (closed || dead) return
    const base = (session?.url ?? gatewayUrl ?? '').replace(/\/$/, '')
    const socket = new WebSocket(`${base}/?v=10&encoding=json`)
    ws = socket
    socket.onmessage = (ev) => {
      if (ws !== socket) return
      let p: Payload
      try { p = JSON.parse(String(ev.data)) as Payload } catch { return }
      onPayload(p)
    }
    socket.onerror = () => {} // a close always follows
    socket.onclose = (ev) => { if (ws === socket) onClose(ev.code) }
  }

  function onClose(code: number): void {
    stopBeat()
    ws = undefined
    ready = false
    if (closed) return
    if (FATAL_CLOSE.has(code)) {
      dead = true
      log(`discord: the gateway closed for good (code ${code})`)
      first?.reject(new Error(`discord: the gateway refused this bot (close code ${code})`))
      first = undefined
      opts.onFatal?.(code)
      return
    }
    if (SESSION_GONE.has(code) || code === 1000 || code === 1001) { session = undefined; seq = null }
    const wait = Math.min(backoff.maxMs, backoff.firstMs * 2 ** attempts) * (0.5 + Math.random() / 2)
    attempts++
    log(`discord: gateway closed (code ${code}), reconnecting in ${Math.ceil(wait)}ms`)
    retry = setTimeout(open, wait)
  }

  function onPayload(p: Payload): void {
    if (typeof p.s === 'number') seq = p.s
    switch (p.op) {
      case 10: { // hello
        startBeat(Number((p.d as Raw)?.heartbeat_interval) || 41_250)
        if (session && seq !== null) sendOp(6, { token, session_id: session.id, seq })
        else {
          const intents = INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | (opts.messageContent ? INTENTS.MESSAGE_CONTENT : 0)
          sendOp(2, { token, intents, properties: { os: process.platform, browser: 'swarm-door', device: 'swarm-door' } })
        }
        return
      }
      case 11: acked = true; return
      case 1: sendOp(1, seq); return
      case 7: ws?.close(CLOSE.reconnect, 'asked to reconnect'); return
      case 9: { // invalid session; `d` says whether it can be resumed
        if (p.d !== true) { session = undefined; seq = null }
        ws?.close(CLOSE.invalid, 'invalid session')
        return
      }
      case 0: onDispatch(p.t ?? '', (p.d ?? {}) as Raw); return
      default: return
    }
  }

  const elsewhere = (guild: unknown): boolean => opts.guildId !== undefined && guild !== opts.guildId
  let warned = false
  const remember = (c: Raw, guild: unknown = c?.guild_id): void => {
    const id = str(c?.id)
    if (!id || typeof c.type !== 'number') return
    if (elsewhere(guild)) {
      channels.set(id, null)
      if (!warned) log('discord: this bot is also in a server it was not started for. Nothing there is learned or answered.')
      warned = true
      return
    }
    channels.set(id, { type: c.type, parent: str(c.parent_id) })
  }

  function onDispatch(t: string, d: Raw): void {
    switch (t) {
      case 'READY': {
        selfId = str(d.user?.id)
        const id = str(d.session_id)
        session = id ? { id, url: str(d.resume_gateway_url) ?? gatewayUrl ?? '' } : undefined
        attempts = 0
        ready = selfId !== undefined
        log('discord: connected')
        if (ready) first?.resolve()
        else first?.reject(new Error('discord: the gateway did not say who this bot is'))
        first = undefined
        return
      }
      case 'RESUMED': attempts = 0; ready = selfId !== undefined; log('discord: resumed'); return
      case 'GUILD_CREATE':
        for (const c of Array.isArray(d.channels) ? d.channels : []) remember(c, d.id)
        for (const c of Array.isArray(d.threads) ? d.threads : []) remember(c, d.id)
        return
      case 'THREAD_LIST_SYNC': for (const c of Array.isArray(d.threads) ? d.threads : []) remember(c, d.guild_id); return
      case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': case 'THREAD_CREATE': case 'THREAD_UPDATE': remember(d); return
      case 'CHANNEL_DELETE': case 'THREAD_DELETE': { const id = str(d.id); if (id) channels.delete(id); return }
      case 'MESSAGE_CREATE': line = line.then(() => onMessage(d)).catch(() => {}); return
      case 'MESSAGE_UPDATE': {
        // Discord also sends an update when it adds a link preview. Only a person's edit carries a time.
        const id = str(d.id); const room = str(d.channel_id)
        if (id && room && d.edited_timestamp && d.author?.id !== selfId) {
          line = line.then(() => emit({ kind: 'notice', what: 'edit', surface: 'discord', room, messageId: id }))
        }
        return
      }
      case 'MESSAGE_DELETE': case 'MESSAGE_DELETE_BULK': {
        const room = str(d.channel_id)
        const ids = t === 'MESSAGE_DELETE' ? [d.id] : Array.isArray(d.ids) ? d.ids : []
        for (const raw of ids) {
          const id = str(raw)
          if (id && room) line = line.then(() => emit({ kind: 'notice', what: 'delete', surface: 'discord', room, messageId: id }))
        }
        return
      }
      default: return
    }
  }

  async function channelOf(id: string): Promise<Channel | undefined> {
    if (channels.has(id)) return channels.get(id) ?? undefined
    // Not in what the gateway listed (an old thread woken up, say). Ask once.
    try { remember((await rest('GET', `/channels/${encodeURIComponent(id)}`)).json) } catch { /* stays unknown */ }
    if (!channels.has(id)) channels.set(id, null)
    return channels.get(id) ?? undefined
  }

  async function roomOf(m: Raw): Promise<RoomRef> {
    const id = String(m.channel_id)
    // No server on the message means a direct message, and is treated as one whatever else it says.
    if (!str(m.guild_id)) return { id, kind: 'dm' }
    if (elsewhere(m.guild_id)) return { id, kind: 'channel' }
    const ch = await channelOf(id)
    // A channel nothing is known about is passed on bare: it has no parent to borrow an approval from.
    if (!ch) return { id, kind: 'channel' }
    if (THREAD_TYPES.has(ch.type)) {
      const category = ch.parent ? (await channelOf(ch.parent))?.parent : undefined
      return { id, kind: 'thread', ...(ch.parent ? { parentId: ch.parent } : {}), ...(category ? { categoryId: category } : {}) }
    }
    return { id, kind: 'channel', ...(ch.parent ? { categoryId: ch.parent } : {}) }
  }

  async function onMessage(m: Raw): Promise<void> {
    const messageId = str(m.id)
    const authorId = str(m.author?.id)
    if (!messageId || !authorId || !str(m.channel_id) || !selfId) return
    if (!MESSAGE_TYPES.has(m.type)) return
    // A resume replays what was missed, and may replay what was not.
    if (seen.has(messageId)) return
    seen.add(messageId)
    if (seen.size > 2000) seen.delete(seen.values().next().value as string)

    const text = typeof m.content === 'string' ? m.content : ''
    const mentions: Raw[] = Array.isArray(m.mentions) ? m.mentions : []
    const room = await roomOf(m)
    emit({
      kind: 'inbound', surface: 'discord', messageId, room,
      sender: {
        // A webhook is not a member, and what it gives as its id is not a member's id. It is kept apart,
        // so it can never be taken for a person or a bot that is on a list.
        id: m.webhook_id !== undefined ? `webhook:${authorId}` : authorId,
        display: str(m.member?.nick) ?? str(m.author.global_name) ?? str(m.author.username) ?? authorId,
        // A webhook's post is not a person's, whatever it calls itself.
        isBot: m.author.bot === true || m.webhook_id !== undefined,
        isSelf: authorId === selfId,
        roles: Array.isArray(m.member?.roles) ? m.member.roles.filter((r: unknown): r is string => typeof r === 'string') : [],
      },
      isDm: room.kind === 'dm',
      // The bot itself was pinged. @everyone and role pings are not a mention of the bot.
      mention: mentions.some((u) => u?.id === selfId),
      inlineMention: text.includes(`<@${selfId}>`) || text.includes(`<@!${selfId}>`),
      replyToAgent: m.referenced_message?.author?.id === selfId,
      text,
      attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a: Raw) => ({
        id: String(a?.id ?? ''), name: String(a?.filename ?? ''), bytes: Number(a?.size) || 0,
      })),
    })
  }

  async function post(room: RoomRef, text: string, inReplyTo?: string): Promise<SendReceipt> {
    let last: SendReceipt | undefined
    for (const [i, piece] of chunk(text).entries()) {
      const wait = (holdUntil.get(room.id) ?? 0) - Date.now()
      if (wait > maxWait) throw new Error('discord: rate limited for longer than this connector will wait (POST)')
      if (wait > 0) await sleep(wait)
      const { json, headers } = await rest('POST', `/channels/${encodeURIComponent(room.id)}/messages`, {
        content: piece,
        // One name for this piece, kept across retries. If a post was made and only its answer
        // was lost, Discord returns that post instead of making it a second time.
        nonce: randomBytes(12).toString('hex'), enforce_nonce: true,
        // Nothing the model writes can ping a person, a role or everyone, and a reply pings nobody either.
        allowed_mentions: { parse: [], replied_user: false },
        // The first piece sits under the message it answers. If that message is gone, it is posted plainly.
        ...(i === 0 && inReplyTo ? { message_reference: { message_id: inReplyTo, fail_if_not_exists: false } } : {}),
      })
      if (headers.get('x-ratelimit-remaining') === '0') {
        const after = Number(headers.get('x-ratelimit-reset-after'))
        if (Number.isFinite(after) && after > 0) holdUntil.set(room.id, Date.now() + after * 1000)
      }
      last = { id: String(json.id ?? ''), ts: str(json.timestamp) ?? new Date().toISOString() }
    }
    if (!last) throw new Error('discord: there was nothing to post')
    return last
  }

  return {
    id: 'discord',
    async connect(creds) {
      if (!creds.token) throw new Error('discord: no bot token was given')
      token = creds.token
      closed = false
      if (!gatewayUrl) gatewayUrl = str((await rest('GET', '/gateway/bot')).json.url)
      if (!gatewayUrl || !/^wss?:\/\//.test(gatewayUrl)) throw new Error('discord: no gateway address')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          first = undefined
          reject(new Error('discord: the gateway did not say ready in time'))
        }, opts.readyTimeoutMs ?? 30_000)
        first = {
          resolve: () => { clearTimeout(timer); resolve() },
          reject: (err) => { clearTimeout(timer); reject(err) },
        }
        open()
      }).catch((err) => { closed = true; ws?.close(1000); throw err })
    },
    onEvent(cb) { listeners.push(cb) },
    send(room: RoomRef, msg: OutboundMessage): Promise<SendReceipt> {
      if (!ready) return Promise.reject(new Error('discord: not connected'))
      const home = room.kind === 'thread' ? room.parentId : room.id
      if (room.kind === 'dm' || room.kind === 'group' || home === undefined || !scope.has(home)) {
        return Promise.reject(new Error('discord: refusing to post outside the channels this connector was started for'))
      }
      const turn = (posting.get(room.id) ?? Promise.resolve()).catch(() => {}).then(() => post(room, msg.text, msg.inReplyTo))
      posting.set(room.id, turn)
      return turn
    },
    // Roles ride on each message as Discord sent it, so there is nothing more to look up.
    async facts(): Promise<Facts> { return {} },
    async close() {
      closed = true
      ready = false
      stopBeat()
      if (retry) clearTimeout(retry)
      first?.reject(new Error('discord: closed'))
      first = undefined
      const socket = ws
      ws = undefined
      socket?.close(1000)
    },
  }
}
