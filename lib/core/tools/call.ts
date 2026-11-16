// One tool call, as the door and the in-cell gate both have to see it: its
// hash, how it is written down for a person to approve, and whether a path it
// names stays in the scratch folder. Pure, and shared by every harness, so
// there is one way to hash a call and one way to show it. docs/lab/tools-slice.md.
//
// It imports Node and the canonical-JSON helper and nothing else, so a gate
// inside a cell can load it.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { canonicalJson } from '../policy/canonical.ts'

/** The classes of tool this slice can switch on. */
export const TOOL_SLICE_CLASSES = ['file_read', 'file_write', 'shell'] as const
export type SliceClass = typeof TOOL_SLICE_CLASSES[number]
export type ToolMode = 'never' | 'ask' | 'allow'

/** The limits a door and its cell are started with. */
export interface ToolLimits {
  /** Seconds one shell call may run. */
  callSeconds: number
  /** Bytes of one call's output that reach the model. */
  outputBytes: number
  /** Tool calls one conversation may make in an hour. */
  callsPerHour: number
  /** Megabytes the scratch folder may hold. */
  workspaceMb: number
}
export const DEFAULT_TOOL_LIMITS: ToolLimits = { callSeconds: 60, outputBytes: 16_000, callsPerHour: 30, workspaceMb: 64 }

/** The longest call, written out, that is shown for approval. A longer one is refused, never cut. */
export const MAX_SHOWN_CHARS = 1200

/** The hash an approval is tied to: the tool's name and its whole input, keys sorted. */
export function callHash(tool: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool, input })).digest('hex')
}

/** The short form of a call's hash that is shown in the room and written in receipts. */
export const shortHash = (hash: string): string => hash.slice(0, 12)

// Kept as they are: printable ASCII, less the three characters a chat surface gives a meaning to.
// `@` and `<` start a mention; a backtick ends a code block.
const PLAIN = /^[\x20-\x7e]$/
const MEANT = new Set(['@', '<', '`'])

/**
 * A call's input written down for a person: canonical JSON, with every
 * character that could hide, ping or break out of its block written as a
 * `\u` escape. It is still JSON, so reading it back gives the same input.
 * Returns why it cannot be shown when it is too long or cannot be written.
 */
export function showInput(input: unknown, maxChars: number = MAX_SHOWN_CHARS): { text: string } | { problem: string } {
  let json: string
  try { json = canonicalJson(input) } catch { return { problem: 'the call cannot be written down' } }
  // What cannot be written as JSON at all (a function, a number that is not finite) would not read back the same.
  let same = false
  try { same = canonicalJson(JSON.parse(json)) === json } catch { /* not JSON */ }
  if (!same) return { problem: 'the call cannot be written down' }
  let text = ''
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    text += PLAIN.test(ch) && !MEANT.has(ch) ? ch : `\\u${json.charCodeAt(i).toString(16).padStart(4, '0')}`
    if (text.length > maxChars) return { problem: 'the call is too long to show in full' }
  }
  return { text }
}

/** What a shown call says will run. Throws if the text is not one. */
export const readShown = (text: string): unknown => JSON.parse(text)

export interface PathLookup {
  /** The real path of something that exists. Throws when it does not, or cannot be followed. */
  realpath(p: string): string
  /** Whether a name is there at all, a link that leads nowhere included. */
  exists(p: string): boolean
}

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Where a path a file tool was given really leads, if that is inside the
 * scratch folder, or why it is refused. Links are followed for every part
 * that exists; a part that is there but leads nowhere is refused, so a tool
 * cannot be made to write through a link to somewhere that does not exist yet.
 * The path handed back is absolute and plain, and is what the tool should be
 * given in place of what was asked, so nothing reads the two differently.
 */
export function confine(root: string, given: unknown, fs: PathLookup): { path: string } | { problem: string } {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) return { problem: 'there is no scratch folder' }
  if (typeof given !== 'string' || given.includes('\0')) return { problem: 'that is not a path' }
  let home: string
  try { home = fs.realpath(root) } catch { return { problem: 'there is no scratch folder' } }
  let at = path.resolve(home, given === '' ? '.' : given)
  const rest: string[] = []
  let real: string
  for (;;) {
    try { real = fs.realpath(at); break } catch {
      // There, but it cannot be followed: a link to nowhere, or a loop.
      if (fs.exists(at)) return { problem: 'the path goes through a link that cannot be followed' }
      const up = path.dirname(at)
      if (up === at) return { problem: 'that is not a path' }
      rest.unshift(path.basename(at))
      at = up
    }
  }
  const whole = path.join(real, ...rest)
  return within(whole, home) ? { path: whole } : { problem: 'the path is outside the scratch folder' }
}
