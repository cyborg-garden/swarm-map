// A fake Pi, for CI. It speaks the slice of `pi --mode rpc` that the shim
// uses, as recorded from the real Pi 1.5.2: prompt, message_end,
// extension_ui_request, tool_execution_end, agent_end, agent_settled. It
// calls the model named in models.json, exactly as Pi would.
//
// It loads the extension given with `-e` and runs it, the way Pi does: the
// extension's `session_start` handler runs once at start, and its `tool_call`
// handler runs before every declared tool and can block it. The gate is the
// real file, not a copy of its logic here. As with the real Pi, a missing or
// broken extension stops the process with exit code 1, and no extension means
// no gate at all.
//
// It says what it is: its first record is {"type":"fake_pi"}. It has no
// shell. Its `bash` tool understands two commands only, `touch <path>` and
// `env > <path>`, which is all the conformance checks need. `npm run
// conformance` runs the same checks against the real Pi.
//
// Like the real Pi, it is started by the lab with a tripwire loaded first
// (guards/child-tripwire.ts), so a model call that is not to this machine is
// stopped and recorded here, in the process that would have made it.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The lab tells Pi to stay offline with three variables. The real Pi obeys
// them; this one cannot go online anyway, so it refuses to start without them.
// A shim that stops setting them turns every check against the fake red.
for (const [name, value] of [['PI_OFFLINE', '1'], ['PI_TELEMETRY', '0'], ['PI_SKIP_VERSION_CHECK', '1']]) {
  if (process.env[name] !== value) {
    process.stderr.write(`fake pi: refusing to start: ${name} is not ${value}\n`)
    process.exit(1)
  }
}

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const tools = argv.includes('--no-builtin-tools') ? [] : (flag('--tools') ?? 'read,bash,edit,write').split(',')

const models = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR ?? '', 'models.json'), 'utf8'))
const provider = models.providers[flag('--provider') ?? '']
const model = flag('--model') ?? ''

const emit = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
emit({ type: 'fake_pi', mimics: '1.5.2' })

// --- the extension host -----------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
const handlers: Record<string, Handler[]> = {}
const waiting = new Map<string, (value: string | undefined) => void>()

const ctx = {
  hasUI: true,
  mode: 'rpc',
  ui: {
    // A dialog: answered by the client, or resolved with undefined at the timeout.
    select: (title: string, options: string[], opts: { timeout?: number } = {}): Promise<string | undefined> =>
      new Promise((resolve) => {
        const id = randomUUID()
        const timer = opts.timeout === undefined ? undefined : setTimeout(() => { waiting.delete(id); resolve(undefined) }, opts.timeout)
        waiting.set(id, (value) => { clearTimeout(timer); waiting.delete(id); resolve(value) })
        emit({ type: 'extension_ui_request', id, method: 'select', title, options, ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }) })
      }),
    // Fire and forget.
    notify: (message: string, notifyType = 'info'): void => {
      emit({ type: 'extension_ui_request', id: randomUUID(), method: 'notify', message, notifyType })
    },
  },
}

const fatal = (file: string, why: string): never => {
  process.stderr.write(`Error: Failed to load extension "${file}": ${why}\n`)
  process.exit(1)
}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '-e') continue
  const file = argv[i + 1]
  if (!file || !existsSync(file)) fatal(file, `Extension path does not exist: ${file}`)
  try {
    const mod = await import(pathToFileURL(file).href)
    await mod.default({ on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler) } })
  } catch (err) {
    fatal(file, `Failed to load extension: ${(err as Error).message}`)
  }
}
for (const handler of handlers.session_start ?? []) await handler({ type: 'session_start', reason: 'startup' }, ctx)

/** Runs every `tool_call` handler. Any one of them can block the call. */
async function blockedBy(call: { id: string; function: { name: string; arguments: string } }): Promise<string | undefined> {
  const event = { type: 'tool_call', toolName: call.function.name, toolCallId: call.id, input: JSON.parse(call.function.arguments) }
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler(event, ctx) as { block?: boolean; reason?: string } | undefined
    if (result?.block) return result.reason ?? 'blocked'
  }
  return undefined
}

// --- the session ------------------------------------------------------------

// `--continue` picks the conversation in the session dir back up, as Pi does.
const sessionFile = path.join(flag('--session-dir') ?? '.', 'fake-pi-session.json')
const messages: Record<string, unknown>[] =
  argv.includes('--continue') && existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : []

function runTool(name: string, args: { command?: string }): { text: string; isError: boolean } {
  const command = args.command ?? ''
  const touch = /^touch (\S+)$/.exec(command)
  const dump = /^env > (\S+)$/.exec(command)
  if (name === 'bash' && touch) { writeFileSync(touch[1], ''); return { text: '(no output)', isError: false } }
  if (name === 'bash' && dump) {
    writeFileSync(dump[1], Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join('\n'))
    return { text: '(no output)', isError: false }
  }
  return { text: 'fake pi: command not supported', isError: true }
}

async function prompt(id: string, message: string): Promise<void> {
  emit({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
  messages.push({ role: 'user', content: message })
  emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } })
  for (let round = 0; round < 8; round++) {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model, messages, stream: false }),
    })
    if (!res.ok) {
      emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: `${res.status}` } })
      break
    }
    const choice = (await res.json()).choices[0]
    const calls = choice.message.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined
    messages.push(choice.message)
    if (!calls) {
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: choice.message.content }], stopReason: 'stop' } })
      break
    }
    emit({ type: 'message_end', message: { role: 'assistant', content: calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.function.name })), stopReason: 'toolUse' } })
    for (const call of calls) {
      emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.function.name })
      let result: { text: string; isError: boolean }
      if (!tools.includes(call.function.name)) {
        // Like the real Pi: a tool that was not declared at start never reaches an extension.
        result = { text: `Tool ${call.function.name} not found`, isError: true }
      } else {
        const reason = await blockedBy(call)
        result = reason === undefined ? runTool(call.function.name, JSON.parse(call.function.arguments)) : { text: reason, isError: true }
      }
      emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.function.name, isError: result.isError })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text })
    }
  }
  writeFileSync(sessionFile, JSON.stringify(messages))
  emit({ type: 'agent_end' })
  emit({ type: 'agent_settled', aborted: false })
}

let buffered = ''
let queue = Promise.resolve()
process.stdin.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8')
  const lines = buffered.split('\n')
  buffered = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.type === 'prompt') queue = queue.then(() => prompt(record.id, record.message))
    if (record.type === 'extension_ui_response') waiting.get(record.id)?.(record.cancelled ? undefined : record.value)
  }
})
process.stdin.on('end', () => process.exit(0))
