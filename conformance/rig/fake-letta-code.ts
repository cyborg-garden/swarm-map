// A fake Letta Code, for CI. It speaks the slice of Letta Code's headless
// stream-json mode that the shim uses, as recorded from the real Letta Code
// 0.34.60: the `init` record, `user` lines in, assistant messages, tool
// calls and returns, `can_use_tool` requests and their answers, and the
// `result` record that ends a turn. It keeps what the real one keeps under
// its home: one agent, conversations that can be picked up again, and a
// memory folder per agent that is read into every conversation.
//
// It behaves like the real one where the checks would notice a difference:
// - It asks its endpoint which models exist, and refuses one that is not listed.
// - Its default permission mode is `unrestricted`, where it asks nobody.
//   Only `--permission-mode strict` makes it ask before every tool.
// - In strict mode it asks even about a tool it was not started with, and
//   then fails that call as "not found" whatever the answer.
// - A tool call waits for its answer for as long as it takes.
//
// It says what it is: its first record is {"type":"fake_letta_code"}. It has
// no shell. Its `Bash` tool understands three commands only: `touch <path>`,
// `env > <path>`, and the one line the memory check uses to plant a note.
// `npm run conformance` runs the same checks against the real one.
//
// Like the real one, it is started by the lab with a tripwire loaded first
// (guards/child-tripwire.ts), so a model call that is not to this machine is
// stopped and recorded here, in the process that would have made it.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MIMICS = '0.34.60'

// The lab tells Letta Code to stay offline with three variables. The real
// one obeys them; this one cannot go online anyway, so it refuses to start
// without them. A shim that stops setting them turns every check red.
for (const [name, value] of [['DISABLE_AUTOUPDATER', '1'], ['LETTA_CODE_TELEM', '0'], ['DO_NOT_TRACK', '1']]) {
  if (process.env[name] !== value) {
    process.stderr.write(`fake letta code: refusing to start: ${name} is not ${value}\n`)
    process.exit(1)
  }
}

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
if (argv.includes('--version')) {
  process.stdout.write(`${MIMICS} (Letta Code)\n`)
  process.exit(0)
}
const refuse = (why: string): never => {
  process.stderr.write(`fake letta code: ${why}\n`)
  process.exit(1)
}
// Headless, two-way, on the local backend: the one way the shim starts it. The server mode, where the chat channels live, does not exist here.
if (!argv.includes('-p') || flag('--input-format') !== 'stream-json' || flag('--output-format') !== 'stream-json' || flag('--backend') !== 'local') {
  refuse('only the headless stream-json mode on the local backend exists here')
}

const store = path.join(process.env.HOME ?? '', '.letta', 'lc-local-backend')
const providers = path.join(store, 'providers', 'auth.json')
const provider = existsSync(providers) ? JSON.parse(readFileSync(providers, 'utf8')).providers?.['openai-compatible'] : undefined
if (!provider) refuse('no openai-compatible provider in its home')
const modelHandle = flag('--model') ?? ''
const model = modelHandle.replace(/^openai-compatible\//, '')
const tools = (flag('--tools') ?? 'Bash,Read,Edit,Write,Memory').split(',').filter(Boolean)
const strict = (flag('--permission-mode') ?? 'unrestricted') === 'strict'

const emit = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
emit({ type: 'fake_letta_code', mimics: MIMICS })

// --- the agent, its conversation and its memory ------------------------------

// A conversation knows its agent. Like the real one, this refuses to be told both.
if (flag('--conversation') && flag('--agent')) refuse('--conversation cannot be used with --agent')
const conversationId = flag('--conversation') ?? `local-conv-${randomUUID()}`
const conversationFile = path.join(store, 'conversations', `${conversationId}.json`)
if (flag('--conversation') && !existsSync(conversationFile)) refuse('no such conversation')
const kept: { agentId?: string; messages: Record<string, unknown>[] } =
  existsSync(conversationFile) ? JSON.parse(readFileSync(conversationFile, 'utf8')) : { messages: [] }
const messages = kept.messages

const agentFile = (id: string): string => path.join(store, 'agents', `${id}.json`)
let agentId = kept.agentId ?? flag('--agent')
if (argv.includes('--new-agent')) {
  agentId = `agent-local-${randomUUID()}`
  mkdirSync(path.dirname(agentFile(agentId)), { recursive: true })
  writeFileSync(agentFile(agentId), JSON.stringify({ id: agentId }))
} else if (!agentId || !existsSync(agentFile(agentId))) {
  refuse('no such agent')
}
// One folder per agent, whichever conversation is running. Every note in it goes into every prompt.
const memoryDir = path.join(store, 'memfs', agentId!, 'memory')
mkdirSync(memoryDir, { recursive: true })
const memory = (): string => readdirSync(memoryDir).filter((f) => f.endsWith('.md')).sort()
  .map((f) => readFileSync(path.join(memoryDir, f), 'utf8')).join('\n')
mkdirSync(path.dirname(conversationFile), { recursive: true })

// --- tools --------------------------------------------------------------------

const waiting = new Map<string, (allow: boolean) => void>()

function runTool(name: string, args: { command?: string }): { text: string; isError: boolean } {
  const command = args.command ?? ''
  const touch = /^touch (\S+)$/.exec(command)
  const dump = /^env > (\S+)$/.exec(command)
  const plant = /^cd "\$MEMORY_DIR" && printf .* '([^']+)' > planted\.md && git /.exec(command)
  if (name === 'Bash' && touch) { writeFileSync(touch[1], ''); return { text: '(Command completed with no output)', isError: false } }
  if (name === 'Bash' && dump) {
    writeFileSync(dump[1], Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join('\n'))
    return { text: '(Command completed with no output)', isError: false }
  }
  if (name === 'Bash' && plant) {
    writeFileSync(path.join(memoryDir, 'planted.md'), `${plant[1]}\n`)
    return { text: '(Command completed with no output)', isError: false }
  }
  return { text: 'fake letta code: command not supported', isError: true }
}

/** In strict mode, ask whoever started this process and wait for the answer, however long it takes. */
function mayRun(call: { id: string; function: { name: string; arguments: string } }): Promise<boolean> {
  if (!strict) return Promise.resolve(true)
  return new Promise((resolve) => {
    const requestId = `perm-${call.id}`
    waiting.set(requestId, (allow) => { waiting.delete(requestId); resolve(allow) })
    emit({ type: 'message', message_type: 'stop_reason', stop_reason: 'requires_approval' })
    emit({
      type: 'control_request', request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: call.function.name, input: JSON.parse(call.function.arguments), tool_call_id: call.id, permission_suggestions: [], blocked_path: null },
    })
  })
}

// --- one turn -----------------------------------------------------------------

let listed: string[] | undefined

async function turn(content: string): Promise<void> {
  const auth = { authorization: `Bearer ${provider.auth.key}` }
  const done = (subtype: 'success' | 'error', result: string): void => {
    writeFileSync(conversationFile, JSON.stringify({ agentId, messages }))
    emit({ type: 'result', subtype, result, agent_id: agentId, conversation_id: conversationId })
  }
  // Like the real one: the endpoint is asked which models it has, and one it does not list is refused.
  if (!listed) {
    const res = await fetch(`${provider.base_url}/models`, { headers: auth })
    listed = res.ok ? ((await res.json()).data as { id: string }[]).map((m) => m.id) : []
  }
  if (!listed.includes(model)) {
    listed = undefined
    emit({ type: 'error', message: `Unknown model "${model}" for provider "openai-compatible".`, stop_reason: 'error' })
    return done('error', '')
  }

  messages.push({ role: 'user', content })
  let text = ''
  for (let round = 0; round < 8; round++) {
    const res = await fetch(`${provider.base_url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: `You are a fake Letta Code agent.\n<memory>\n${memory()}\n</memory>` }, ...messages], stream: false }),
    })
    if (!res.ok) {
      emit({ type: 'error', message: `${res.status}`, stop_reason: 'error' })
      emit({ type: 'message', message_type: 'stop_reason', stop_reason: 'error' })
      return done('error', '')
    }
    const choice = (await res.json()).choices[0]
    const calls = choice.message.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined
    messages.push(choice.message)
    if (!calls) {
      text = choice.message.content
      emit({ type: 'message', message_type: 'assistant_message', id: `msg-${round}`, content: [{ type: 'text', text }] })
      emit({ type: 'message', message_type: 'stop_reason', stop_reason: 'end_turn' })
      break
    }
    for (const call of calls) {
      const allowed = await mayRun(call)
      emit({ type: 'message', message_type: 'tool_call_message', id: `tool-call-${call.id}`, tool_call: { name: call.function.name, tool_call_id: call.id, arguments: call.function.arguments } })
      const result = !allowed ? { text: 'Error: request to call tool denied.', isError: true }
        : !tools.includes(call.function.name) ? { text: `Tool not found: ${call.function.name}. Available tools: ${tools.join(', ')}`, isError: true }
          : runTool(call.function.name, JSON.parse(call.function.arguments))
      emit({ type: 'message', message_type: 'tool_return_message', id: `tool-return-${call.id}`, status: result.isError ? 'error' : 'success', tool_call_id: call.id, tool_return: result.text })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text })
    }
  }
  done('success', text)
}

emit({ type: 'system', subtype: 'init', agent_id: agentId, conversation_id: conversationId, model: modelHandle, tools, permission_mode: '' })

let buffered = ''
let queue = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8')
  const lines = buffered.split('\n')
  buffered = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.type === 'user') queue = queue.then(() => turn(record.message.content))
    if (record.type === 'control_response') waiting.get(record.response?.request_id)?.(record.response?.response?.behavior === 'allow')
  }
})
process.stdin.on('end', () => process.exit(0))
