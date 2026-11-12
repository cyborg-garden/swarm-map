// A shim with no harness behind it. It answers `echo: <text>`, and a message
// containing `!tool <name>` makes it ask to run that tool first. The door's
// plumbing tests use it so they need no Docker and no model.
//
// `mode` makes it misbehave on purpose, so tests can show the door holds when
// a shim does not keep its side of the protocol.
import type { Capabilities, Envelope } from '../protocol.ts'
import { connectShim, type ShimClient } from '../shim-client.ts'

export const ECHO_CAPS: Capabilities = {
  harness: 'echo',
  version: '0',
  ownsChat: false,
  toolVeto: 'pre-call',
  approvalRoundTrip: false,
  toolMap: { bash: 'shell', read: 'file_read', fetch: 'network' },
  modelBaseUrl: false,
  mcpClient: false,
  nativeMemory: 'none',
  sessions: 'many',
  steer: false,
  resume: false,
  usage: 'route-only',
  streaming: false,
}

export type EchoMode =
  | 'normal'
  | 'reply-twice'
  | 'reply-after-settled'
  | 'never-settle'
  | 'silent'
  | 'tool-without-asking'

export interface EchoShim {
  /** Every envelope the shim was given. This is `heard` for the plumbing tests. */
  heard: Envelope[]
  /** Tools the shim ran. This is `toolRan`. */
  toolsRan: { turnId: string; tool: string }[]
  /** Answers the shim got to its tool requests. */
  verdicts: { tool: string; allow: boolean; reason?: string }[]
  client: ShimClient
  mode: EchoMode
  close(): void
}

export async function startEchoShim(opts: {
  host?: string; port: number; token: string; verdictTimeoutMs?: number; mode?: EchoMode
}): Promise<EchoShim> {
  const client = await connectShim({
    host: opts.host ?? '127.0.0.1', port: opts.port, token: opts.token, caps: ECHO_CAPS,
    verdictTimeoutMs: opts.verdictTimeoutMs,
  })
  const shim: EchoShim = {
    heard: [], toolsRan: [], verdicts: [], client, mode: opts.mode ?? 'normal', close: () => client.close(),
  }

  const onTurn = async (env: Envelope): Promise<void> => {
    shim.heard.push(env)
    const { turnId } = env
    for (const [, tool] of env.text.matchAll(/!tool (\S+)/g)) {
      if (shim.mode === 'tool-without-asking') {
        shim.toolsRan.push({ turnId, tool })
        continue
      }
      const answer = await client.requestTool(turnId, tool, { from: 'echo' })
      shim.verdicts.push({ tool, ...answer })
      if (answer.allow) {
        shim.toolsRan.push({ turnId, tool })
        client.send({ t: 'tool_done', callId: `done-${turnId}-${tool}`, ok: true, summary: 'ran' })
      }
    }
    const reply = { t: 'reply' as const, turnId, text: `echo: ${env.text}`, attachments: [] }
    switch (shim.mode) {
      case 'silent':
        client.send({ t: 'settled', turnId })
        return
      case 'never-settle':
        client.send(reply)
        return
      case 'reply-after-settled':
        client.send({ t: 'settled', turnId })
        client.send(reply)
        return
      case 'reply-twice':
        client.send(reply)
        client.send({ ...reply, text: `second: ${env.text}` })
        client.send({ t: 'settled', turnId })
        return
      default:
        client.send(reply)
        client.send({ t: 'settled', turnId })
    }
  }

  client.onMessage((msg) => { if (msg.t === 'turn') void onTurn(msg.env) })
  return shim
}
