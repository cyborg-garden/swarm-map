// The command policy: which shell commands run without an admin's yes, which
// wait for one, and which never run. docs/lab/tools-slice.md, "The command policy".
//
// A command is read whole, by a small shell reader of our own. It understands
// words, quotes, backslashes, the joining operators (| || && ; and a new line)
// and redirections. It does not try to understand anything else: a
// substitution, a variable, a glob, a group, a here-doc, a comment, a
// background job, a line that runs on. Any of those makes the command ask.
// So "allow" is only ever said about a command this file read all of, every
// part of which is on the allow list with arguments that change nothing.
//
// "block" is said about anything clearly destructive or that reaches for the
// network, wherever it sits: after a semicolon, inside $( ), behind sudo or
// xargs, inside `sh -c '…'`. That search is looser on purpose. It reads past
// what the strict reader gives up on, so a block is found even in a command
// that would otherwise only ask.
//
// Pure, and it imports only node:path, so the door and a cell can both load it.
import path from 'node:path'
import { SHIPPED_ALLOW, SHIPPED_BLOCK } from './command-defaults.ts'

export interface CommandLists {
  /** Command names that run without a yes, when every other part of the command is plain too. */
  allow: string[]
  /** Command names that never run. Beats the allow list. */
  block: string[]
}

export type CommandVerdict = { verdict: 'allow' | 'ask' | 'block'; rule: string }

export const DEFAULT_COMMANDS: CommandLists = { allow: [...SHIPPED_ALLOW], block: [...SHIPPED_BLOCK] }

/**
 * Names that can never be on the allow list, whatever an operator writes:
 * shells, interpreters and anything that runs another command. Allowing one
 * would let a yes be skipped for a script the agent wrote (`sh run.sh`), or for
 * a command wrapped in another.
 */
export const NEVER_ALLOWED = [
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'fish', 'csh', 'tcsh', 'busybox', 'eval', 'exec', 'source', '.', 'command', 'builtin',
  'env', 'xargs', 'sudo', 'su', 'doas', 'nohup', 'setsid', 'timeout', 'nice', 'ionice', 'stdbuf', 'time', 'watch', 'chroot',
  'nsenter', 'unshare', 'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua',
  'awk', 'gawk', 'mawk', 'sed', 'make', 'git', 'tar', 'vi', 'vim', 'emacs', 'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3',
  'parallel', 'at', 'batch', 'crontab', 'script', 'expect', 'strace', 'gdb',
]

/** Words that run what follows them as a command. What they wrap is searched for a block. */
const WRAPPERS = new Set([
  'sudo', 'doas', 'su', 'env', 'command', 'builtin', 'exec', 'nohup', 'setsid', 'timeout', 'nice', 'ionice', 'stdbuf',
  'time', 'watch', 'xargs', 'busybox', 'chroot', 'nsenter', 'unshare', 'parallel',
])
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])

const NAME = /^[a-z0-9][a-z0-9._+-]{0,31}$/
const MAX_CHARS = 2000
const MAX_LIST = 200

/** Why a pair of lists cannot be used, one line each. Empty when they can. */
export function commandListsProblems(lists: unknown): string[] {
  if (lists === null || typeof lists !== 'object' || Array.isArray(lists)) return ['must be an object with allow and block lists']
  const out: string[] = []
  for (const key of ['allow', 'block'] as const) {
    const v = (lists as Record<string, unknown>)[key]
    if (!Array.isArray(v)) { out.push(`${key}: must be a list of command names`); continue }
    if (v.length > MAX_LIST) out.push(`${key}: at most ${MAX_LIST} names`)
    v.forEach((name, i) => {
      if (typeof name !== 'string' || !NAME.test(name)) out.push(`${key}[${i}]: a plain command name, lower-case letters, digits and . _ + -, up to 32 characters`)
      else if (key === 'allow' && NEVER_ALLOWED.includes(name)) out.push(`${key}[${i}]: ${name} runs other commands or scripts, so it always asks`)
    })
  }
  for (const k of Object.keys(lists)) if (k !== 'allow' && k !== 'block') out.push(`${k}: not a setting`)
  return out
}

// ---------------------------------------------------------------------------
// Reading a command

interface Redir { op: string; target: string }
interface Simple { words: string[]; redirs: Redir[]; background: boolean }
type Read = { ok: true; commands: Simple[] } | { ok: false; code: string }

// Not /var or /tmp: a scratch folder can sit under either (macOS keeps its temporary folders in /var).
const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/dev', '/proc', '/sys',
  '/opt', '/root', '/home', '/srv', '/run', '/mnt', '/media', '/System', '/Library']
const HARMLESS_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

function isSystemPath(p: string): boolean {
  if (!p.startsWith('/')) return false
  const n = path.posix.normalize(p)
  if (HARMLESS_SINKS.has(n)) return false
  return n === '/' || SYSTEM_DIRS.some((d) => n === d || n.startsWith(`${d}/`))
}

/**
 * The strict reader. It gives up, with a code, at the first thing it does not
 * fully understand. When it returns commands, each word is exactly the text a
 * shell would hand the program.
 */
function readStrict(s: string): Read {
  const fail = (code: string): Read => ({ ok: false, code })
  const commands: Simple[] = []
  let cur: Simple = { words: [], redirs: [], background: false }
  let word = ''
  let started = false
  let wordStart = 0
  let quoted = false
  let pending: string | undefined // a redirection still waiting for its target
  let lastOp: string | undefined

  const endWord = (): Read | undefined => {
    if (!started) return undefined
    if (pending !== undefined) {
      cur.redirs.push({ op: pending, target: word })
      pending = undefined
    } else {
      // VAR=value before a command sets the environment it runs in.
      if (cur.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(s.slice(wordStart))) return fail('ask:env-prefix')
      cur.words.push(word)
    }
    word = ''; started = false; quoted = false
    return undefined
  }
  const endCommand = (op: string): Read | undefined => {
    if (pending !== undefined) return fail('ask:unparsed')
    if (cur.words.length === 0) {
      // A blank line, or the end after `;`, is nothing. After | || && there has to be a command, and `;` needs one before it.
      const joined = lastOp !== undefined && ['|', '||', '&&', '|&'].includes(lastOp)
      if (cur.redirs.length === 0 && !joined && (op === '\n' || op === 'end')) return undefined
      return fail('ask:unparsed')
    }
    if (op === '&') cur.background = true
    commands.push(cur)
    cur = { words: [], redirs: [], background: false }
    return undefined
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') { const e = endWord(); if (e) return e; i++; continue }
    if (c === '\n' || c === ';') {
      if (c === ';' && s[i + 1] === ';') return fail('ask:unparsed')
      const e = endWord() ?? endCommand(c); if (e) return e
      lastOp = c; i++; continue
    }
    if (c === '|' || c === '&') {
      let op: string = c
      if (c === '&' && s[i + 1] === '>') {
        const e = endWord(); if (e) return e
        if (pending !== undefined) return fail('ask:unparsed')
        const append = s[i + 2] === '>'
        pending = append ? '&>>' : '&>'
        i += append ? 3 : 2
        continue
      }
      if (s[i + 1] === c) op = c + c
      else if (c === '|' && s[i + 1] === '&') op = '|&'
      const e = endWord() ?? endCommand(op); if (e) return e
      lastOp = op; i += op.length; continue
    }
    if (c === '<' || c === '>') {
      // A word of digits right before, with nothing between, names the file descriptor.
      let fd = ''
      if (started && !quoted && /^\d+$/.test(word) && s.slice(wordStart, i) === word) { fd = word; word = ''; started = false }
      const e = endWord(); if (e) return e
      if (pending !== undefined) return fail('ask:unparsed')
      let op = c
      const next = s[i + 1]
      if (c === '>' && (next === '>' || next === '|' || next === '&')) op += next
      else if (c === '<' && next === '<') return fail('ask:redirect') // here-doc or here-string
      else if (c === '<' && (next === '>' || next === '&')) op += next
      if (op === '<>') return fail('ask:redirect')
      if (s[i + op.length] === '(') return fail('ask:unparsed') // process substitution
      pending = `${fd}${op}`
      i += op.length
      continue
    }
    if (c === '\\') {
      if (i + 1 >= s.length || s[i + 1] === '\n') return fail('ask:unparsed')
      if (!started) wordStart = i
      word += s[i + 1]; started = true; quoted = true; i += 2; continue
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) return fail('ask:unparsed')
      if (!started) wordStart = i
      word += s.slice(i + 1, end); started = true; quoted = true; i = end + 1; continue
    }
    if (c === '"') {
      if (!started) wordStart = i
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j]
        if (d === '$' || d === '`') return fail('ask:expansion')
        if (d === '\\') {
          const e = s[j + 1]
          if (e === undefined || e === '\n') return fail('ask:unparsed')
          if (e === '$' || e === '`' || e === '"' || e === '\\') { word += e; j++; continue }
        }
        word += d
      }
      if (j >= s.length) return fail('ask:unparsed')
      started = true; quoted = true; i = j + 1; continue
    }
    if (c === '$' || c === '`') return fail('ask:expansion')
    if ('(){}!'.includes(c)) return fail('ask:unparsed')
    if (c === '#' && !started) return fail('ask:comment')
    if ('*?['.includes(c) || (c === '~' && !started)) return fail('ask:glob')
    if (!started) { wordStart = i; started = true }
    word += c
    i++
  }
  const e = endWord() ?? endCommand('end'); if (e) return e
  if (commands.length === 0) return fail('ask:unparsed')
  return { ok: true, commands }
}

/**
 * The loose reader, for finding a block only. It never gives up: a
 * substitution, a group or a background job ends one command and starts the
 * next, a variable or a glob is read as plain text, and a quote that never
 * closes runs to the end. So `ls $(rm -rf /)` is read as `ls` and `rm -rf /`.
 */
function readLoose(s: string): Simple[] {
  const commands: Simple[] = []
  let cur: Simple = { words: [], redirs: [], background: false }
  let word = ''
  let started = false
  let pending: string | undefined
  const stack: ('dq' | 'paren' | 'tick')[] = []
  let inDq = false

  const endWord = (): void => {
    if (!started) return
    if (pending !== undefined) { cur.redirs.push({ op: pending, target: word }); pending = undefined }
    else if (!(cur.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) cur.words.push(word)
    word = ''; started = false
  }
  const endCommand = (): void => {
    endWord()
    pending = undefined
    if (cur.words.length > 0 || cur.redirs.length > 0) commands.push(cur)
    cur = { words: [], redirs: [], background: false }
  }
  const open = (kind: 'paren' | 'tick'): void => {
    if (inDq) { endWord(); stack.push('dq'); inDq = false }
    stack.push(kind)
    endCommand()
  }
  const close = (kind: 'paren' | 'tick'): boolean => {
    if (stack[stack.length - 1] !== kind) return false
    stack.pop()
    endCommand()
    if (stack[stack.length - 1] === 'dq') { stack.pop(); inDq = true }
    return true
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inDq) {
      if (c === '"') { inDq = false; continue }
      if (c === '$' && s[i + 1] === '(') { open('paren'); i++; continue }
      if (c === '`') { open('tick'); continue }
      if (c === '\\' && i + 1 < s.length) { word += s[++i]; started = true; continue }
      word += c; started = true
      continue
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      word += s.slice(i + 1, end < 0 ? s.length : end); started = true
      i = end < 0 ? s.length : end
      continue
    }
    if (c === '"') { inDq = true; started = true; continue }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i++; continue }
      if (i + 1 < s.length) { word += s[++i]; started = true }
      continue
    }
    if (c === '$' && s[i + 1] === '(') { open('paren'); i++; continue }
    if (c === '`') { if (!close('tick')) open('tick'); continue }
    if (c === ')') { if (!close('paren')) endCommand(); continue }
    if (c === '(' || c === '{' || c === '}') {
      // `{` and `}` mid-word are brace expansion: read them as plain text there.
      if ((c === '{' || c === '}') && started) { word += c; continue }
      endCommand(); continue
    }
    if (c === '#' && !started) { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl - 1; continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    if (c === '\n' || c === ';' || c === '|' || c === '&') {
      if (c === '&' && s[i + 1] === '>') { endWord(); pending = s[i + 2] === '>' ? '&>>' : '&>'; i += s[i + 2] === '>' ? 2 : 1; continue }
      endCommand()
      continue
    }
    if (c === '<' || c === '>') {
      let fd = ''
      if (started && /^\d+$/.test(word)) { fd = word; word = ''; started = false }
      endWord()
      let op = c
      const next = s[i + 1]
      if (next === '(') { endCommand(); i++; continue } // process substitution: what is inside is a command
      if (c === '>' && (next === '>' || next === '|' || next === '&')) op += next
      else if (c === '<' && (next === '<' || next === '>' || next === '&')) op += next
      if (op === '<<' && s[i + 2] === '<') op = '<<<'
      i += op.length - 1
      pending = `${fd}${op}`
      continue
    }
    word += c; started = true
  }
  endCommand()
  return commands
}

// ---------------------------------------------------------------------------
// Deciding

const flagsOf = (args: string[]): string[] => {
  const out: string[] = []
  for (const a of args) { if (a === '--') break; if (a.startsWith('-') && a !== '-') out.push(a) }
  return out
}
const operandsOf = (args: string[]): string[] => {
  const out: string[] = []
  let ended = false
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue }
    if (ended || !a.startsWith('-') || a === '-') out.push(a)
  }
  return out
}
const shortHas = (flag: string, letters: string): boolean => /^-[^-]/.test(flag) && [...flag.slice(1)].some((l) => letters.includes(l))

/** A path an rm reaches out of the scratch folder with, or one it cannot tell about. */
const leavesScratch = (p: string): boolean =>
  p === '' || p.startsWith('/') || p.startsWith('~') || p.includes('$') || p.includes('`') ||
  p.split('/').includes('..')

/** Options of each wrapper that take the next word as their value. */
const VALUE_OPTS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-R', '-T'], doas: ['-u', '-C'], su: ['-c', '-s', '-g', '-G'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p', '-P', '-u'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], stdbuf: ['-i', '-o', '-e'], watch: ['-n', '-d', '--interval'],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines'],
  exec: ['-a'], unshare: [], nsenter: ['-t', '--target'], chroot: ['--userspec', '--groups'], setsid: [], nohup: [], command: [], builtin: [],
  time: ['-f', '-o', '--format', '--output'], busybox: [], parallel: [],
}
/** Wrappers whose first plain word is a value of their own, not the command: a duration, a new root. */
const VALUE_FIRST = new Set(['timeout', 'chroot'])

/** Where the command a wrapper runs starts, or undefined if it names none. */
function wrappedAt(name: string, words: string[]): number | undefined {
  const takes = VALUE_OPTS[name] ?? []
  for (let k = 1; k < words.length; k++) {
    const w = words[k]
    if (w === '--') return k + 1 < words.length ? k + 1 + (VALUE_FIRST.has(name) ? 1 : 0) : undefined
    if (w.startsWith('-') && w !== '-') { if (takes.includes(w)) k++; continue }
    if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    const at = VALUE_FIRST.has(name) ? k + 1 : k
    return at < words.length ? at : undefined
  }
  return undefined
}

/** Whether one command, read loosely, is something that never runs. The rule if so. */
function blockOf(words: string[], redirs: Redir[], lists: CommandLists, depth: number): string | undefined {
  for (const r of redirs) {
    if (/^\d*(>|>>|>\||&>|&>>)$/.test(r.op) || (/^\d*>&$/.test(r.op) && !/^(\d+|-)$/.test(r.target))) {
      if (isSystemPath(r.target)) return 'block:redirect-system'
    }
  }
  if (words.length === 0 || depth > 4) return undefined
  const name = path.posix.basename(words[0])
  const args = words.slice(1)
  if (lists.block.includes(name)) return `block:${name}`
  if (name.startsWith('mkfs.') && lists.block.includes('mkfs')) return 'block:mkfs'
  if (name === 'rm') {
    const flags = flagsOf(args)
    const recursive = flags.some((f) => f === '--recursive' || shortHas(f, 'rR'))
    const targets = operandsOf(args)
    if (recursive && (targets.length === 0 || targets.some(leavesScratch))) return 'block:rm-recursive'
  }
  if (name === 'find' && args.includes('-delete')) {
    // The folders a find starts from come before its first test.
    const first = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!')
    const starts = first < 0 ? args : args.slice(0, first)
    if (starts.length === 0 || starts.some(leavesScratch)) return 'block:find-delete'
  }
  if (['chmod', 'chown', 'chgrp', 'chattr'].includes(name) && operandsOf(args).some(isSystemPath)) return 'block:chmod-system'
  if (name === 'kill' && args.includes('-1')) return 'block:kill-all'
  // What a wrapper runs is the command after its own options, so `sudo -u x rm -rf /` and `timeout 5 curl` are both
  // found, and `xargs grep curl` is not taken for curl. A wrapper is never allowed, so one read wrongly still asks.
  if (WRAPPERS.has(name)) {
    const at = wrappedAt(name, words)
    if (at !== undefined) {
      const inner = blockOf(words.slice(at), [], lists, depth + 1)
      if (inner) return inner
    }
    // `su -c '…'` and `env -S '…'` hand a whole command line over as one word.
    const s = args.findIndex((a) => (name === 'su' && a === '-c') || (name === 'env' && (a === '-S' || a === '--split-string')))
    if (s >= 0 && args[s + 1] !== undefined) {
      const inner = loosely(args[s + 1], lists, depth + 1)
      if (inner) return inner
    }
  }
  // What a shell is handed as a string is a command of its own.
  if (SHELLS.has(name)) {
    const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    if (at >= 0 && args[at + 1] !== undefined) {
      const inner = loosely(args[at + 1], lists, depth + 1)
      if (inner) return inner
    }
  }
  if (name === 'eval' && args.length > 0) return loosely(args.join(' '), lists, depth + 1)
  return undefined
}

// `name(){ … name | name & }`: a function that starts two of itself.
const FORK_BOMB = /(\S+?)\s*\(\s*\)\s*\{[^}]*?\1\s*\|\s*&?\s*\1/

function loosely(command: string, lists: CommandLists, depth: number): string | undefined {
  if (depth > 4) return undefined
  if (FORK_BOMB.test(command)) return 'block:fork-bomb'
  for (const c of readLoose(command)) {
    const b = blockOf(c.words, c.redirs, lists, depth)
    if (b) return b
  }
  return undefined
}

/** The few arguments that make a listed command write a file or set something. Any of them makes it ask. */
const ARG_CHECKS: Record<string, (args: string[]) => boolean> = {
  find: (args) => args.some((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a)),
  date: (args) => flagsOf(args).some((f) => shortHas(f, 's') || f.startsWith('--set')),
  sort: (args) => flagsOf(args).some((f) => shortHas(f, 'oT') || /^--(o|ou|out|outp|outpu|output|c|co|com|comp|compr|compre|compres|compress|compress-|compress-p|compress-pr|compress-pro|compress-prog|compress-progr|compress-progra|compress-program|t|te|tem|temp|tempo|tempor|tempora|temporar|temporary|temporary-|temporary-d|temporary-di|temporary-dir|temporary-dire|temporary-direc|temporary-direct|temporary-directo|temporary-director|temporary-directory)(=|$)/.test(f)),
  // file -C writes a compiled magic file.
  file: (args) => flagsOf(args).some((f) => shortHas(f, 'C') || /^--com/.test(f)),
  // uniq's second operand is a file it writes.
  uniq: (args) => operandsOf(args).length > 1,
}

/**
 * Classify a whole shell command. `block` if any part of it, read loosely,
 * is on the block list or clearly destructive. Otherwise `allow` only when
 * the strict reader understood all of it and every command in it is listed,
 * named plainly, with no argument that writes, and nothing is written by a
 * redirection. Otherwise `ask`.
 *
 * The rule names only codes and names from the lists, never anything the
 * command itself says, so it can be written in a receipt.
 */
export function classifyCommand(command: string, lists: CommandLists): CommandVerdict {
  const ask = (rule: string): CommandVerdict => ({ verdict: 'ask', rule })
  if (typeof command !== 'string') return ask('ask:unparsed')
  if (command.length > MAX_CHARS) return ask('ask:too-long')
  const blocked = loosely(command, lists, 0)
  if (blocked) return { verdict: 'block', rule: blocked }
  if (command.trim() === '') return ask('ask:empty')
  // Only plain printable ASCII, tabs and new lines: no look-alike letter, no invisible or right-to-left mark, no carriage return.
  if (/[^\t\n\x20-\x7e]/.test(command)) return ask('ask:unusual-character')
  const read = readStrict(command)
  if (!read.ok) return ask(read.code)
  const names: string[] = []
  for (const c of read.commands) {
    if (c.background) return ask('ask:background')
    for (const r of c.redirs) {
      const dup = /^\d*[<>]&$/.test(r.op) && /^(\d+|-)$/.test(r.target)
      const reads = /^\d*<$/.test(r.op)
      const toNothing = /^\d*(>|>>|&>|&>>)$/.test(r.op) && r.target === '/dev/null'
      if (!dup && !reads && !toNothing) return ask('ask:redirect')
    }
    const name = c.words[0]
    if (name.includes('/')) return ask('ask:path')
    if (NEVER_ALLOWED.includes(name)) return ask('ask:never-allowed')
    if (!lists.allow.includes(name) || !NAME.test(name)) return ask('ask:unlisted')
    if (ARG_CHECKS[name]?.(c.words.slice(1))) return ask('ask:args')
    if (!names.includes(name)) names.push(name)
  }
  return { verdict: 'allow', rule: `allow:${names.join(',')}` }
}
