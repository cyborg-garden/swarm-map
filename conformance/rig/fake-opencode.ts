// A fake OpenCode, for CI. It speaks the slice of the Agent Client Protocol
// that the shim uses, as recorded from the real OpenCode 1.19.5 (`opencode
// acp`): `initialize`, `session/new`, `session/load`, `session/prompt`,
// `session/cancel`, the `session/update` notifications for text and tool
// calls, and `session/request_permission`.
//
// It behaves like the real one where the checks would notice a difference:
// - Its config is the file OPENCODE_CONFIG names. Its rules win over those in
//   OPENCODE_PERMISSION. The last permission rule that matches wins. A tool whose
//   rule is `deny` is not given to the model. With no rule, a tool runs unasked.
// - A tool call is reported `pending`, then `in_progress` with its input, and
//   only then asked about. The question offers allow once, always allow and
//   reject. Read asks with an empty input, as the real one does.
// - "Always allow" is remembered for that tool for as long as the process
//   lives, and the tool is not asked about again.
// - With `experimental.continue_loop_on_deny` it goes back to the model after
//   a no; without it the turn ends there.
// - It names a new session with a model call of its own, unless its title
//   agent is disabled.
// - It refuses to start without the lines that keep it offline and stop it
//   reading config from the scratch folder.
//
// It runs tools for real: `bash` runs `/bin/sh -c` in the scratch folder.
// Like the real one, it is started by the lab with a tripwire loaded first.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MIMICS = '1.19.5'

for (const name of ['OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_DEFAULT_PLUGINS']) {
  if (process.env[name] !== '1') {
    process.stderr.write(`fake opencode: refusing to start: ${name} is not 1\n`)
    process.exit(1)
  }
}

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write(`${MIMICS}\n`)
  process.exit(0)
}
if (argv[0] !== 'acp') {
  process.stderr.write('fake opencode: only `acp` exists here\n')
  process.exit(1)
}
const cwdFlag = argv.indexOf('--cwd')
const startDir = cwdFlag === -1 ? process.cwd() : argv[cwdFlag + 1]

type Rule = 'ask' | 'allow' | 'deny'
const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG ?? '', 'utf8')) as {
  model: string
  provider: Record<string, { options: { baseURL: string; apiKey: string } }>
  permission?: Record<string, Rule> | Rule
  experimental?: { continue_loop_on_deny?: boolean }
  agent?: { build?: { prompt?: string }; title?: { disable?: boolean } }
}
const asRules = (p: unknown): [string, Rule][] => (typeof p === 'string' ? [['*', p as Rule]] : Object.entries((p ?? {}) as Record<string, Rule>))
// As seen on the real one: rules in the config file win over OPENCODE_PERMISSION, so they come after it.
const rules: [string, Rule][] = [...(process.env.OPENCODE_PERMISSION ? asRules(JSON.parse(process.env.OPENCODE_PERMISSION)) : []), ...asRules(config.permission)]
const ruleFor = (permission: string): Rule => rules.findLast(([name]) => name === '*' || name === permission)?.[1] ?? 'allow'
const [providerId, modelId] = config.model.split('/')
const provider = config.provider[providerId]

/** Each tool: the permission it asks under, its ACP kind, and what it asks with. */
const TOOLS: Record<string, { permission: string; kind: string; metadata(args: Record<string, string>): Record<string, unknown> }> = {
  bash: { permission: 'bash', kind: 'execute', metadata: (a) => ({ command: a.command }) },
  read: { permission: 'read', kind: 'read', metadata: () => ({}) },
  edit: { permission: 'edit', kind: 'edit', metadata: (a) => ({ filepath: abs(a.filePath), diff: `+${a.newString ?? ''}` }) },
  write: { permission: 'edit', kind: 'edit', metadata: (a) => ({ filepath: abs(a.filePath), diff: `+${a.content ?? ''}` }) },
}
const abs = (p: string | undefined): string => path.resolve(startDir, p ?? '')
const given = Object.keys(TOOLS).filter((t) => ruleFor(TOOLS[t].permission) !== 'deny')
const always = new Set<string>()

const store = path.join(process.env.HOME ?? '', '.local', 'share', 'opencode', 'fake-sessions')
mkdirSync(store, { recursive: true })
interface Session { id: string; cwd: string; messages: Record<string, unknown>[] }
const sessions = new Map<string, Session>()
const save = (s: Session): void => writeFileSync(path.join(store, `${s.id}.json`), JSON.stringify(s))

const send = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
const update = (sessionId: string, u: Record<string, unknown>): void => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } })

let nextId = 0
const waiting = new Map<number, (result: unknown) => void>()
function ask(params: unknown): Promise<{ outcome?: { outcome?: string; optionId?: string } } | undefined> {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, (r) => resolve(r as never))
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params })
  })
}

function run(tool: string, args: Record<string, string>): { ok: boolean; text: string } {
  if (tool === 'bash') {
    const r = spawnSync('/bin/sh', ['-c', args.command ?? ''], { cwd: startDir, env: process.env, encoding: 'utf8', timeout: 60_000 })
    return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}` || '(no output)' }
  }
  try {
    if (tool === 'read') return { ok: true, text: readFileSync(abs(args.filePath), 'utf8') }
    if (tool === 'write' || tool === 'edit') { writeFileSync(abs(args.filePath), args.content ?? args.newString ?? ''); return { ok: true, text: 'written' } }
  } catch (err) { return { ok: false, text: (err as Error).message } }
  return { ok: false, text: 'invalid tool' }
}

let cancelled = false

async function prompt(s: Session, text: string): Promise<{ stopReason: string }> {
  cancelled = false
  // Like the real one: the first prompt of a session is also sent to the model to name the session, unless that is off.
  if (s.messages.length === 0 && !config.agent?.title?.disable) {
    await fetch(`${provider.options.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.options.apiKey}` },
      body: JSON.stringify({ model: modelId, stream: false, messages: [{ role: 'system', content: 'You are a title generator.' }, { role: 'user', content: text }] }),
    }).catch(() => {})
  }
  s.messages.push({ role: 'user', content: text })
  const system = config.agent?.build?.prompt ?? 'You are a fake opencode.'
  for (let round = 0; round < 8; round++) {
    const res = await fetch(`${provider.options.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.options.apiKey}` },
      body: JSON.stringify({
        model: modelId, stream: false,
        messages: [{ role: 'system', content: system }, ...s.messages],
        tools: given.map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
      }),
    })
    if (!res.ok) { save(s); return { stopReason: 'end_turn' } }
    const choice = (await res.json()).choices[0]
    const calls = choice.message.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined
    s.messages.push(choice.message)
    if (!calls) {
      update(s.id, { sessionUpdate: 'agent_message_chunk', messageId: `msg_${round}`, content: { type: 'text', text: choice.message.content ?? '' } })
      break
    }
    let stop = false
    for (const call of calls) {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, string>
      const tool = TOOLS[call.function.name]
      const id = call.id
      if (!tool || !given.includes(call.function.name)) {
        s.messages.push({ role: 'tool', tool_call_id: id, content: `invalid tool: ${call.function.name}` })
        continue
      }
      const input = { ...args, ...(tool.kind === 'execute' ? { cwd: startDir } : {}) }
      update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title: call.function.name, kind: tool.kind, status: 'pending', locations: [], rawInput: tool.kind === 'execute' ? { cwd: startDir } : {} })
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: tool.kind, title: args.command ?? args.filePath ?? call.function.name, rawInput: input })
      let allowed = ruleFor(tool.permission) === 'allow' || always.has(tool.permission)
      if (!allowed) {
        const answer = await ask({
          sessionId: s.id,
          toolCall: { toolCallId: id, title: args.command ?? call.function.name, kind: tool.kind, status: 'pending', locations: [], rawInput: tool.metadata(args) },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        })
        const picked = answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : undefined
        if (picked === 'always') always.add(tool.permission)
        allowed = picked === 'once' || picked === 'always'
      }
      if (!allowed || cancelled) {
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', kind: tool.kind, rawInput: input })
        s.messages.push({ role: 'tool', tool_call_id: id, content: 'The user rejected permission to use this specific tool call.' })
        if (!config.experimental?.continue_loop_on_deny || cancelled) stop = true
        continue
      }
      const out = run(call.function.name, args)
      update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: out.ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: out.text } }] })
      s.messages.push({ role: 'tool', tool_call_id: id, content: out.text })
    }
    if (stop) break
  }
  save(s)
  return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'initialize') {
    return { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'OpenCode', version: MIMICS } }
  }
  if (method === 'session/new') {
    const s: Session = { id: `ses_${randomUUID()}`, cwd: String(params.cwd), messages: [] }
    sessions.set(s.id, s)
    save(s)
    return { sessionId: s.id }
  }
  if (method === 'session/load') {
    const file = path.join(store, `${String(params.sessionId)}.json`)
    if (!existsSync(file)) throw new Error('no such session')
    const s = JSON.parse(readFileSync(file, 'utf8')) as Session
    sessions.set(s.id, s)
    // The real one plays the session back as updates. They come before the answer.
    for (const m of s.messages) if (m.role === 'assistant' && typeof m.content === 'string') update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.content } })
    return {}
  }
  if (method === 'session/prompt') {
    const s = sessions.get(String(params.sessionId))
    if (!s) throw new Error('no such session')
    const blocks = (params.prompt as { type: string; text?: string }[]) ?? []
    return prompt(s, blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
  }
  throw Object.assign(new Error('Method not found'), { code: -32601 })
}

let buffered = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8')
  const lines = buffered.split('\n')
  buffered = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const m = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
    if (m.method === undefined && typeof m.id === 'number') { waiting.get(m.id)?.(m.error ? undefined : m.result); waiting.delete(m.id); continue }
    if (m.method === 'session/cancel') { cancelled = true; continue }
    if (m.method === undefined || m.id === undefined) continue
    const id = m.id
    handle(m.method, m.params ?? {}).then(
      (result) => send({ jsonrpc: '2.0', id, result }),
      (err: Error & { code?: number }) => send({ jsonrpc: '2.0', id, error: { code: err.code ?? -32603, message: err.message } }),
    )
  }
})
process.stdin.on('end', () => process.exit(0))
