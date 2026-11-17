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
// shell. Its `bash` tool understands a handful of fixed commands, joined by
// `;` or `&&` (see runBash), which is all the conformance checks need, and it
// has `read`, `write` and `ls`. As in the real Pi, a `tool_call` handler may
// change a call's input before it runs, a `tool_result` handler may change
// what the model is handed, and a shell call stops at its `timeout`. `npm run
// conformance` runs the same checks against the real Pi.
//
// Like the real Pi, it is started by the lab with a tripwire loaded first
// (guards/child-tripwire.ts), so a model call that is not to this machine is
// stopped and recorded here, in the process that would have made it.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
// As in the real Pi: --no-tools leaves none at all, --no-builtin-tools leaves an extension's, --tools names every one.
const tools = argv.includes('--no-tools') ? []
  : argv.includes('--no-builtin-tools') ? null
    : (flag('--tools') ?? 'read,bash,edit,write').split(',')
const declared = (name: string): boolean => (tools === null ? Object.hasOwn(extensionTools, name) : tools.includes(name))

const systemPrompt = flag('--system-prompt')
const models = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR ?? '', 'models.json'), 'utf8'))
const provider = models.providers[flag('--provider') ?? '']
const model = flag('--model') ?? ''

const emit = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
emit({ type: 'fake_pi', mimics: '1.5.2' })

// --- the extension host -----------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
const handlers: Record<string, Handler[]> = {}
type ExtensionTool = { execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<{ content: { type: string; text?: string }[] }> }
/** Tools an extension registered, by name. Like Pi's, one is declared only when --tools names it. */
const extensionTools: Record<string, ExtensionTool> = {}
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
    // A dialog for free text: answered by the client, or undefined at the timeout.
    input: (title: string, _placeholder?: string, opts: { timeout?: number } = {}): Promise<string | undefined> =>
      new Promise((resolve) => {
        const id = randomUUID()
        const timer = opts.timeout === undefined ? undefined : setTimeout(() => { waiting.delete(id); resolve(undefined) }, opts.timeout)
        waiting.set(id, (value) => { clearTimeout(timer); waiting.delete(id); resolve(value) })
        emit({ type: 'extension_ui_request', id, method: 'input', title, ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }) })
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
    await mod.default({
      on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler) },
      registerTool: (tool: ExtensionTool & { name: string }) => { extensionTools[tool.name] = tool },
    })
  } catch (err) {
    fatal(file, `Failed to load extension: ${(err as Error).message}`)
  }
}
for (const handler of handlers.session_start ?? []) await handler({ type: 'session_start', reason: 'startup' }, ctx)

/** Runs every `tool_call` handler, in order. Any one of them can block the call, or change `input` in place. */
async function blockedBy(name: string, id: string, input: unknown): Promise<string | undefined> {
  const event = { type: 'tool_call', toolName: name, toolCallId: id, input }
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler(event, ctx) as { block?: boolean; reason?: string } | undefined
    if (result?.block) return result.reason ?? 'blocked'
  }
  return undefined
}

/** Runs every `tool_result` handler. Each may hand back other content for the model. */
async function resultFor(name: string, id: string, input: unknown, ran: { text: string; isError: boolean }): Promise<string> {
  let content: { type: string; text?: string }[] = [{ type: 'text', text: ran.text }]
  for (const handler of handlers.tool_result ?? []) {
    const patch = await handler({ type: 'tool_result', toolName: name, toolCallId: id, input, content, isError: ran.isError }, ctx) as { content?: typeof content } | undefined
    if (Array.isArray(patch?.content)) content = patch.content
  }
  return content.map((part) => part.text ?? '').join('')
}

// --- the session ------------------------------------------------------------

// `--continue` picks the conversation in the session dir back up, as Pi does.
const sessionFile = path.join(flag('--session-dir') ?? '.', 'fake-pi-session.json')
const messages: Record<string, unknown>[] =
  argv.includes('--continue') && existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : []

type Ran = { text: string; isError: boolean }
const UNSUPPORTED: Ran = { text: 'fake pi: command not supported', isError: true }

/**
 * The fake shell. One command, or several joined by `;` or `&&`, each of:
 *   touch <path>                              env > <path>
 *   ln -s <target> <path>                     sleep <seconds>
 *   printf '%s%s\n' <a> <b> [> <path>]         head -c <n> /dev/zero | tr '\0' x
 * A call that sleeps past its `timeout` (seconds) stops there, as the real one is killed.
 */
/** Make the files a part of a command would make, as a shell would. How many it made. */
function sideEffects(part: string): number {
  let made = 0
  for (const m of part.matchAll(/(touch|tee|mkdir|>>|>)\s*(\/[^\s`)\\;"]+)/g)) {
    if (m[1] === 'mkdir') mkdirSync(m[2], { recursive: true })
    else writeFileSync(m[2], '')
    made++
  }
  return made
}

async function runBash(args: { command?: unknown; timeout?: unknown }): Promise<Ran> {
  const limit = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : undefined
  let out = ''
  let slept = 0
  for (const part of String(args.command ?? '').split(/\s*(?:;|&&)\s*/)) {
    let m: RegExpExecArray | null
    if ((m = /^touch (\S+)$/.exec(part))) writeFileSync(m[1], '')
    else if ((m = /^env > (\S+)$/.exec(part))) writeFileSync(m[1], Object.entries(process.env).map(([k, v]) => `${k}=${v}`).join('\n'))
    else if ((m = /^ln -s (\S+) (\S+)$/.exec(part))) symlinkSync(m[1], m[2])
    else if ((m = /^sleep (\d+(?:\.\d+)?)$/.exec(part))) {
      const wanted = Number(m[1])
      const cut = limit !== undefined && slept + wanted > limit
      const wait = cut ? limit - slept : wanted
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      slept += wait
      if (cut) return { text: `${out}\nCommand timed out after ${limit} seconds`, isError: true }
    }
    else if ((m = /^printf '%s%s\\n' (\S+) (\S+)(?: > (\S+))?$/.exec(part))) {
      if (m[3]) writeFileSync(m[3], `${m[1]}${m[2]}\n`)
      else out += `${m[1]}${m[2]}\n`
    }
    else if ((m = /^head -c (\d+) \/dev\/zero \| tr '\\0' x$/.exec(part))) out += 'x'.repeat(Number(m[1]))
    else if ((m = /^echo (\S+) \| grep \S+$/.exec(part))) out += `${m[1]}\n`
    // The command policy's check (K1) hides a write in a command that looks harmless. A real shell would
    // make it, so this does too: every file a touch, tee, mkdir or redirection in it names, wherever it sits.
    else if (sideEffects(part) > 0 || /^(ls|echo\b.*|"\s*)$/.test(part)) continue
    else return UNSUPPORTED
  }
  return { text: out === '' ? '(no output)' : out, isError: false }
}

async function runTool(name: string, args: Record<string, unknown>, id: string): Promise<Ran> {
  try {
    if (Object.hasOwn(extensionTools, name)) {
      const out = await extensionTools[name].execute(id, args, undefined, undefined, ctx)
      return { text: out.content.map((part) => part.text ?? '').join(''), isError: false }
    }
    if (name === 'bash') return await runBash(args)
    const file = String(args.path ?? '.')
    if (name === 'read') return { text: readFileSync(file, 'utf8'), isError: false }
    if (name === 'ls') return { text: readdirSync(file).sort().join('\n') || '(empty directory)', isError: false }
    if (name === 'write') {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
      writeFileSync(file, String(args.content ?? ''))
      return { text: `Successfully wrote to ${file}`, isError: false }
    }
    return UNSUPPORTED
  } catch (err) {
    return { text: (err as Error).message, isError: true }
  }
}

async function prompt(id: string, message: string): Promise<void> {
  emit({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
  messages.push({ role: 'user', content: message })
  emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } })
  for (let round = 0; round < 16; round++) {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      // As Pi does: what it was told it is goes first, as the system message.
      body: JSON.stringify({ model, messages: [...(systemPrompt === undefined ? [] : [{ role: 'system', content: systemPrompt }]), ...messages], stream: false }),
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
      if (!declared(call.function.name)) {
        // Like the real Pi: a tool that was not declared at start never reaches an extension.
        result = { text: `Tool ${call.function.name} not found`, isError: true }
      } else {
        // One input for the handlers and the tool: a handler's change to it is what runs.
        const input = JSON.parse(call.function.arguments) as Record<string, unknown>
        const reason = await blockedBy(call.function.name, call.id, input)
        if (reason !== undefined) result = { text: reason, isError: true }
        else {
          const ran = await runTool(call.function.name, input, call.id)
          result = { text: await resultFor(call.function.name, call.id, input, ran), isError: ran.isError }
        }
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
