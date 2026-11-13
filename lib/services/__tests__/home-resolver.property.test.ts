// @vitest-environment node
/**
 * Property test for the id-to-home resolution (lib/services/home-resolver.ts).
 *
 * The resolver asks the disk, so the test gives it a disk: a small model
 * with directories, symlinks, mounts (a device per mount) and case folding
 * chosen per device. That makes every case reproducible on any machine,
 * including a home directory that is a mount point with a different case
 * rule than its parent, which no test could arrange on a real disk.
 *
 * Each run builds a random set of agent homes (names with hyphens,
 * underscores, dots, mixed case and a repeated `h_` prefix; plain
 * directories, symlinks to outside, symlinks to another home, symlinks into
 * another home), a random set of stored rows, and a list of spellings to
 * ask about. The properties:
 *
 *   P1  round trip. What a spelling resolves to has one id, and that id and
 *       that name resolve to the same home again.
 *   P2  one to one. No directory answers to two ids, and no id has two
 *       directories.
 *   P3  a row Swarm Map does not manage is sealed. No spelling at all gets a
 *       path that is, or is inside, or contains, the directory such a row's
 *       id spells.
 *   P4  the answer is the disk's. The directory a spelling resolves to is
 *       one the spelling really reaches on this disk, and it is never
 *       reported missing while it is there.
 *   P5  two names with no home yet are the same agent exactly when this
 *       disk would make them the same directory.
 *   P6  the answer does not depend on the order the disk lists entries in.
 *
 * The oracle for "the directory a spelling reaches" is written here from
 * the model, by trying every way to spell the separators and looking each
 * path up. It shares no code with the resolver.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { agentHomeIfManaged } from '../agent-home'
import { agentHomeEntry } from '../data-dir'
import { isAgentName, resolveAgentHome, type HomeIo } from '../home-resolver'
import { RETIRED_RUNTIMES, findUnmanagedRow } from '../runtime-adapter'

// ---- a model disk ---------------------------------------------------------

type Node =
  | { kind: 'dir'; dev: number; ino: number; children: Map<string, Node> }
  | { kind: 'link'; dev: number; ino: number; target: string }

class ModelDisk {
  private nextIno = 1
  readonly root: Node = { kind: 'dir', dev: 1, ino: this.nextIno++, children: new Map() }
  /** Does this device fold case? */
  readonly folds = new Map<number, boolean>([[1, false]])

  private child(dir: Node & { kind: 'dir' }, name: string): [string, Node] | null {
    const exact = dir.children.get(name)
    if (exact) return [name, exact]
    if (!this.folds.get(dir.dev)) return null
    for (const [n, node] of dir.children) if (n.toLowerCase() === name.toLowerCase()) return [n, node]
    return null
  }

  /** Walk a path. Returns the node and the path as the disk really spells it, symlinks resolved. */
  walk(p: string, depth = 0): { node: Node & { kind: 'dir' }; real: string } | null {
    if (depth > 8) return null
    let node: Node = this.root
    let real = ''
    for (const part of p.split('/').filter(Boolean)) {
      if (node.kind !== 'dir') return null
      const hit = this.child(node, part)
      if (!hit) return null
      const name = hit[0]
      let next = hit[1]
      real = `${real}/${name}`
      if (next.kind === 'link') {
        const followed = this.walk(next.target, depth + 1)
        if (!followed) return null
        next = followed.node
        real = followed.real
      }
      node = next
    }
    return node.kind === 'dir' ? { node, real: real || '/' } : null
  }

  /** Make a directory. `dev` given: the directory is a mount point for a new device. */
  mkdir(p: string, dev?: number): boolean {
    const parent = this.walk(path.posix.dirname(p))
    if (!parent || this.child(parent.node, path.posix.basename(p))) return false
    parent.node.children.set(path.posix.basename(p), {
      kind: 'dir',
      dev: dev ?? parent.node.dev,
      ino: this.nextIno++,
      children: new Map(),
    })
    return true
  }

  symlink(p: string, target: string): boolean {
    const parent = this.walk(path.posix.dirname(p))
    if (!parent || this.child(parent.node, path.posix.basename(p))) return false
    parent.node.children.set(path.posix.basename(p), { kind: 'link', dev: parent.node.dev, ino: this.nextIno++, target })
    return true
  }

  io(home: string): HomeIo {
    return {
      homedir: () => home,
      list: (dir) => [...(this.walk(dir)?.node.children.keys() ?? [])],
      stat: (p) => {
        const hit = this.walk(p)
        return hit ? { dev: hit.node.dev, ino: hit.node.ino, dir: true } : null
      },
      real: (p) => this.walk(p)?.real ?? null,
    }
  }
}

// ---- random cases ---------------------------------------------------------

/** A small seeded generator, so a failure names the seed that reproduces it. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    chance: (p: number) => next() < p,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  }
}

const HOME = '/home/u'
const RETIRED = Object.keys(RETIRED_RUNTIMES)[0]
// Few atoms on purpose: collisions between names are the interesting cases.
const ATOMS = ['a', 'b', 'A', 'x', 'h'] as const
const SEPS = ['-', '_', '.'] as const

function randomName(r: ReturnType<typeof prng>): string {
  let name: string = r.pick(ATOMS)
  for (let i = r.int(3); i > 0; i--) name += r.pick(SEPS) + r.pick(ATOMS)
  for (let i = r.int(3); i > 0; i--) name = 'h_' + name
  return r.chance(0.1) ? 'personal' : name
}

const swapCase = (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')

/** Ways a caller might write a name: the id, the name, other case, other separators, the prefix added or kept raw. */
function spellingsOf(name: string, r: ReturnType<typeof prng>): string[] {
  const id = 'h_' + name.replace(/-/g, '_')
  const out = [name, id, 'h_' + name, swapCase(name), 'h_' + swapCase(name).replace(/-/g, '_'), name.replace(/_/g, '-'), name.replace(/-/g, '_')]
  if (name.startsWith('h_')) out.push(name.slice(2))
  if (r.chance(0.5)) out.push(name.toUpperCase(), id.toLowerCase())
  return out
}

type Case = { disk: ModelDisk; io: HomeIo; rows: Array<{ id: string; runtime?: string }>; asks: string[]; note: string }

function makeCase(seed: number): Case {
  const r = prng(seed)
  const disk = new ModelDisk()
  disk.folds.set(1, r.chance(0.5))
  disk.mkdir('/home')
  disk.mkdir('/data')
  // Half the time the home directory is a mount, with its own case rule.
  const mounted = r.chance(0.5)
  if (mounted) disk.folds.set(2, r.chance(0.5))
  disk.mkdir(HOME, mounted ? 2 : undefined)
  // Something in the home that is not an agent home, as every real one has.
  disk.mkdir(`${HOME}/Documents`)

  const names: string[] = []
  for (let i = 2 + r.int(6); i > 0; i--) {
    const name = randomName(r)
    const entry = `${HOME}/${agentHomeEntry(name)}`
    const kind = r.int(10)
    let made: boolean
    if (kind < 6 || names.length === 0) made = disk.mkdir(entry)
    else if (kind < 8) {
      // A home kept elsewhere, reached by a symlink.
      const target = `/data/t${names.length}`
      made = disk.mkdir(target) && disk.symlink(entry, target)
    } else if (kind < 9) made = disk.symlink(entry, `${HOME}/${agentHomeEntry(r.pick(names))}`) // alias of another home
    else {
      // A symlink leading inside another home.
      const host = `${HOME}/${agentHomeEntry(r.pick(names))}`
      disk.mkdir(`${host}/sub`)
      made = disk.symlink(entry, `${host}/sub`)
    }
    if (made) names.push(name)
  }

  const asks = new Set<string>()
  for (const n of names) for (const s of spellingsOf(n, r)) asks.add(s)
  for (let i = 6; i > 0; i--) for (const s of spellingsOf(randomName(r), r)) asks.add(s)
  for (const junk of ['', '.', '..', 'a/b', '../a', 'h_', 'h_..', 'a b']) asks.add(junk)

  const rows: Case['rows'] = []
  const all = [...asks].filter((s) => isAgentName(s.replace(/^h_/, '')))
  for (let i = 1 + r.int(2); i > 0; i--) rows.push({ id: r.pick(all), runtime: RETIRED })
  for (let i = r.int(3); i > 0; i--) rows.push({ id: r.pick(all), ...(r.chance(0.5) ? { runtime: 'hermes' } : {}) })

  const note = `seed ${seed}: root ${disk.folds.get(1) ? 'folds' : 'keeps'} case, home ${mounted ? `is a mount that ${disk.folds.get(2) ? 'folds' : 'keeps'} case` : 'is not a mount'}; homes ${JSON.stringify(names)}; rows ${JSON.stringify(rows)}`
  return { disk, io: disk.io(HOME), rows, asks: [...asks], note }
}

// ---- the oracle -----------------------------------------------------------

/**
 * Every directory a spelling reaches on the model disk, by its real path.
 * Tries each way to write the separators and looks the path up.
 */
function reachedDirs(disk: ModelDisk, spelling: string): string[] | null {
  const raw = spelling.startsWith('h_') ? spelling.slice(2) : spelling
  if (!isAgentName(raw)) return null
  if (raw.replace(/-/g, '_') === 'personal') {
    const hit = disk.walk(`${HOME}/${agentHomeEntry('personal')}`)
    return hit ? [hit.real] : []
  }
  const at = [...raw].flatMap((c, i) => (c === '-' || c === '_' ? [i] : []))
  const dirs = new Set<string>()
  for (let mask = 0; mask < 1 << at.length; mask++) {
    const chars = [...raw]
    at.forEach((pos, bit) => (chars[pos] = mask & (1 << bit) ? '_' : '-'))
    const name = chars.join('')
    if (name === 'personal') continue // `.hermes-personal` is nobody's home
    const hit = disk.walk(`${HOME}/${agentHomeEntry(name)}`)
    if (hit) dirs.add(hit.real)
  }
  return [...dirs]
}

const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + '/')

/** Would this disk make the two names one directory? Asked by making one and looking for the other. */
function wouldBeOneDirectory(c: Case, a: string, b: string): boolean {
  const hy = (s: string) => (s.startsWith('h_') ? s.slice(2) : s).replace(/_/g, '-')
  const probe = `${HOME}/${agentHomeEntry(hy(a))}`
  if (!c.disk.mkdir(probe)) throw new Error('probe name was taken')
  const same = c.disk.walk(`${HOME}/${agentHomeEntry(hy(b))}`) !== null
  ;(c.disk.walk(HOME)!.node.children as Map<string, Node>).delete(agentHomeEntry(hy(a)))
  return same
}

// ---- the properties -------------------------------------------------------

const RUNS = 400

function check(seedBase: number, property: (c: Case) => void) {
  for (let i = 0; i < RUNS; i++) {
    const c = makeCase(seedBase + i)
    try {
      property(c)
    } catch (err) {
      throw new Error(`${(err as Error).message}\n  in ${c.note}`)
    }
  }
}

describe('the model disk behaves like a disk (a wrong model proves nothing)', () => {
  it('folds case per device, follows symlinks, and gives a mount its own device', () => {
    const disk = new ModelDisk()
    disk.mkdir('/keep')
    disk.folds.set(2, true)
    disk.mkdir('/keep/Fold', 2)
    disk.mkdir('/keep/Fold/Dir')
    disk.symlink('/keep/link', '/keep/Fold/Dir')
    expect(disk.walk('/KEEP')).toBeNull()
    expect(disk.walk('/keep/Fold/dir')?.real).toBe('/keep/Fold/Dir')
    expect(disk.walk('/keep/fold')).toBeNull() // the mount point's own name lives on the parent
    expect(disk.walk('/keep/link')?.real).toBe('/keep/Fold/Dir')
    expect(disk.walk('/keep/Fold')?.node.dev).toBe(2)
    expect(disk.mkdir('/keep/Fold/DIR')).toBe(false)
  })

  it('the generator really produces every kind of case', () => {
    const seen = { fold: 0, keep: 0, mountDiffers: 0, link: 0, alias: 0, prefixed: 0, resolved: 0, refused: 0, sealed: 0 }
    for (let i = 0; i < RUNS; i++) {
      const c = makeCase(9000 + i)
      const homeDev = c.disk.walk(HOME)!.node.dev
      if (c.disk.folds.get(homeDev)) seen.fold++
      else seen.keep++
      if (homeDev === 2 && c.disk.folds.get(1) !== c.disk.folds.get(2)) seen.mountDiffers++
      for (const [entry, node] of c.disk.walk(HOME)!.node.children) {
        if (node.kind !== 'link') continue
        if (node.target.startsWith('/data/')) seen.link++
        else seen.alias++
        if (entry.includes('h_')) seen.prefixed++
      }
      for (const s of c.asks) {
        if (resolveAgentHome(s, c.io)?.exists) seen.resolved++
        if (findUnmanagedRow(c.rows, s, c.io)) seen.sealed++
        if (resolveAgentHome(s, c.io) === null) seen.refused++
      }
    }
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(20)
  })
})

describe('id to home, on a model disk', () => {
  it('P1: what a spelling resolves to has one id, and resolves to itself again', () => {
    check(1000, (c) => {
      for (const s of c.asks) {
        const r = resolveAgentHome(s, c.io)
        if (!r) continue
        expect(r.id, `id of ${s}`).toBe('h_' + r.name.replace(/-/g, '_'))
        for (const again of [r.id, r.name.startsWith('h_') ? r.id : r.name]) {
          expect(resolveAgentHome(again, c.io), `${s} -> ${again}`).toEqual(r)
        }
      }
    })
  })

  it('P2: no directory answers to two ids, and no id has two directories', () => {
    check(2000, (c) => {
      const idsOfDir = new Map<string, Set<string>>()
      const dirsOfId = new Map<string, Set<string>>()
      for (const s of c.asks) {
        const r = resolveAgentHome(s, c.io)
        if (!r?.exists) continue
        const dir = c.disk.walk(r.home)!.real
        idsOfDir.set(dir, (idsOfDir.get(dir) ?? new Set()).add(r.id))
        dirsOfId.set(r.id, (dirsOfId.get(r.id) ?? new Set()).add(dir))
      }
      for (const [dir, ids] of idsOfDir) expect([...ids], `ids of ${dir}`).toHaveLength(1)
      for (const [id, dirs] of dirsOfId) expect([...dirs], `directories of ${id}`).toHaveLength(1)
      // And no resolved home lies inside another resolved home.
      const dirs = [...idsOfDir.keys()]
      for (const a of dirs) for (const b of dirs) if (a !== b) expect(within(a, b), `${a} inside ${b}`).toBe(false)
    })
  })

  it('P3: the directory of a row Swarm Map does not manage is reachable through no spelling', () => {
    check(3000, (c) => {
      const sealed = c.rows.filter((row) => row.runtime === RETIRED).flatMap((row) => reachedDirs(c.disk, row.id) ?? [])
      for (const s of c.asks) {
        const home = agentHomeIfManaged(s, c.rows, c.io)
        if (home === null) continue
        const dir = c.disk.walk(home)?.real
        if (!dir) continue
        for (const d of sealed) {
          expect(within(dir, d) || within(d, dir), `${s} was given ${home}, which touches the unmanaged ${d}`).toBe(false)
        }
      }
    })
  })

  it('P4: the directory a spelling resolves to is one it really reaches, and is never called missing', () => {
    check(4000, (c) => {
      for (const s of c.asks) {
        const reached = reachedDirs(c.disk, s)
        const r = resolveAgentHome(s, c.io)
        if (reached === null) {
          expect(r, `${JSON.stringify(s)} is no agent name`).toBeNull()
          continue
        }
        if (!r) continue // rules 4 and 5: several candidates, or an alias
        if (reached.length === 0) expect(r.exists, `${s} reaches nothing`).toBe(false)
        else {
          expect(r.exists, `${s} reaches ${reached}`).toBe(true)
          expect(reached, `${s} resolved to ${r.home}`).toContain(c.disk.walk(r.home)!.real)
        }
      }
    })
  })

  it('P6: the answer does not depend on the order the disk lists the home directory in', () => {
    check(6000, (c) => {
      const reversed: HomeIo = { ...c.io, list: (dir) => c.io.list(dir).reverse() }
      for (const s of c.asks) {
        expect(resolveAgentHome(s, reversed), s).toEqual(resolveAgentHome(s, c.io))
        expect(agentHomeIfManaged(s, c.rows, reversed), s).toBe(agentHomeIfManaged(s, c.rows, c.io))
      }
    })
  })

  it('P5: two names with no home are one agent exactly when the disk would make them one directory', () => {
    check(5000, (c) => {
      const free = c.asks.filter((s) => reachedDirs(c.disk, s)?.length === 0 && !/personal/i.test(s))
      for (let i = 0; i + 1 < free.length; i += 2) {
        const [a, b] = [free[i], free[i + 1]]
        const refused = findUnmanagedRow([{ id: a, runtime: RETIRED }], b, c.io) !== null
        expect(refused, `row ${a}, asked ${b}`).toBe(wouldBeOneDirectory(c, a, b))
      }
    })
  })
})
