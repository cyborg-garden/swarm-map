// A scripted ACP agent, for the client's unit tests: a small program that
// speaks JSON-RPC over stdio and does exactly what its script says, nothing
// more. No model and no tools. It writes every answer it is given to a log
// file, so a test can see what the client told it.
//
//   node scripted-agent.ts <script.json>
//
// Script: { agentInfo?, loadSession?, steps: Step[] }. With loadSession it can open a session again. On each `session/prompt` it plays
// every step in order, then ends the turn with `end_turn`.
//   { "update": {...} }                         sends a session/update
//   { "ask": { toolCall, options? } }           sends session/request_permission, waits, logs the answer
//   { "call": { method, params } }              sends any other request to the client, waits, logs the answer
//   { "say": "text" }                           sends an agent_message_chunk
//   { "late": {...} }                           sends a session/update after the turn has ended
import { appendFileSync, readFileSync } from 'node:fs'

interface Step { late?: Record<string, unknown>; update?: Record<string, unknown>; ask?: { toolCall: Record<string, unknown>; options?: unknown[] }; call?: { method: string; params: unknown }; say?: string }
const script = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { agentInfo?: { name: string; version: string }; steps: Step[]; log: string; loadSession?: boolean }

const ONCE_ALWAYS_REJECT = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  { optionId: 'never', kind: 'reject_always', name: 'Always reject' },
]

const send = (m: unknown): void => { process.stdout.write(JSON.stringify(m) + '\n') }
const log = (entry: unknown): void => appendFileSync(script.log, JSON.stringify(entry) + '\n')
let next = 1000
const waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>()
const request = (method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> => new Promise((resolve) => {
  const id = next++
  waiting.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})

let sessionId = ''
async function play(): Promise<void> {
  for (const step of script.steps) {
    if (step.update) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: step.update } })
    if (step.say !== undefined) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } } } })
    if (step.ask) log({ ask: step.ask.toolCall.toolCallId, got: await request('session/request_permission', { sessionId, toolCall: step.ask.toolCall, options: step.ask.options ?? ONCE_ALWAYS_REJECT }) })
    if (step.call) log({ call: step.call.method, got: await request(step.call.method, step.call.params) })
  }
}

let buffered = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8')
  const lines = buffered.split('\n')
  buffered = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
    if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue }
    if (m.method === 'initialize') { log({ initialize: m.params }); send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: script.loadSession === true }, agentInfo: script.agentInfo ?? { name: 'Scripted', version: '1' } } }) }
    if (m.method === 'session/new') { sessionId = 'ses-1'; send({ jsonrpc: '2.0', id: m.id, result: { sessionId } }) }
    if (m.method === 'session/load') { sessionId = String(m.params?.sessionId); log({ load: sessionId }); send({ jsonrpc: '2.0', id: m.id, result: {} }) }
    if (m.method === 'session/prompt') {
      const id = m.id
      void play().then(() => {
        send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
        for (const step of script.steps) if (step.late) setTimeout(() => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: step.late } }), 50)
      })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
