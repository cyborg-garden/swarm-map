// @vitest-environment node
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { createBrainServer, type BrainServer, type ShimLink } from '../brain-server.ts'
import { encodeLine } from '../framing.ts'
import type { Capabilities, FromShim } from '../protocol.ts'
import { connectShim } from '../shim-client.ts'
import { ECHO_CAPS } from '../testing/echo-shim.ts'

armTripwire()

const TOKEN = 'cell-token-for-this-test'
let server: BrainServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  expect(tripwireAttempts()).toEqual([])
})

async function start(onShim: (link: ShimLink, caps: Capabilities) => void = () => {}) {
  const refused: string[] = []
  server = await createBrainServer({ token: TOKEN, onShim, onRefused: (why) => refused.push(why), helloTimeoutMs: 200 })
  return { port: server.port, refused }
}

function rawSocket(port: number): Promise<{ socket: net.Socket; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const closed = new Promise<void>((done) => socket.on('close', () => done()))
    socket.on('error', () => {})
    socket.on('connect', () => resolve({ socket, closed }))
    socket.once('error', reject)
  })
}

describe('brain server', () => {
  it('[P:hello-token] accepts a shim that says hello with the right token', async () => {
    const seen: Capabilities[] = []
    const { port, refused } = await start((_link, caps) => seen.push(caps))
    const shim = await connectShim({ host: '127.0.0.1', port, token: TOKEN, caps: ECHO_CAPS })
    await server!.connected()
    expect(seen).toEqual([ECHO_CAPS])
    expect(refused).toEqual([])
    shim.close()
  })

  it.each([['an empty token', ''], ['a token too short to be a secret', 'abc'], ['no token', undefined as unknown as string]])(
    '[P:hello-token] a brain server is not started with %s', async (_what, token) => {
      await expect(createBrainServer({ token, onShim: () => {} })).rejects.toThrow(/token/)
    })

  it('[P:hello-token] refuses a wrong token and hangs up', async () => {
    const seen: Capabilities[] = []
    const { port, refused } = await start((_link, caps) => seen.push(caps))
    const { socket, closed } = await rawSocket(port)
    socket.write(encodeLine({ t: 'hello', token: 'wrong', protocol: 1, caps: ECHO_CAPS } satisfies FromShim))
    await closed
    expect(seen).toEqual([])
    expect(refused).toEqual(['wrong token'])
  })

  it('[P:hello-token] refuses anything sent before hello, a wrong protocol, and silence', async () => {
    const { port, refused } = await start()
    const a = await rawSocket(port)
    a.socket.write(encodeLine({ t: 'reply', turnId: 't', text: 'hi', attachments: [] } satisfies FromShim))
    await a.closed
    const b = await rawSocket(port)
    b.socket.write(encodeLine({ t: 'hello', token: TOKEN, protocol: 2, caps: ECHO_CAPS }))
    await b.closed
    const c = await rawSocket(port)
    await c.closed // says nothing; the server hangs up after helloTimeoutMs
    expect(refused).toEqual(['first message was not hello', 'unsupported protocol 2', 'no hello in time'])
  })

  it('refuses a second shim while one is connected', async () => {
    const { port, refused } = await start()
    const first = await connectShim({ host: '127.0.0.1', port, token: TOKEN, caps: ECHO_CAPS })
    await server!.connected()
    const { socket, closed } = await rawSocket(port)
    socket.write(encodeLine({ t: 'hello', token: TOKEN, protocol: 1, caps: ECHO_CAPS } satisfies FromShim))
    await closed
    expect(refused).toEqual(['a shim is already connected'])
    first.close()
  })

  it('carries records both ways once connected', async () => {
    const got: FromShim[] = []
    let link: ShimLink | undefined
    const { port } = await start((l) => { link = l; l.onMessage((m) => got.push(m)) })
    const turns: string[] = []
    const shim = await connectShim({ host: '127.0.0.1', port, token: TOKEN, caps: ECHO_CAPS })
    shim.onMessage((m) => { if (m.t === 'cancel') turns.push(m.turnId) })
    await server!.connected()
    link!.send({ t: 'cancel', turnId: 't-9' })
    shim.send({ t: 'health', ok: true })
    await expect.poll(() => turns).toEqual(['t-9'])
    await expect.poll(() => got).toEqual([{ t: 'health', ok: true }])
    shim.close()
  })

  it('[P:no-verdict-is-no] a tool request with no verdict in time is a no', async () => {
    let link: ShimLink | undefined
    const asked: string[] = []
    const { port } = await start((l) => {
      link = l
      l.onMessage((m) => {
        if (m.t !== 'tool_request') return
        asked.push(m.tool)
        if (m.tool === 'answered-yes') l.send({ t: 'tool_verdict', callId: m.callId, allow: true })
        if (m.tool === 'answered-no') l.send({ t: 'tool_verdict', callId: m.callId, allow: false, reason: 'nope' })
        // 'silence' gets no verdict at all
      })
    })
    const shim = await connectShim({ host: '127.0.0.1', port, token: TOKEN, caps: ECHO_CAPS, verdictTimeoutMs: 80 })
    await server!.connected()
    expect(await shim.requestTool('t-1', 'answered-yes', {})).toEqual({ allow: true })
    expect(await shim.requestTool('t-1', 'answered-no', {})).toEqual({ allow: false, reason: 'nope' })
    expect(await shim.requestTool('t-1', 'silence', {})).toEqual({ allow: false, reason: 'no verdict in time' })
    expect(asked).toEqual(['answered-yes', 'answered-no', 'silence'])
    // A verdict that arrives after the timeout cannot turn the no into a yes.
    link!.send({ t: 'tool_verdict', callId: 'late', allow: true })
    shim.close()
  })

  it('[P:no-verdict-is-no] a lost link is a no', async () => {
    const { port } = await start()
    const shim = await connectShim({ host: '127.0.0.1', port, token: TOKEN, caps: ECHO_CAPS, verdictTimeoutMs: 5000 })
    await server!.connected()
    const pending = shim.requestTool('t-1', 'bash', {})
    await server!.close()
    server = undefined
    expect(await pending).toEqual({ allow: false, reason: 'link closed' })
  })
})
