// A fake Pi, for CI. It speaks the slice of `pi --mode rpc` that the shim
// uses, as recorded from the real Pi 1.5.2: prompt, message_end,
// extension_ui_request for the gate, tool_execution_end, agent_end,
// agent_settled. It calls the model named in models.json, exactly as Pi would.
//
// It says what it is: its first record is {"type":"fake_pi"}. It has no
// shell. Its `bash` tool understands two commands only, `touch <path>` and
// `env > <path>`, which is all the conformance checks need. `npm run
// conformance` runs the same checks against the real Pi.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const tools = argv.includes('--no-builtin-tools') ? [] : (flag('--tools') ?? 'read,bash,edit,write').split(',')
const gateLoaded = argv.includes('-e')
const gateTimeout = Number(process.env.SWARM_GATE_TIMEOUT_MS ?? 30_000)

const models = JSON.parse(readFileSync(path.join(process.env.PI_CODING_AGENT_DIR ?? '', 'models.json'), 'utf8'))
const provider = models.providers[flag('--provider') ?? '']
const model = flag('--model') ?? ''

const emit = (record: unknown): void => { process.stdout.write(JSON.stringify(record) + '\n') }
emit({ type: 'fake_pi', mimics: '1.5.2' })

const waiting = new Map<string, (value: string | undefined) => void>()
const messages: Record<string, unknown>[] = []

async function gate(call: { id: string; function: { name: string; arguments: string } }): Promise<boolean> {
  if (!gateLoaded) return true
  const id = `ui-${call.id}`
  const title = 'swarm-gate:v1:' + JSON.stringify({ tool: call.function.name, input: JSON.parse(call.function.arguments), callId: call.id })
  const answer = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(undefined) }, gateTimeout)
    waiting.set(id, (value) => { clearTimeout(timer); waiting.delete(id); resolve(value) })
    emit({ type: 'extension_ui_request', id, method: 'select', title, options: ['allow', 'deny'], timeout: gateTimeout })
  })
  return answer === 'allow'
}

function runTool(name: string, args: { command?: string }): { text: string; isError: boolean } {
  if (!tools.includes(name)) return { text: `unknown tool ${name}`, isError: true }
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
      // Like the real Pi: a tool that was not declared at start never reaches the gate.
      const declared = tools.includes(call.function.name)
      const result = !declared
        ? { text: `Tool ${call.function.name} not found`, isError: true }
        : (await gate(call))
          ? runTool(call.function.name, JSON.parse(call.function.arguments))
          : { text: 'swarm gate: not allowed', isError: true }
      emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.function.name, isError: result.isError })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text })
    }
  }
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
