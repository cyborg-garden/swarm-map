// The in-cell tool gate: a Pi extension. Before any tool runs it asks the
// sidecar, through Pi's extension UI channel, and blocks unless the answer is
// a yes to this exact call. A timeout, a cancel, a missing channel or any
// error blocks.
//
// What it does, in order, for one call:
//   1. A file tool's path is followed, links and all, and refused unless it
//      stays in the scratch folder. The tool is then handed the full, plain
//      path that was checked, so nothing reads the path another way.
//   2. A shell call is given a time limit, or keeps a shorter one of its own.
//   3. The call as it now stands is put to the sidecar. The only answer that
//      lets it run is `allow:` and the hash of that call. The sidecar's yes
//      carries the hash of what it decided on (and, in ask mode, of what an
//      admin was shown), so a yes meant for another call does not fit.
//   4. If the call changed while it waited, it does not run.
// And after a tool has run, its output is cut to a size before the model sees it.
//
// It also gives Pi one tool of the door's own: `memory_note`. That tool does
// nothing in the cell. It hands the request to the door through the same
// channel, as an `input` dialog, and gives the model the door's answer. The
// door decides, checks, writes and receipts (lib/door/memory.ts). Pi only
// declares it when the door lists it for a turn, like every other tool.
//
// When the session starts it says so on the same channel (GATE_READY). The
// shim sends Pi no turn until it has seen that, so a Pi that came up without
// this file loaded never gets a prompt, and so never calls a tool ungated.
//
// This is a guardrail, not a wall. It runs inside the cell, where the model
// may have a shell. It stops mistakes, and it holds a model to what a person
// approved, because the model does not run this file. What is meant to stop
// an attack is a cell with no route out and no real key in it. The lab's
// Docker cell is one: with this gate swapped for one that lets everything
// run, nothing left the cell and no secret was readable (check C10). There,
// this file sits on a read-only disk, owned by root, and the cell cannot
// change it (check S2).
//
// It imports Node and two small files of lib/core, which a cell image holds
// beside it. The few Pi types it needs are declared here by hand, from Pi 1.5.2.
import { lstatSync, realpathSync } from 'node:fs'
import { canonicalJson } from '../../../core/policy/canonical.ts'
import { callHash, confine, DEFAULT_TOOL_LIMITS, type PathLookup } from '../../../core/tools/call.ts'

interface PiToolCallEvent { toolName: string; toolCallId: string; input: unknown }
interface PiContent { type: string; text?: string }
interface PiToolResultEvent { toolName: string; content?: PiContent[] }
interface PiContext {
  hasUI: boolean
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined>
    notify(message: string, type?: 'info' | 'warning' | 'error'): void
  }
}
interface PiBlock { block: true; reason: string }
interface PiDialogContext { hasUI: boolean; ui: { input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined> } }
interface PiToolResult { content: PiContent[]; details: Record<string, never> }
export interface PiToolDefinition {
  name: string
  label: string
  description: string
  /** JSON Schema. Pi checks a call's arguments against it before anything runs. */
  parameters: Record<string, unknown>
  execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: PiDialogContext): Promise<PiToolResult>
}
export interface PiApi {
  registerTool(tool: PiToolDefinition): void
  on(event: 'session_start', handler: (event: unknown, ctx: PiContext) => Promise<void>): void
  on(event: 'tool_call', handler: (event: PiToolCallEvent, ctx: PiContext) => Promise<PiBlock | undefined>): void
  on(event: 'tool_result', handler: (event: PiToolResultEvent, ctx: PiContext) => Promise<{ content: PiContent[] } | undefined>): void
}

// The same two strings as in ../rpc.ts.
const GATE_PREFIX = 'swarm-gate:v1:'
const GATE_READY = 'swarm-gate:v1:ready'
// The same string as in ../rpc.ts: a request for one of the door's own tools.
const DOOR_PREFIX = 'swarm-door:v1:'
/** The door's tool for its notes. Same name as MEMORY_TOOL in lib/door/memory.ts. */
export const MEMORY_TOOL = 'memory_note'

/** What the model is told the tool is for. The rules it is held to are the door's. */
export const MEMORY_TOOL_DEFINITION: Omit<PiToolDefinition, 'execute'> = {
  name: MEMORY_TOOL,
  label: 'Memory note',
  description: [
    'Ask the door to change the notes it keeps for this room. They are given back to you when a conversation starts, after a restart too.',
    'file: room (about this room), people (about the person speaking, only when they asked you to remember them), threads (what is still going on).',
    'op: add a note, replace one (old is the exact note, text the new one), or remove one (old is the exact note).',
    'When a person asks you to forget them, use file people, op remove, with no old and no text: every note of theirs here is removed.',
    'One short line per note. Notes name nobody, and hold no secret: the door refuses those and says why. A person\'s notes are given only to them or an admin; the room and thread notes, to everyone here.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', enum: ['room', 'people', 'threads'] },
      op: { type: 'string', enum: ['add', 'replace', 'remove'] },
      text: { type: 'string', description: 'The note, one line.' },
      old: { type: 'string', description: 'The exact note to replace or remove. Left out on a people remove: all of the speaker\'s notes.' },
    },
    required: ['file', 'op'],
    additionalProperties: false,
  },
}

/** Pi's tools that take a path. Every one of them names it `path`. */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find'])
const SHELL_TOOL = 'bash'

const DISK: PathLookup = {
  realpath: (p) => realpathSync(p),
  exists: (p) => { try { lstatSync(p); return true } catch { return false } },
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A whole number above zero from the environment, or the fallback on anything else. */
const setting = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
const block = (why: string): PiBlock => ({ block: true, reason: `swarm gate: ${why}` })

/** Cut text to its first or last `max` bytes, with a note that says so. */
function cut(text: string, max: number, keep: 'start' | 'end'): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return text
  const left = bytes.length - max
  return keep === 'start'
    ? `${bytes.subarray(0, max).toString()}\n[cut: ${left} more bytes of output were left out]`
    : `[cut: the first ${left} bytes of output were left out]\n${bytes.subarray(left).toString()}`
}

/**
 * The gate. Its parts can only be switched off by a file that says so in its
 * source: the conformance suite does, to show the checks for each part go red
 * without it (conformance/broken). Nothing in a cell's environment can.
 */
export function createGate(parts: { confine: boolean; limits: boolean } = { confine: true, limits: true }): (pi: PiApi) => void {
  return (pi) => {
    pi.registerTool({
      ...MEMORY_TOOL_DEFINITION,
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const say = (text: string): PiToolResult => ({ content: [{ type: 'text', text }], details: {} })
        try {
          if (!ctx?.hasUI) return say('Not saved: there is no channel to the door.')
          const answer = await ctx.ui.input(DOOR_PREFIX + JSON.stringify({ tool: MEMORY_TOOL, input: params, callId: toolCallId }), '', { timeout: setting('SWARM_GATE_TIMEOUT_MS', 30_000) })
          return say(typeof answer === 'string' && answer !== '' ? answer : 'Not saved: the door did not answer.')
        } catch {
          return say('Not saved: the door could not be asked.')
        }
      },
    })
    pi.on('session_start', async (_event, ctx) => {
      // If this cannot be said, the shim never sends a turn. That is the safe side.
      ctx.ui.notify(GATE_READY, 'info')
    })
    pi.on('tool_call', async (event, ctx) => {
      try {
        // The door's own tool asks the door itself when it runs, and does nothing in the cell.
        if (event.toolName === MEMORY_TOOL) return undefined
        if (!ctx.hasUI) return block('no channel to the sidecar')
        const input = event.input
        if (parts.confine && FILE_TOOLS.has(event.toolName)) {
          if (!isRecord(input)) return block('not a call it can read')
          const where = confine(process.env.SWARM_WORKSPACE ?? '', input.path === undefined ? '' : input.path, DISK)
          if ('problem' in where) return block(where.problem)
          input.path = where.path
        }
        if (parts.limits && event.toolName === SHELL_TOOL) {
          if (!isRecord(input)) return block('not a call it can read')
          const limit = setting('SWARM_TOOL_SECONDS', DEFAULT_TOOL_LIMITS.callSeconds)
          const own = input.timeout
          input.timeout = typeof own === 'number' && own > 0 && own < limit ? own : limit
        }
        const timeout = setting('SWARM_GATE_TIMEOUT_MS', 30_000)
        const asked = canonicalJson(input)
        const yes = `allow:${callHash(event.toolName, input)}`
        const ask = GATE_PREFIX + JSON.stringify({ tool: event.toolName, input, callId: event.toolCallId })
        const answer = await ctx.ui.select(ask, [yes, 'deny'], { timeout })
        if (answer !== yes) return block('not allowed')
        if (canonicalJson(event.input) !== asked) return block('the call changed while it waited')
        return undefined
      } catch {
        return block('could not get a verdict')
      }
    })
    pi.on('tool_result', async (event) => {
      if (!parts.limits || !Array.isArray(event.content)) return undefined
      const max = setting('SWARM_TOOL_OUTPUT_BYTES', DEFAULT_TOOL_LIMITS.outputBytes)
      // Everything the model would be handed, as one text. A part that is not text counts for its size and is left out if over.
      const size = event.content.reduce((n, part) => n + Buffer.byteLength(typeof part?.text === 'string' ? part.text : JSON.stringify(part ?? null)), 0)
      if (size <= max) return undefined
      const text = event.content.map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '[left out: not text]')).join('\n')
      return { content: [{ type: 'text', text: cut(text, max, event.toolName === SHELL_TOOL ? 'end' : 'start') }] }
    })
  }
}

export default createGate()
