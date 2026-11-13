import fs from 'fs'
import os from 'os'
import path from 'path'
import { agentHomeEntry, agentNameOfHomeEntry } from './data-dir'

/**
 * From what a caller wrote (an id, a slug, a name) to the one directory it
 * means. The answer comes from the disk, never from comparing strings.
 *
 * THE RULE
 *
 *  1. An agent home is an entry of the home directory, `.hermes-<name>`
 *     (or `.hermes` for "personal"), that is a directory once symlinks are
 *     followed. Its identity is the directory it really is: device + inode.
 *  2. A home has exactly one id: `h_` + its name with every '-' turned into
 *     '_'. Nothing else is an id for it. A name that itself starts with
 *     `h_` gets `h_h_...`; the prefix is always added, never recognised.
 *  3. A spelling reaches a home when the path it spells, with that home's
 *     own separators, is that same directory on this disk. So case is
 *     decided by the disk (a folding disk makes `OLD` reach `.hermes-old`,
 *     a case-keeping one does not), and so is everything else.
 *  4. When several homes share an id (`.hermes-a-b` and `.hermes-a_b`), the
 *     one written with hyphens only answers to it, since that is the form
 *     Swarm Map makes. If none is, a single candidate answers; several do
 *     not, and the id resolves to nothing.
 *  5. When several entries are one directory (a symlink beside its target),
 *     the entry that is the directory itself owns it; among symlinks only,
 *     the first by name. The other entries resolve to nothing. An entry
 *     that leads INSIDE another home resolves to nothing either.
 *  6. With no home on disk, the spelling means the home that would be made:
 *     the hyphen form of the name. Two such names are the same when the
 *     disk would make them the same directory.
 *
 * From 2, 4 and 5: one id never has two homes and one directory never has
 * two ids. `reach()` is wider on purpose: it lists every directory a
 * spelling touches, owner or not, and is what the "is this a row Swarm Map
 * does not manage" check compares, so no alias leads into such a row's home.
 *
 * lib/services/__tests__/home-resolver.property.test.ts generates names,
 * symlinks and mounts against a model disk and holds these to it.
 */

/** The few things asked of the disk. Injected so a model disk can stand in. */
export type HomeIo = {
  homedir(): string
  /** Entry names of a directory; empty when it cannot be read. */
  list(dir: string): string[]
  /** What the path is once symlinks are followed, or null when nothing is there. */
  stat(p: string): { dev: number; ino: number; dir: boolean } | null
  /** The path with every symlink resolved, or null. */
  real(p: string): string | null
}

export const diskIo: HomeIo = {
  homedir: () => os.homedir(),
  list: (dir) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  },
  stat: (p) => {
    try {
      const s = fs.statSync(p)
      return { dev: s.dev, ino: s.ino, dir: s.isDirectory() }
    } catch {
      return null
    }
  },
  real: (p) => {
    try {
      return fs.realpathSync(p)
    } catch {
      return null
    }
  },
}

/**
 * Is this a name an agent can have? The alphabet is the one Docker allows
 * in a container name: ASCII letters and digits, '_', '.' and '-', up to
 * 128 of them, and not dots alone. ASCII only, on purpose: a folding disk
 * folds more than A-Z, and no agent name needs more.
 */
export function isAgentName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name) && !/^\.+$/.test(name)
}

/** The one id of the home named `name` (rule 2). */
export function idOfAgentName(name: string): string {
  return 'h_' + name.replace(/-/g, '_')
}

type Home = { name: string; path: string; dev: number; ino: number; real: string; norm: string }

/** Every agent home on disk (rule 1). */
function homesOnDisk(io: HomeIo): Home[] {
  const base = io.homedir()
  const homes: Home[] = []
  for (const entry of io.list(base)) {
    const name = agentNameOfHomeEntry(entry)
    if (name === null || !isAgentName(name)) continue
    const p = path.join(base, entry)
    const st = io.stat(p)
    if (!st || !st.dir) continue
    homes.push({ name, path: p, dev: st.dev, ino: st.ino, real: io.real(p) ?? p, norm: name.replace(/-/g, '_') })
  }
  return homes
}

const sameDir = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino
const inside = (inner: string, outer: string) => inner.length > outer.length && inner.startsWith(outer + path.sep)

/** The body of a spelling: the name with separators made uniform, or null when it is no agent name. */
function bodyOf(spelling: string): string | null {
  const raw = spelling.startsWith('h_') ? spelling.slice(2) : spelling
  return isAgentName(raw) ? raw.replace(/-/g, '_') : null
}

/** The homes a spelling reaches (rule 3). */
function reached(body: string, homes: Home[], io: HomeIo): Home[] {
  if (body === 'personal') return homes.filter((h) => h.name === 'personal')
  const base = io.homedir()
  return homes.filter((h) => {
    if (h.name === 'personal' || h.norm.length !== body.length) return false
    // A cheap first cut only. Whether the two really are one is asked of the disk below.
    if (h.norm.toLowerCase() !== body.toLowerCase()) return false
    // The caller's letters, this home's separators: is that path this home?
    let spelled = ''
    for (let i = 0; i < body.length; i++) spelled += h.name[i] === '-' || h.name[i] === '_' ? h.name[i] : body[i]
    const st = io.stat(path.join(base, agentHomeEntry(spelled)))
    return st !== null && sameDir(st, h)
  })
}

/** Does the entry own the directory it is (rule 5)? */
function owns(h: Home, homes: Home[], io: HomeIo): boolean {
  const realBase = io.real(io.homedir()) ?? io.homedir()
  const isItself = (x: Home) => x.real === path.join(realBase, agentHomeEntry(x.name))
  for (const other of homes) {
    if (other === h) continue
    if (inside(h.real, other.real)) return false
    if (!sameDir(other, h)) continue
    if (isItself(other) && !isItself(h)) return false
    if (isItself(other) === isItself(h) && other.name < h.name) return false
  }
  return true
}

/**
 * Would this disk make two names that differ only by case the same
 * directory? Asked inside the home directory itself, of an entry that is
 * there: spelled in the other case, it is either the same thing or absent.
 * With nothing to ask, the answer is yes, the careful one: it only ever
 * makes two names count as one.
 */
function foldsCase(io: HomeIo): boolean {
  const base = io.homedir()
  for (const entry of io.list(base)) {
    const other = entry === entry.toUpperCase() ? entry.toLowerCase() : entry.toUpperCase()
    if (other === entry) continue
    const st = io.stat(path.join(base, entry))
    if (!st) continue
    const alt = io.stat(path.join(base, other))
    return alt !== null && sameDir(alt, st)
  }
  return true
}

export type AgentRef = {
  /** The home's one id. */
  id: string
  /** The agent name, as the home's entry spells it. */
  name: string
  /** `~/.hermes-<name>`, by that same spelling. */
  home: string
  /** Is the home on disk? */
  exists: boolean
}

/** The one home a spelling means, or null when it means none (rules 3 to 6). */
export function resolveAgentHome(spelling: string, io: HomeIo = diskIo): AgentRef | null {
  const body = bodyOf(spelling)
  if (body === null) return null
  const homes = homesOnDisk(io)
  const found = reached(body, homes, io)
  if (found.length === 0) {
    const name = body === 'personal' ? 'personal' : body.replace(/_/g, '-')
    return { id: idOfAgentName(name), name, home: path.join(io.homedir(), agentHomeEntry(name)), exists: false }
  }
  // Rule 4. The caller's exact case first, then hyphens only, then a lone candidate.
  const exact = found.filter((h) => h.norm === body)
  const pool = exact.length ? exact : found
  const hyphened = pool.filter((h) => !h.name.includes('_'))
  const pick = hyphened.length === 1 ? hyphened[0] : pool.length === 1 ? pool[0] : null
  if (!pick || !owns(pick, homes, io)) return null
  return { id: idOfAgentName(pick.name), name: pick.name, home: pick.path, exists: true }
}

/**
 * Every directory a spelling touches, as comparable keys, or null when it is
 * no agent name. Wider than resolveAgentHome: it includes homes the spelling
 * reaches without owning.
 */
export function reach(spelling: string, io: HomeIo = diskIo): Array<{ key: string; real?: string }> | null {
  const body = bodyOf(spelling)
  if (body === null) return null
  const found = reached(body, homesOnDisk(io), io)
  if (found.length) return found.map((h) => ({ key: `dir:${h.dev}:${h.ino}`, real: h.real }))
  const name = body === 'personal' ? 'personal' : body.replace(/_/g, '-')
  return [{ key: `new:${foldsCase(io) ? name.toLowerCase() : name}` }]
}

/** Do two spellings touch the same directory, or one inside the other? */
export function reachesSame(
  a: Array<{ key: string; real?: string }>,
  b: Array<{ key: string; real?: string }>,
): boolean {
  return a.some((x) =>
    b.some((y) => x.key === y.key || (x.real !== undefined && y.real !== undefined && (inside(x.real, y.real) || inside(y.real, x.real)))),
  )
}
