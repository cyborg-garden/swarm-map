// Notes that outlive a restart, kept by the door, not by the harness.
// docs/lab/persona-memory.md.
//
// One folder per room, on the host, in the agent's state folder. Each holds
// three small Markdown files of one-line notes:
//
//   room.md     about this room: what it is for, what people here care about
//   people.md   about a person, only one who asked to be remembered
//   threads.md  what is still going on: a question being worked on, a promise
//
// The harness never touches these files. It is handed a room's notes at the
// start of a conversation, and it can ask the door to change them with one
// tool (`memory_note`). The door checks every change, writes it, and answers
// with what it did. A dashboard user can read, edit, wipe and download them.
//
// A room's notes never go to another room: the folder is named by the room,
// and the door only ever reads the folder of the room a message came from.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Sanitizer } from './sanitizer.ts'

export const MEMORY_FILES = ['room', 'people', 'threads'] as const
export type MemoryFile = (typeof MEMORY_FILES)[number]

export const MEMORY_LIMITS = {
  /** One note, in characters. */
  noteChars: 280,
  /** One file, in bytes. A file that would grow past this refuses the note. */
  fileBytes: 4096,
  /** One person's notes in a room. So one person cannot fill the people file and keep everyone else from being remembered. */
  notesPerPerson: 8,
} as const

/** The heading each file is shown under, to the agent and on the dashboard. */
export const MEMORY_HEADINGS: Record<MemoryFile, string> = {
  room: 'About this room',
  people: 'People who asked to be remembered',
  threads: 'Ongoing threads',
}

/** The tool's name, as the harness declares it. Its class is `memory`. */
export const MEMORY_TOOL = 'memory_note'

/**
 * Words that count as a person asking to be remembered, in their own message.
 * Without one, a note about them is refused. It is a word check, not an
 * understanding: "do you remember..." passes it too, so the model is also told
 * to keep a note only when asked. "Forget" is not needed to remove your own
 * notes: anyone may take their own card down, one note or all of them at once.
 */
export const ASKED_TO_REMEMBER = /\b(remember|don'?t forget|do not forget|note that)\b/i

export interface Speaker { id: string; display: string }
export interface NoteContext {
  /** Who sent the message that started this turn, by the id the chat surface gave. */
  speaker: Speaker
  /** Whether that message asked to be remembered (ASKED_TO_REMEMBER). */
  asked: boolean
  /**
   * Whether this turn may change the notes everyone in the room is given (room, threads). False on
   * an agent anyone can talk to, unless an admin started the turn: a stranger cannot plant a note
   * for the whole room. A person's own note is theirs either way. Left out, true.
   */
  shared?: boolean
}
export interface NoteResult {
  ok: boolean
  /** A short code for the receipt. Never note text. */
  code: string
  /** What the agent is told. */
  message: string
}

export interface RoomNotes {
  /** The room's key, as the door names it: `surface:room`. */
  key: string
  files: Record<MemoryFile, string>
  bytes: number
}

export interface MemoryStore {
  /** A room's notes as the agent is given them, or undefined when there are none. Redacted. */
  render(room: string): string | undefined
  /** A change the agent asked for, checked and written. */
  apply(room: string, input: unknown, ctx: NoteContext): NoteResult
  /** Every room that has notes. Redacted. For the dashboard. */
  rooms(): RoomNotes[]
  /** Replace one room's files with what a dashboard user wrote. Returns every reason it is refused; empty when written. */
  replace(room: string, files: Partial<Record<MemoryFile, string>>): string[]
  /** Remove one room's notes, or every room's. */
  wipe(room?: string): void
}

// Control characters, and the invisible format characters (zero-width, direction overrides) that
// would let a note hide a mention, an id or a word from the checks below or from a person reading it.
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]|\p{Cf}/u
// What would let a note name somebody who did not ask: a mention, a platform id, an email address.
const NAMES_SOMEONE: { what: string; re: RegExp }[] = [
  { what: 'a mention', re: /<[@#][!&]?\d+>/ },
  { what: 'a platform id', re: /\b\d{15,22}\b/ },
  { what: 'an email address', re: /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/ },
]

/** A room's folder name: a hash of its key, so the key is never used as a path. */
export function roomFolder(room: string): string {
  return createHash('sha256').update(room).digest('hex').slice(0, 16)
}

const bytes = (s: string): number => Buffer.byteLength(s)

/** Why a note cannot be kept, or undefined if it can. Run on what the agent asks for and on what a dashboard user writes. */
export function noteProblem(text: unknown, sanitizer: Sanitizer, o: { checkNames: boolean }): string | undefined {
  if (typeof text !== 'string') return 'a note is text'
  const t = text.trim()
  if (t === '') return 'a note cannot be empty'
  if (CONTROL.test(t)) return 'a note is one line of plain text'
  if ([...t].length > MEMORY_LIMITS.noteChars) return `a note is at most ${MEMORY_LIMITS.noteChars} characters`
  // The same check the door runs on everything it posts. A note it would change is not kept at all.
  let clean: ReturnType<Sanitizer['run']>
  try { clean = sanitizer.run('outbound', t, { posture: 'team', room: { id: '', kind: 'channel' } }) } catch { return 'the note could not be checked' }
  if (clean.findings.length > 0 || clean.text !== t) return 'it holds something that looks like a secret'
  if (o.checkNames) for (const { what, re } of NAMES_SOMEONE) if (re.test(t)) return `it holds ${what}. Notes name nobody; a note about a person goes in people, and only about the person who asked`
  return undefined
}

// people.md: one line per note, `- [<id>] <name>: <text>`. The id is the speaker's, written by the door.
const PERSON_LINE = /^- \[([^\]\s]{1,64})\] ([^:\n]{0,40}): (.*)$/
const cleanName = (display: string): string => [...display.replace(/[\u0000-\u001f\u007f\u2028\u2029[\]:]/g, ' ').trim()].slice(0, 40).join('') || 'someone'

const entries = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('- '))
const noteOf = (line: string, file: MemoryFile): string => (file === 'people' ? PERSON_LINE.exec(line)?.[3] ?? '' : line.slice(2))
const ownerOf = (line: string): string | undefined => PERSON_LINE.exec(line)?.[1]

export function createMemoryStore(o: {
  dir: string
  sanitizer: Sanitizer
  /**
   * Off only in a file that says so in its source: the conformance suite does,
   * to show that the check for a refused note goes red without it
   * (conformance/broken). Nothing a running agent is given can turn it off.
   */
  checks?: boolean
}): MemoryStore {
  const checks = o.checks !== false
  const folder = (room: string): string => path.join(o.dir, roomFolder(room))
  const fileOf = (room: string, f: MemoryFile): string => path.join(folder(room), `${f}.md`)
  const redact = (text: string): string => {
    try { return o.sanitizer.run('outbound', text, { posture: 'team', room: { id: '', kind: 'channel' } }).text } catch { return '' }
  }
  const read = (room: string): Record<MemoryFile, string> => {
    const out = {} as Record<MemoryFile, string>
    for (const f of MEMORY_FILES) {
      let text = ''
      try { text = readFileSync(fileOf(room, f), 'utf8') } catch { /* no file is no notes */ }
      out[f] = text
    }
    return out
  }
  const ensure = (room: string): void => {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 })
    mkdirSync(folder(room), { recursive: true, mode: 0o700 })
    chmodSync(folder(room), 0o700)
    // Which room this folder is, for the dashboard. The key is the platform's room id, not a person's.
    const keyFile = path.join(folder(room), 'room.json')
    if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify({ key: room }) + '\n', { mode: 0o600 })
  }
  // Written beside, then moved into place: a reader sees the old file or the new one, never half of one.
  const write = (room: string, f: MemoryFile, lines: string[]): void => {
    ensure(room)
    const target = fileOf(room, f)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 })
    renameSync(tmp, target)
  }
  const refuse = (code: string, message: string): NoteResult => ({ ok: false, code, message: `Not saved: ${message}.` })

  return {
    render(room) {
      const files = read(room)
      const parts = MEMORY_FILES.flatMap((f) => {
        const lines = entries(files[f])
        return lines.length === 0 ? [] : [`${MEMORY_HEADINGS[f]}:`, ...lines.map(redact)]
      })
      return parts.length === 0 ? undefined : parts.join('\n')
    },

    apply(room, input, ctx) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) return refuse('bad-input', 'the tool takes file, op and text')
      const { file, op, text, old } = input as Record<string, unknown>
      if (!MEMORY_FILES.includes(file as MemoryFile)) return refuse('bad-file', `file is one of ${MEMORY_FILES.join(', ')}`)
      if (op !== 'add' && op !== 'replace' && op !== 'remove') return refuse('bad-op', 'op is add, replace or remove')
      const f = file as MemoryFile
      const lines = entries(read(room)[f])
      const mine = (line: string): boolean => f !== 'people' || ownerOf(line) === ctx.speaker.id
      const lineFor = (t: string): string => (f === 'people' ? `- [${ctx.speaker.id}] ${cleanName(ctx.speaker.display)}: ${t}` : `- ${t}`)
      if (f !== 'people' && ctx.shared === false) return refuse('not-admin', 'here, a note about the room or a thread is only kept when an admin asks for it')
      // A note about a person is about the one who is speaking, and only when they asked for it.
      if (f === 'people' && op !== 'remove' && !ctx.asked) {
        return refuse('not-asked', 'a note about a person is only kept when that person asks you to remember something, in their own message')
      }
      let next = lines
      if (op === 'add' || op === 'replace') {
        const problem = checks ? noteProblem(text, o.sanitizer, { checkNames: true }) : typeof text === 'string' && text.trim() !== '' ? undefined : 'a note cannot be empty'
        if (problem) return refuse(problem.startsWith('it holds something that looks like a secret') ? 'secret' : 'bad-note', problem)
      }
      // "Forget me": a person's remove with no note named takes down every note of theirs in this room.
      if (f === 'people' && op === 'remove' && old === undefined && text === undefined) {
        next = lines.filter((line) => !mine(line))
        if (next.length === lines.length) return refuse('no-match', 'there is no note of the speaker\'s own here')
        write(room, f, next)
        return { ok: true, code: 'remove', message: `Removed ${lines.length - next.length === 1 ? 'their note' : `all ${lines.length - next.length} of their notes`}.` }
      }
      if (op === 'replace' || op === 'remove') {
        const target = typeof old === 'string' ? old.trim() : op === 'remove' && typeof text === 'string' ? text.trim() : ''
        const at = lines.findIndex((line) => mine(line) && noteOf(line, f) === target)
        if (target === '' || at < 0) return refuse('no-match', f === 'people' ? 'no note of the speaker\'s own says exactly that' : 'no note says exactly that')
        next = op === 'remove' ? lines.filter((_, i) => i !== at) : lines.map((line, i) => (i === at ? lineFor((text as string).trim()) : line))
      } else {
        const t = (text as string).trim()
        if (lines.some((line) => mine(line) && noteOf(line, f) === t)) return { ok: true, code: 'same', message: 'Already noted. Nothing changed.' }
        if (f === 'people' && lines.filter(mine).length >= MEMORY_LIMITS.notesPerPerson) return refuse('full', `a person may have at most ${MEMORY_LIMITS.notesPerPerson} notes here. Remove or replace one of theirs first`)
        next = [...lines, lineFor(t)]
      }
      if (bytes(next.join('\n') + '\n') > MEMORY_LIMITS.fileBytes) return refuse('full', `${f} is full (${MEMORY_LIMITS.fileBytes} bytes). Remove or replace a note first`)
      write(room, f, next)
      return { ok: true, code: op, message: op === 'add' ? 'Saved. The door keeps it for this room.' : op === 'replace' ? 'Replaced.' : 'Removed.' }
    },

    rooms() {
      if (!existsSync(o.dir)) return []
      const out: RoomNotes[] = []
      for (const name of readdirSync(o.dir).sort()) {
        let key: unknown
        try { key = (JSON.parse(readFileSync(path.join(o.dir, name, 'room.json'), 'utf8')) as { key?: unknown }).key } catch { continue }
        if (typeof key !== 'string' || roomFolder(key) !== name) continue
        const files = read(key)
        const shown = Object.fromEntries(MEMORY_FILES.map((f) => [f, redact(files[f])])) as Record<MemoryFile, string>
        out.push({ key, files: shown, bytes: MEMORY_FILES.reduce((n, f) => n + bytes(files[f]), 0) })
      }
      return out
    },

    replace(room, files) {
      const problems: string[] = []
      const next: Partial<Record<MemoryFile, string[]>> = {}
      for (const [f, text] of Object.entries(files)) {
        if (!MEMORY_FILES.includes(f as MemoryFile)) { problems.push(`${f}: not a notes file`); continue }
        if (typeof text !== 'string') { problems.push(`${f}: must be text`); continue }
        const lines: string[] = []
        text.split('\n').map((l) => l.trim()).filter((l) => l !== '').forEach((raw, i) => {
          const line = raw.startsWith('- ') ? raw : `- ${raw.replace(/^-\s*/, '')}`
          const note = f === 'people' ? PERSON_LINE.exec(line)?.[3] : line.slice(2)
          if (note === undefined) { problems.push(`people, line ${i + 1}: write it as "- [id] name: note"`); return }
          // A dashboard user may name people here; secrets and size are refused all the same.
          const problem = noteProblem(note, o.sanitizer, { checkNames: false })
          if (problem) problems.push(`${f}, line ${i + 1}: ${problem}`)
          else lines.push(line)
        })
        if (bytes(lines.join('\n') + '\n') > MEMORY_LIMITS.fileBytes) problems.push(`${f}: more than ${MEMORY_LIMITS.fileBytes} bytes`)
        next[f as MemoryFile] = lines
      }
      if (problems.length > 0) return problems
      for (const [f, lines] of Object.entries(next)) write(room, f as MemoryFile, lines as string[])
      return []
    },

    wipe(room) {
      if (room === undefined) rmSync(o.dir, { recursive: true, force: true })
      else rmSync(folder(room), { recursive: true, force: true })
    },
  }
}
