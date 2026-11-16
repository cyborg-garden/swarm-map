// A fake Claude Agent SDK, for CI. It is a value of the shape the shim is
// handed (lib/runtimes/claude-sdk/sdk.ts) and implements the slice of the
// SDK the shim uses, as recorded from the real SDK 0.3.325: `query()` with a
// stream of user messages, the `init`, `assistant`, `user` and `result`
// records, the `canUseTool` callback, sessions kept on disk that can be
// picked back up, and model calls in the Anthropic Messages format, streamed.
//
// It behaves like the real one where the checks would notice a difference:
// - It has the tools it was started with, of the three its minimal mode has
//   (a shell, a read, an edit). A call to any other tool fails as "no such
//   tool" and nobody is asked.
// - It does NOT ask before every call. A read inside its work folder and a
//   shell command it takes to be harmless (`ls`, `cat`) run unasked, unless
//   the settings it was given name the tool under `permissions.ask`.
// - With `permissionMode: 'bypassPermissions'` it asks nobody at all.
// - A model call that fails ends the turn with a `result` record of subtype
//   `success` whose text is the error, marked only by `is_error`.
// - Its environment is the one it is given, and nothing else.
// - It sends its model calls through the proxy its environment names.
// - `continue: true` picks up the last session of its work folder.
//
// It says what it is: its first record is {"type":"fake_claude_sdk"}. It has
// no shell: its `Bash` understands `touch <path>`, `env > <path>`, `cat
// <path>`, `ls`, and the one line the lab uses to make a file of random
// digits, and nothing else. `npm run conformance -- claude-sdk` runs the same
// checks against the real one.
//
// Unlike the real one it runs inside the process that calls it, so the
// tripwire armed in a test file sees everything it does.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ClaudeSdk, SdkMessage, SdkOptions, SdkQuery, SdkUserMessage } from '../../lib/runtimes/claude-sdk/sdk.ts'
import { requestVia } from '../guards/watch-proxy.ts'

const MIMICS = { sdk: '0.3.325', code: '2.1.325' }

// The lab tells the SDK to stay offline with four variables. The real one
// obeys them; this one cannot go online anyway, so it refuses to start
// without them. A shim that stops setting them turns every check red.
const OFFLINE = ['DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']

/**
 * The built-in tools the real one has in its minimal mode, which is the only mode this fake has.
 * It is every one of them: asked to start with any other (a separate write tool, a web tool, a
 * sub-agent), the real one starts without it and says so in its `init` record. Its edit tool
 * makes a file that is not there yet.
 */
const MINIMAL = ['Bash', 'Edit', 'Read']

interface Block { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string; is_error?: boolean }
interface Kept { messages: { role: string; content: Block[] }[] }

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, path.resolve(dir, file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Read a streamed Messages reply into its content blocks. */
function blocksOf(sse: string): Block[] {
  const blocks: Block[] = []
  const json: string[] = []
  for (const event of sse.split('\n\n')) {
    const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice('data:'.length).replace(/^ /, '')).join('\n')
    if (data === '') continue
    const e = JSON.parse(data) as { type: string; index: number; content_block?: Block; delta?: { type: string; text?: string; partial_json?: string } }
    if (e.type === 'content_block_start') { blocks[e.index] = { ...e.content_block! }; json[e.index] = '' }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') blocks[e.index].text = (blocks[e.index].text ?? '') + (e.delta.text ?? '')
    if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta') json[e.index] += e.delta.partial_json ?? ''
    if (e.type === 'content_block_stop' && blocks[e.index].type === 'tool_use') blocks[e.index].input = JSON.parse(json[e.index] || '{}')
  }
  return blocks.filter(Boolean)
}

export function fakeClaudeSdk(): ClaudeSdk {
  return {
    version: async () => `${MIMICS.sdk} (Claude Agent SDK), ${MIMICS.code} (Claude Code)`,
    query({ prompt, options }) {
      let closed = false
      const abort = new AbortController()
      const records = run(prompt, options, () => closed, abort.signal)
      const query: SdkQuery = {
        [Symbol.asyncIterator]: () => records,
        close() { closed = true; abort.abort() },
      }
      return query
    },
  }
}

async function* run(prompt: AsyncIterable<SdkUserMessage>, options: SdkOptions, closed: () => boolean, signal: AbortSignal): AsyncGenerator<SdkMessage> {
  yield { type: 'fake_claude_sdk' }
  const env = options.env
  for (const name of OFFLINE) if (env[name] !== '1') throw new Error(`fake claude sdk: refusing to start: ${name} is not 1`)
  if (options.extraArgs.bare !== null) throw new Error('fake claude sdk: only its minimal mode exists here')

  // --- the session and its transcript ------------------------------------------
  const store = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? '', '.claude'), 'projects', options.cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(store, { recursive: true })
  const fileOf = (id: string): string => path.join(store, `${id}.json`)
  const last = (): string | undefined => readdirSync(store).filter((f) => f.endsWith('.json'))
    .map((f) => ({ id: f.slice(0, -'.json'.length), at: statSync(path.join(store, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0]?.id
  const lost = options.resume !== undefined && !existsSync(fileOf(options.resume))
  const sessionId = options.resume ?? (options.continue ? last() : undefined) ?? randomUUID()
  const kept: Kept = existsSync(fileOf(sessionId)) ? JSON.parse(readFileSync(fileOf(sessionId), 'utf8')) : { messages: [] }
  const messages = kept.messages

  const tools = MINIMAL.filter((name) => !Array.isArray(options.tools) || options.tools.includes(name))

  // --- tools --------------------------------------------------------------------
  function runTool(name: string, input: Record<string, unknown>): { text: string; isError: boolean } {
    const ok = (text = '(completed with no output)') => ({ text, isError: false })
    const no = (text: string) => ({ text, isError: true })
    try {
      if (name === 'Bash') {
        const command = String(input.command ?? '')
        const touch = /^touch (\S+)$/.exec(command)
        const dump = /^env > (\S+)$/.exec(command)
        const cat = /^cat (\S+)$/.exec(command)
        const random = /^\(od -An -N8 -tx1 \/dev\/urandom \| tr -d ' \\n'; echo; echo second line\) > (\S+)$/.exec(command)
        if (touch) { writeFileSync(touch[1], ''); return ok() }
        if (random) { writeFileSync(random[1], `${randomBytes(8).toString('hex')}\nsecond line\n`); return ok() }
        if (dump) { writeFileSync(dump[1], Object.entries({ ...env, CLAUDECODE: '1' }).map(([k, v]) => `${k}=${v}`).join('\n')); return ok() }
        if (cat) return ok(readFileSync(path.resolve(options.cwd, cat[1]), 'utf8'))
        if (command === 'ls') return ok(readdirSync(options.cwd).join('\n'))
        return no('fake claude sdk: command not supported')
      }
      const file = path.resolve(options.cwd, String(input.file_path ?? ''))
      if (name === 'Read') return ok(readFileSync(file, 'utf8'))
      if (name === 'Edit') { writeFileSync(file, readFileSync(file, 'utf8').replace(String(input.old_string ?? ''), String(input.new_string ?? ''))); return ok() }
    } catch (err) {
      return no((err as Error).message)
    }
    return no('fake claude sdk: tool not supported')
  }

  /** Would the real one run this call without asking anybody? */
  const runsUnasked = (name: string, input: Record<string, unknown>): boolean =>
    (name === 'Read' && inside(options.cwd, String(input.file_path ?? '')))
    || (name === 'Bash' && /^(ls|cat \S+)$/.test(String(input.command ?? '')))

  async function mayRun(name: string, input: Record<string, unknown>): Promise<{ allow: boolean; message: string }> {
    if (options.permissionMode === 'bypassPermissions' && options.allowDangerouslySkipPermissions === true) return { allow: true, message: '' }
    const mustAsk = options.settings?.permissions?.ask?.includes(name) === true
    if (!mustAsk && (runsUnasked(name, input) || options.allowedTools.includes(name))) return { allow: true, message: '' }
    if (!options.canUseTool) return { allow: false, message: 'This session has no approval surface.' }
    const answer = await options.canUseTool(name, input, { signal })
    return answer.behavior === 'allow' ? { allow: true, message: '' } : { allow: false, message: answer.message }
  }

  // --- one turn -----------------------------------------------------------------
  const save = (): void => { writeFileSync(fileOf(sessionId), JSON.stringify(kept)) }
  const call = async (): Promise<{ status: number; body: string }> => {
    const res = await requestVia(env, `${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219' },
      body: JSON.stringify({
        model: options.model, max_tokens: 32000, stream: true,
        system: [{ type: 'text', text: 'You are a fake Claude agent.' }, { type: 'text', text: options.systemPrompt }],
        messages, tools: tools.map((name) => ({ name, description: name, input_schema: { type: 'object' } })),
      }),
    })
    const chunks: Buffer[] = []
    for await (const chunk of res) chunks.push(chunk as Buffer)
    return { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }
  }

  for await (const user of prompt) {
    if (closed()) return
    // Like the real one: asked to pick up a session it has no transcript of, it ends the turn at once, and never says it started.
    if (lost) { yield { type: 'result', subtype: 'error_during_execution', is_error: true }; return }
    yield { type: 'system', subtype: 'init', session_id: sessionId, tools, claude_code_version: MIMICS.code }
    messages.push({ role: 'user', content: [{ type: 'text', text: user.message.content }] })
    // Like the real one: the message is in the transcript before the model is called.
    save()
    let text = ''
    let failed: string | undefined
    for (let round = 0; round < 8 && failed === undefined; round++) {
      const res = await call()
      if (closed()) return
      if (res.status !== 200) {
        let said = ''
        try { said = String((JSON.parse(res.body) as { error?: { message?: unknown } }).error?.message ?? '') } catch { /* not JSON */ }
        failed = `API Error: ${res.status} ${said}`
        break
      }
      const blocks = blocksOf(res.body)
      messages.push({ role: 'assistant', content: blocks })
      yield { type: 'assistant' }
      const uses = blocks.filter((b) => b.type === 'tool_use')
      if (uses.length === 0) { text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''); break }
      const results: Block[] = []
      for (const use of uses) {
        const name = use.name ?? ''
        const input = use.input ?? {}
        let result: { text: string; isError: boolean }
        if (!tools.includes(name)) result = { text: `<tool_use_error>Error: No such tool available: ${name}.</tool_use_error>`, isError: true }
        else {
          const may = await mayRun(name, input)
          if (closed()) return
          result = may.allow ? runTool(name, input) : { text: may.message, isError: true }
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, content: result.text, is_error: result.isError })
      }
      messages.push({ role: 'user', content: results })
      yield { type: 'user' }
    }
    save()
    // Like the real one: a failed model call is a `result` of subtype `success`, with the error where the reply would be.
    yield failed === undefined
      ? { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId }
      : { type: 'result', subtype: 'success', is_error: true, result: failed, session_id: sessionId }
  }
}
