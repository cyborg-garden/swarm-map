// What an ACP client says to `session/request_permission`, and what it puts
// to the door first. Pure: no process, no socket.
//
// In ACP the agent asks and the client answers by picking one of the options
// the agent offered (allow_once, allow_always, reject_once, reject_always).
// The question is advisory: the agent is the one that runs the tool. So:
//
// - Only the once-options are ever picked. An "always" answer would let the
//   agent skip the next question, and then the door would not be asked. When
//   no once-option is offered, the answer is "cancelled", which every agent
//   must read as no.
// - A call is put to the door only if its kind is one the adapter maps to a
//   door tool name. Any other kind, `other` included, is refused here.
// - What the door is shown is worked out from the agent's own description of
//   the call, the same way every time, so the door's hash names it. A path
//   outside the scratch folder, or a shell that runs anywhere else, is
//   refused here without asking anyone.
import path from 'node:path'

/** The tool kinds ACP names. A kind not in this list is read as `other`. */
export const ACP_TOOL_KINDS = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'] as const
export type AcpToolKind = typeof ACP_TOOL_KINDS[number]

export interface PermissionOption { optionId: string; kind: string; name?: string }

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }

/** The ACP tool call, as the agent describes it: in a permission request, or in a `tool_call` / `tool_call_update`. */
export interface AcpToolCall {
  toolCallId?: unknown
  kind?: unknown
  title?: unknown
  status?: unknown
  rawInput?: unknown
  locations?: unknown
}

/**
 * The answer to a permission request. `allow` is the door's yes for exactly this call. Only an
 * option whose kind is allow_once or reject_once is ever picked; an "always" option is never
 * picked, whatever else is offered.
 */
export function pickOutcome(options: unknown, allow: boolean): PermissionOutcome {
  const list = Array.isArray(options) ? options as PermissionOption[] : []
  const want = allow ? 'allow_once' : 'reject_once'
  const option = list.find((o) => o !== null && typeof o === 'object' && o.kind === want && typeof o.optionId === 'string')
  return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' }
}

/** Whether an answer to a permission request lets the call run. Read the way an agent reads it. */
export function outcomeAllows(options: unknown, outcome: PermissionOutcome): boolean {
  if (outcome.outcome !== 'selected') return false
  const list = Array.isArray(options) ? options as PermissionOption[] : []
  const picked = list.find((o) => o?.optionId === outcome.optionId)
  return picked?.kind === 'allow_once' || picked?.kind === 'allow_always'
}

export type Classified =
  | { ok: true; tool: string; kind: AcpToolKind; input: Record<string, unknown> }
  | { ok: false; why: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** Whether `p` is the scratch folder or under it, read as a plain path from it. Links are not followed: see the doc page. */
export function insideFolder(folder: string, p: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(folder, p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const pathOf = (input: Record<string, unknown>): string | undefined =>
  str(input.filePath) ?? str(input.filepath) ?? str(input.path)

/** Every path a call names: its input's own, and the locations the agent listed. */
function pathsNamed(call: AcpToolCall, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['filePath', 'filepath', 'path', 'movePath', 'cwd', 'workdir']) {
    const v = str(input[key])
    if (v) out.push(v)
  }
  if (Array.isArray(input.files)) {
    for (const f of input.files) for (const key of ['filePath', 'movePath']) { const v = str(obj(f)[key]); if (v) out.push(v) }
  }
  if (Array.isArray(call.locations)) for (const l of call.locations) { const v = str(obj(l).path); if (v) out.push(v) }
  return out
}

/** Whether any path the call names (in its input, or in its locations) is outside the scratch folder. */
export function namesPathOutside(call: AcpToolCall, workDir: string): boolean {
  return pathsNamed(call, obj(call.rawInput)).some((p) => !insideFolder(workDir, p))
}

/**
 * Work out the door's view of one call: its tool name and the input the door is shown and hashes.
 * `kinds` is the adapter's map from ACP kind to its own tool name. `seen` is the same call as the
 * agent last reported it in a tool_call update, for an agent whose permission request leaves the
 * input out (OpenCode's read asks with an empty one).
 */
export function classifyCall(call: AcpToolCall, kinds: Partial<Record<AcpToolKind, string>>, workDir: string, seen?: AcpToolCall): Classified {
  const kind = (ACP_TOOL_KINDS as readonly string[]).includes(call.kind as string) ? call.kind as AcpToolKind : 'other'
  const tool = kinds[kind]
  if (!tool) return { ok: false, why: `a tool of kind ${kind} is not one the door can classify` }
  const asked = obj(call.rawInput)
  const before = obj(seen?.rawInput)
  for (const p of [...pathsNamed(call, asked), ...pathsNamed(seen ?? {}, before)]) {
    if (!insideFolder(workDir, p)) return { ok: false, why: 'the call names a path outside the scratch folder' }
  }
  if (kind === 'execute') {
    const command = str(asked.command) ?? str(asked.cmd) ?? str(before.command) ?? str(before.cmd)
    if (!command) return { ok: false, why: 'a shell call with no command' }
    // The door's command policy reads a call that is a command and nothing else. A time limit is kept, as it is part of what runs.
    const timeout = asked.timeout ?? before.timeout
    return { ok: true, tool, kind, input: { command, ...(typeof timeout === 'number' ? { timeout } : {}) } }
  }
  if (kind === 'read') {
    const p = pathOf(asked) ?? pathOf(before) ?? (Array.isArray(call.locations) ? str(obj(call.locations[0]).path) : undefined)
    if (!p) return { ok: false, why: 'a read that names no file' }
    return { ok: true, tool, kind, input: { path: p } }
  }
  if (kind === 'edit') {
    const p = pathOf(asked) ?? pathOf(before)
    if (!p) return { ok: false, why: 'an edit that names no file' }
    // What is shown has to say what changes. An edit that asks with no diff would be a yes to a file, not to a change.
    const diff = str(asked.diff)
    if (diff === undefined) return { ok: false, why: 'an edit that does not show its change' }
    return { ok: true, tool, kind, input: { path: p, diff } }
  }
  // A kind the adapter maps but this file has no reading for: refused rather than shown half.
  return { ok: false, why: `a tool of kind ${kind} has no reading here` }
}

/**
 * What must stay the same between the call the door said yes to and what the agent then says it
 * is running: the command of a shell, the file of a read or an edit. Undefined when the update
 * does not say.
 */
export function identityOf(kind: AcpToolKind, rawInput: unknown): string | undefined {
  const input = obj(rawInput)
  if (kind === 'execute') return str(input.command) ?? str(input.cmd)
  if (kind === 'read' || kind === 'edit') return pathOf(input)
  return undefined
}
