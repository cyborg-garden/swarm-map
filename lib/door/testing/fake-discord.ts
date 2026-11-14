// A fake Discord: one local server that speaks enough of the gateway and the
// REST API for the Discord connector to run against it. Loopback only. It is
// test equipment, and it has to prove it is a fake before anything uses it:
// assertFakeDiscord() refuses a real Discord address, a token that is not the
// one minted for this run, and a shell that carries a real-looking one.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

export class RefusingFakeDiscord extends Error {
  constructor(detail: string) {
    super(`REFUSING TO RUN: F7 ${detail}`)
    this.name = 'RefusingFakeDiscord'
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
/** The shape of a real bot token: three dotted parts. Never the fake's shape. */
const REAL_TOKEN = /[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/
/** Where the real launcher is told to find its secrets. A test run must not have them. */
export const SECRET_FILE_ENV = ['SMLAB_DISCORD_TOKEN_FILE', 'SMLAB_MODEL_KEY_FILE']

/** The server every fake channel is in unless it says otherwise. */
export const FAKE_GUILD = '7000000000000000001'

export const fakeDiscordToken = (nonce: string): string => `FAKEDISCORD-${nonce}`

/**
 * F7. Refuses unless everything says this is the fake: both addresses are
 * loopback, the token is this run's fake token, and the environment holds no
 * Discord token, no token-shaped value and no pointer to a real secret file.
 * Never prints a value.
 */
export function assertFakeDiscord(
  cfg: { apiBase: string; gatewayUrl: string; token: string; nonce: string },
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [what, address] of [['REST address', cfg.apiBase], ['gateway address', cfg.gatewayUrl]] as const) {
    let host: string
    try { host = new URL(address).hostname } catch { throw new RefusingFakeDiscord(`the Discord ${what} is not a URL`) }
    if (/(^|\.)(discord\.com|discordapp\.com|discord\.gg|discord\.media)$/i.test(host)) {
      throw new RefusingFakeDiscord(`the Discord ${what} is a real Discord host (${host})`)
    }
    if (!LOOPBACK.has(host)) throw new RefusingFakeDiscord(`the Discord ${what} is not on this machine (${host})`)
  }
  if (cfg.token !== fakeDiscordToken(cfg.nonce) || !/^[0-9a-f]{8}$/.test(cfg.nonce)) {
    throw new RefusingFakeDiscord('the bot token is not the fake token minted for this run (value not shown)')
  }
  const bad: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue
    if (SECRET_FILE_ENV.includes(name) || (/DISCORD/i.test(name) && /TOKEN|SECRET|KEY/i.test(name)) || REAL_TOKEN.test(value)) bad.push(name)
  }
  if (bad.length > 0) throw new RefusingFakeDiscord(`a real-looking Discord credential is in the environment: ${bad.sort().join(', ')} (values not shown)`)
}

export interface FakeAuthor { id: string; name?: string; bot?: boolean; roles?: string[]; nick?: string }
export interface FakePost {
  channel: string
  /** Leave out for a direct message. */
  guild?: string
  author: FakeAuthor
  content: string
  /** User ids Discord says were pinged. */
  mentions?: string[]
  /** The author of the message this one replies to. */
  replyTo?: string
  type?: number
  webhook?: boolean
  id?: string
}
export interface Posted { channel: string; content: string; allowedMentions: unknown; replyTo?: string }

export interface FakeDiscord {
  nonce: string
  apiBase: string
  gatewayUrl: string
  token: string
  selfId: string
  /** Channels and threads the gateway lists at connect, and REST knows about. */
  addChannel(c: { id: string; type?: number; parent?: string; listed?: boolean; guild?: string }): void
  /** Send a message to every connected bot. Returns its id. */
  post(m: FakePost): string
  edit(id: string, channel: string, opts?: { preview?: boolean; author?: string }): void
  remove(id: string, channel: string): void
  /** Every message the bot posted over REST. */
  posted: Posted[]
  /** Every REST request, as `METHOD path`. */
  requests: string[]
  identifies: { intents: number }[]
  resumes: number
  heartbeats: number
  unauthorized: number
  /** The next `count` posts are answered 429 with this wait. */
  rateLimit(count: number, retryAfterSec: number): void
  /** The next `count` posts are answered with this status. */
  failPosts(count: number, status: number): void
  /** The next `count` posts are kept, and then answered 502: the post happened, the answer was lost. */
  loseAnswers(count: number): void
  /** Close every gateway connection with this code. */
  drop(code: number): void
  /** Send a raw gateway payload to every connection. */
  sendOp(op: number, d?: unknown): void
  /** Stop answering heartbeats, as a dead connection would. */
  muteHeartbeats(mute: boolean): void
  /** Take identifies and say nothing back, as a gateway that never gets to ready. */
  holdReady(hold: boolean): void
  /** Refuse the next identify with this close code. */
  refuseIdentify(code: number): void
  connections(): number
  close(): Promise<void>
}

interface Conn { socket: Duplex; send(payload: unknown): void; close(code: number): void }

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
  return Buffer.concat([head, payload])
}

export async function startFakeDiscord(opts: { heartbeatMs?: number } = {}): Promise<FakeDiscord> {
  const nonce = randomBytes(4).toString('hex')
  const token = fakeDiscordToken(nonce)
  const selfId = '9000000000000000001'
  const sessionId = `sess-${nonce}`
  const channels = new Map<string, { id: string; type: number; parent_id?: string; listed: boolean; guild: string }>()
  const conns = new Set<Conn>()
  const sockets = new Set<Duplex>()
  /** Every dispatch sent, so a resume can replay what a connection missed. */
  const sent: { s: number; t: string; d: unknown }[] = []
  let seq = 0
  let nextId = 1000
  let limited = { count: 0, retryAfterSec: 0 }
  let failing = { count: 0, status: 500 }
  let losing = 0
  // As Discord does with `enforce_nonce`: a post that repeats a nonce in the same channel is not made again.
  const byNonce = new Map<string, string>()
  let mute = false
  let refuse: number | undefined
  let hold = false

  const fake = {
    nonce, token, selfId, posted: [] as Posted[], requests: [] as string[], identifies: [] as { intents: number }[],
    resumes: 0, heartbeats: 0, unauthorized: 0,
  }

  const dispatch = (t: string, d: unknown): void => {
    const s = ++seq
    sent.push({ s, t, d })
    for (const c of conns) c.send({ op: 0, t, s, d })
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://local')
      fake.requests.push(`${req.method} ${url.pathname}`)
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(body))
      }
      if (req.headers.authorization !== `Bot ${token}`) { fake.unauthorized++; return reply(401, { message: '401: Unauthorized' }) }
      const path = url.pathname.replace(/^\/api\/v10/, '')
      if (req.method === 'GET' && path === '/gateway/bot') return reply(200, { url: gatewayUrl })
      const ch = path.match(/^\/channels\/([^/]+)$/)
      if (req.method === 'GET' && ch) {
        const known = channels.get(decodeURIComponent(ch[1]))
        return known ? reply(200, { id: known.id, type: known.type, parent_id: known.parent_id, guild_id: known.guild }) : reply(404, { message: 'Unknown Channel' })
      }
      const msg = path.match(/^\/channels\/([^/]+)\/messages$/)
      if (req.method === 'POST' && msg) {
        if (limited.count > 0) {
          limited.count--
          return reply(429, { message: 'You are being rate limited.', retry_after: limited.retryAfterSec, global: false })
        }
        if (failing.count > 0) { failing.count--; return reply(failing.status, { message: 'no' }) }
        let body: { content?: string; allowed_mentions?: unknown; message_reference?: { message_id?: string }; nonce?: unknown; enforce_nonce?: unknown }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400, { message: 'bad json' }) }
        if (typeof body.content !== 'string' || body.content === '' || body.content.length > 2000) return reply(400, { message: 'Invalid Form Body' })
        const channel = decodeURIComponent(msg[1])
        const once = body.enforce_nonce === true && typeof body.nonce === 'string' && body.nonce !== '' && body.nonce.length <= 25 ? `${channel} ${body.nonce}` : undefined
        const made = once ? byNonce.get(once) : undefined
        if (made) return reply(200, { id: made, timestamp: new Date().toISOString() })
        fake.posted.push({ channel, content: body.content, allowedMentions: body.allowed_mentions, ...(body.message_reference?.message_id ? { replyTo: body.message_reference.message_id } : {}) })
        const id = String(++nextId)
        if (once) byNonce.set(once, id)
        if (losing > 0) { losing--; return reply(502, { message: 'bad gateway' }) }
        return reply(200, { id, timestamp: new Date().toISOString() })
      }
      reply(404, { message: '404: Not Found' })
    })
  })

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    if (!req.url?.startsWith('/gateway') || typeof key !== 'string') { socket.destroy(); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const conn: Conn = {
      socket,
      send: (payload) => { if (!socket.destroyed) socket.write(frame(1, Buffer.from(JSON.stringify(payload)))) },
      close: (code) => {
        if (socket.destroyed) return
        const b = Buffer.alloc(2); b.writeUInt16BE(code)
        socket.write(frame(8, b))
        socket.end()
        conns.delete(conn)
      },
    }
    let buf = Buffer.alloc(0)
    socket.on('error', () => {})
    sockets.add(socket)
    socket.on('close', () => { conns.delete(conn); sockets.delete(socket) })
    socket.on('data', (data: Buffer) => {
      buf = Buffer.concat([buf, data])
      for (;;) {
        if (buf.length < 2) return
        const opcode = buf[0] & 0x0f
        const masked = (buf[1] & 0x80) !== 0
        let len = buf[1] & 0x7f
        let at = 2
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4 }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10 }
        const maskAt = at
        if (masked) at += 4
        if (buf.length < at + len) return
        const payload = Buffer.from(buf.subarray(at, at + len))
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)]
        buf = buf.subarray(at + len)
        if (opcode === 8) { conn.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000); return }
        if (opcode === 9) { socket.write(frame(10, payload)); continue }
        if (opcode !== 1) continue
        let p: { op: number; d?: { token?: string; intents?: number; session_id?: string; seq?: number } }
        try { p = JSON.parse(payload.toString('utf8')) } catch { continue }
        if (p.op === 1) { fake.heartbeats++; if (!mute) conn.send({ op: 11 }); continue }
        if (p.op === 2) {
          if (p.d?.token !== token) { conn.close(4004); return }
          if (refuse !== undefined) { const code = refuse; refuse = undefined; conn.close(code); return }
          fake.identifies.push({ intents: Number(p.d.intents) })
          if (hold) continue
          conns.add(conn)
          conn.send({ op: 0, t: 'READY', s: ++seq, d: { user: { id: selfId }, session_id: sessionId, resume_gateway_url: gatewayUrl } })
          for (const guild of new Set([...channels.values()].map((c) => c.guild))) {
            const mine = [...channels.values()].filter((c) => c.listed && c.guild === guild)
            conn.send({ op: 0, t: 'GUILD_CREATE', s: ++seq, d: {
              id: guild,
              channels: mine.filter((c) => ![10, 11, 12].includes(c.type)),
              threads: mine.filter((c) => [10, 11, 12].includes(c.type)),
            } })
          }
          continue
        }
        if (p.op === 6) {
          if (p.d?.token !== token) { conn.close(4004); return }
          if (p.d.session_id !== sessionId) { conn.send({ op: 9, d: false }); continue }
          fake.resumes++
          conns.add(conn)
          for (const e of sent.filter((e) => e.s > (p.d?.seq ?? 0))) conn.send({ op: 0, t: e.t, s: e.s, d: e.d })
          conn.send({ op: 0, t: 'RESUMED', s: ++seq, d: {} })
        }
      }
    })
    conn.send({ op: 10, d: { heartbeat_interval: opts.heartbeatMs ?? 45_000 } })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const gatewayUrl = `ws://127.0.0.1:${port}/gateway`

  return Object.assign(fake, {
    apiBase: `http://127.0.0.1:${port}/api/v10`,
    gatewayUrl,
    addChannel(c: { id: string; type?: number; parent?: string; listed?: boolean; guild?: string }) {
      channels.set(c.id, { id: c.id, type: c.type ?? 0, ...(c.parent ? { parent_id: c.parent } : {}), listed: c.listed ?? true, guild: c.guild ?? FAKE_GUILD })
    },
    post(m: FakePost): string {
      const id = m.id ?? String(++nextId)
      dispatch('MESSAGE_CREATE', {
        id, type: m.type ?? (m.replyTo ? 19 : 0), channel_id: m.channel, ...(m.guild ? { guild_id: m.guild } : {}),
        author: { id: m.author.id, username: m.author.name ?? m.author.id, ...(m.author.bot ? { bot: true } : {}) },
        ...(m.guild ? { member: { roles: m.author.roles ?? [], ...(m.author.nick ? { nick: m.author.nick } : {}) } } : {}),
        ...(m.webhook ? { webhook_id: 'w-1' } : {}),
        content: m.content,
        mentions: (m.mentions ?? []).map((u) => ({ id: u })),
        ...(m.replyTo ? { referenced_message: { author: { id: m.replyTo } } } : {}),
        attachments: [], timestamp: new Date().toISOString(),
      })
      return id
    },
    edit(id: string, channel: string, o: { preview?: boolean; author?: string } = {}) {
      dispatch('MESSAGE_UPDATE', { id, channel_id: channel, author: { id: o.author ?? 'u-someone' }, edited_timestamp: o.preview ? null : new Date().toISOString() })
    },
    remove(id: string, channel: string) { dispatch('MESSAGE_DELETE', { id, channel_id: channel }) },
    rateLimit(count: number, retryAfterSec: number) { limited = { count, retryAfterSec } },
    failPosts(count: number, status: number) { failing = { count, status } },
    loseAnswers(count: number) { losing = count },
    drop(code: number) { for (const c of [...conns]) c.close(code) },
    sendOp(op: number, d?: unknown) { for (const c of conns) c.send({ op, d }) },
    muteHeartbeats(m: boolean) { mute = m },
    holdReady(h: boolean) { hold = h },
    refuseIdentify(code: number) { refuse = code },
    connections: () => conns.size,
    close: () => new Promise<void>((resolve) => {
      for (const socket of [...sockets]) socket.destroy()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  })
}
