// @vitest-environment node
/**
 * agentHome() is the one place an id or agent name becomes a Hermes home
 * (`~/.hermes-<name>`). It refuses an id whose stored row Swarm Map does not
 * manage: such a row is not a Hermes agent, and the directory its id maps to
 * may belong to a real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { agentHome, agentHomeIfManaged, agentHomeForSelfRead, storedHarnessRows } from '../agent-home'
import { DATA_DIR, agentHomeForName } from '../data-dir'
import { RETIRED_RUNTIMES, UnsupportedRuntimeError, findUnmanagedRow } from '../runtime-adapter'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agent-home-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

// A tag from the retired table. Rows retired by their id alone are covered
// in retired-runtime.test.ts, next to the rule that recognises them.
const RETIRED_TAG = Object.keys(RETIRED_RUNTIMES)[0]
const ROWS = [
  { id: 'h_iris', name: 'iris', runtime: 'hermes' },
  { id: 'h_seraph_doer', name: 'seraph-doer' }, // older than the runtime field
  { id: 'h_old', name: 'old', runtime: RETIRED_TAG },
  { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future' },
]

describe('where tests keep Swarm Map state', () => {
  it('DATA_DIR is a scratch directory, never this machine\'s real ~/.hermes-swarm-map', () => {
    // vitest.setup.ts sets it. Without that, every test that reaches
    // harnesses.json through DATA_DIR reads the live fleet's file.
    expect(DATA_DIR.startsWith(fs.realpathSync(os.tmpdir())) || DATA_DIR.startsWith(os.tmpdir())).toBe(true)
    expect(DATA_DIR).not.toContain('.hermes-swarm-map')
    expect(storedHarnessRows()).toEqual([])
  })
})

describe('agentHome', () => {
  it('maps a managed id, its bare slug, and an id with no stored row', () => {
    expect(agentHome('h_iris', ROWS)).toBe(path.join(home, '.hermes-iris'))
    expect(agentHome('h_seraph_doer', ROWS)).toBe(path.join(home, '.hermes-seraph-doer'))
    expect(agentHome('seraph-doer', ROWS)).toBe(path.join(home, '.hermes-seraph-doer'))
    expect(agentHome('h_discovered_only', ROWS)).toBe(path.join(home, '.hermes-discovered-only'))
  })

  it('maps personal to ~/.hermes', () => {
    expect(agentHome('h_personal', ROWS)).toBe(path.join(home, '.hermes'))
    expect(agentHome('personal', ROWS)).toBe(path.join(home, '.hermes'))
  })

  it.each([
    ['a retired tag', 'h_old', 'retired'],
    ['a retired tag, asked by bare slug', 'old', 'retired'],
    ['an unknown tag', 'h_odd', 'unknown'],
    ['an unknown tag, asked by bare slug', 'odd', 'unknown'],
  ])('throws for %s', (_label, id, reason) => {
    let thrown: unknown
    try {
      agentHome(id, ROWS)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(UnsupportedRuntimeError)
    expect((thrown as UnsupportedRuntimeError).reason).toBe(reason)
    expect(agentHomeIfManaged(id, ROWS)).toBeNull()
  })

  // The row is matched on what the id MEANS, not on how it is spelled:
  // two spellings are the same agent when they build the same directory.
  it.each(['h_seraph_doer', 'seraph-doer', 'seraph_doer', 'h_seraph-doer'])(
    'an unmanaged row is found under the spelling %s',
    (spelling) => {
      const rows = [{ id: 'h_seraph_doer', name: 'seraph-doer', runtime: RETIRED_TAG }]
      expect(() => agentHome(spelling, rows)).toThrow(UnsupportedRuntimeError)
      expect(agentHomeIfManaged(spelling, rows)).toBeNull()
    },
  )

  // Case is the disk's call. Where the home directory folds case (macOS by
  // default), ~/.hermes-Old IS ~/.hermes-old, so an agent "Old" beside a
  // retired `h_old` shares its directory and is refused with it. Where it
  // does not (Linux), they are two agents and "Old" must be left alone.
  describe('names that differ only by case', () => {
    const rows = [{ id: 'h_old', name: 'old', runtime: RETIRED_TAG }]
    const CASED = ['h_Old', 'Old', 'OLD', 'h_OLD']

    // Both kinds of disk, and a home that is a mount with its own rule, are
    // exercised on every machine by home-resolver.property.test.ts against
    // a model disk. This case checks the real disk the suite is running on.
    it('agentHome follows the disk: refused exactly when the two names are one directory', () => {
      fs.mkdirSync(path.join(home, '.hermes-old'))
      const sameDirectory = fs.existsSync(path.join(home, '.hermes-Old'))
      for (const spelling of CASED) {
        if (sameDirectory) {
          expect(() => agentHome(spelling, rows), spelling).toThrow(UnsupportedRuntimeError)
          expect(agentHomeIfManaged(spelling, rows), spelling).toBeNull()
        } else {
          expect(agentHome(spelling, rows), spelling).toBe(path.join(home, '.hermes-' + spelling.replace(/^h_/, '')))
          expect(agentHomeIfManaged(spelling, rows), spelling).not.toBeNull()
          expect(findUnmanagedRow(rows, spelling), spelling).toBeNull()
        }
      }
    })
  })

  // An id is made from a name by turning '-' into '_', which cannot be undone
  // when the name had a '_' of its own: `hermes-_x` and `hermes--x` both get
  // `h__x`. The home that exists on disk says which name the id came from.
  describe('an id whose name held an underscore', () => {
    it('maps to the home that exists', () => {
      fs.mkdirSync(path.join(home, '.hermes-_x'))
      fs.mkdirSync(path.join(home, '.hermes-foo_bar'))
      expect(agentHome('h__x', [])).toBe(path.join(home, '.hermes-_x'))
      expect(agentHomeForSelfRead('h__x')).toBe(path.join(home, '.hermes-_x'))
      expect(agentHomeIfManaged('h__x', [])).toBe(path.join(home, '.hermes-_x'))
      expect(agentHome('h_foo_bar', [])).toBe(path.join(home, '.hermes-foo_bar'))
    })

    it('prefers the hyphen form when that home exists, and when nothing exists', () => {
      expect(agentHome('h_foo_bar', [])).toBe(path.join(home, '.hermes-foo-bar'))
      fs.mkdirSync(path.join(home, '.hermes-foo_bar'))
      fs.mkdirSync(path.join(home, '.hermes-foo-bar'))
      expect(agentHome('h_foo_bar', [])).toBe(path.join(home, '.hermes-foo-bar'))
    })

    it('does not guess between two candidates: the id means neither', () => {
      fs.mkdirSync(path.join(home, '.hermes-a_b_c'))
      fs.mkdirSync(path.join(home, '.hermes-a-b_c'))
      expect(() => agentHome('h_a_b_c', [])).toThrow(/invalid harness id/i)
      expect(agentHomeIfManaged('h_a_b_c', [])).toBeNull()
      // Still sealed if either is an unmanaged row's.
      expect(findUnmanagedRow([{ id: 'h_a_b_c', runtime: RETIRED_TAG }], 'a-b_c')).not.toBeNull()
    })

    it('a home whose name starts with h_ answers only to its own id', () => {
      // `.hermes-h_foo_bar` is the agent "h_foo_bar", id `h_h_foo_bar`. The
      // id `h_foo_bar` belongs to "foo-bar" and must not land here.
      fs.mkdirSync(path.join(home, '.hermes-h_foo_bar'))
      expect(agentHome('h_h_foo_bar', [])).toBe(path.join(home, '.hermes-h_foo_bar'))
      expect(agentHome('h_foo_bar', [])).toBe(path.join(home, '.hermes-foo-bar'))
      const rows = [{ id: 'h_h_foo_bar', runtime: RETIRED_TAG }]
      expect(() => agentHome('h_h_foo_bar', rows)).toThrow(UnsupportedRuntimeError)
      expect(agentHomeIfManaged('h_foo_bar', rows)).toBe(path.join(home, '.hermes-foo-bar'))
    })

    it('a symlinked home is a home, and an alias beside its target is not a second one', () => {
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agent-elsewhere-'))
      try {
        fs.symlinkSync(elsewhere, path.join(home, '.hermes-far'))
        expect(agentHome('h_far', [])).toBe(path.join(home, '.hermes-far'))
        expect(() => agentHome('h_far', [{ id: 'h_far', runtime: RETIRED_TAG }])).toThrow(UnsupportedRuntimeError)

        fs.mkdirSync(path.join(home, '.hermes-real'))
        fs.symlinkSync(path.join(home, '.hermes-real'), path.join(home, '.hermes-alias'))
        expect(agentHome('h_real', [])).toBe(path.join(home, '.hermes-real'))
        expect(() => agentHome('h_alias', [])).toThrow(/invalid harness id/i)
        // And the alias never leads into an unmanaged row's home.
        expect(findUnmanagedRow([{ id: 'h_real', runtime: RETIRED_TAG }], 'h_alias')).not.toBeNull()
      } finally {
        fs.rmSync(elsewhere, { recursive: true, force: true })
      }
    })

    it('still refuses when the row for that id is unmanaged', () => {
      fs.mkdirSync(path.join(home, '.hermes-_x'))
      expect(() => agentHome('h__x', [{ id: 'h__x', runtime: RETIRED_TAG }])).toThrow(UnsupportedRuntimeError)
    })
  })

  it('one unmanaged row is enough when two rows share an id, whatever their order', () => {
    const hermes = { id: 'h_twin', name: 'twin', runtime: 'hermes' }
    const retired = { id: 'h_twin', name: 'twin', runtime: RETIRED_TAG }
    expect(agentHomeIfManaged('h_twin', [hermes, retired])).toBeNull()
    expect(agentHomeIfManaged('h_twin', [retired, hermes])).toBeNull()
  })

  it('a harnesses.json that is not a list is read as no rows, not a crash', () => {
    const notAList = { oops: true } as unknown as []
    expect(agentHomeIfManaged('h_iris', notAList)).toBe(path.join(home, '.hermes-iris'))
    expect(agentHome('h_iris', notAList)).toBe(path.join(home, '.hermes-iris'))
  })

  it('a row whose runtime is null (a hand edit) is Hermes, as a missing tag is', () => {
    const rows = [{ id: 'h_nul', name: 'nul', runtime: null as unknown as undefined }]
    expect(agentHome('h_nul', rows)).toBe(path.join(home, '.hermes-nul'))
  })

  // A bare NAME is used as it stands: an agent discovered from a hand-made
  // container can carry an underscore, and its home is ~/.hermes-<that name>.
  // Only the `h_` id form turns underscores back into hyphens.
  it('a bare name reaches the home that exists under it; with none, the hyphen form is meant', () => {
    expect(agentHomeIfManaged('foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo-bar'))
    expect(agentHomeIfManaged('h_foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo-bar'))
    expect(agentHomeIfManaged('personal', ROWS)).toBe(path.join(home, '.hermes'))
    fs.mkdirSync(path.join(home, '.hermes-foo_bar'))
    expect(agentHomeIfManaged('foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo_bar'))
    expect(agentHomeIfManaged('h_foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo_bar'))
  })

  it.each(['h_../../etc', '../x', 'a/b', 'h_a b', ''])('refuses the id %j: it is not an agent id at all', (bad) => {
    expect(() => agentHome(bad, [])).toThrow(/invalid harness id/i)
    expect(() => agentHomeForSelfRead(bad)).toThrow(/invalid harness id/i)
  })

  // The name lane takes names of discovered containers, which may hold a dot
  // or an underscore, so it is looser. It still never leaves the home dir.
  it.each(['h_../../etc', '../x', 'a/b', '..', 'a\\b', ''])('agentHomeIfManaged gives no path for %j', (bad) => {
    expect(agentHomeIfManaged(bad, [])).toBeNull()
  })

  it('agentHomeIfManaged still maps a discovered name with a dot', () => {
    expect(agentHomeIfManaged('foo.bar', [])).toBe(path.join(home, '.hermes-foo.bar'))
  })

  // Discovery mints `h_foo.bar` for a hand-made container `hermes-foo.bar`,
  // and the integrity scan and usage readers are then called with that id.
  it('agentHome maps the id discovery mints for a container name with a dot', () => {
    expect(agentHome('h_foo.bar', [])).toBe(path.join(home, '.hermes-foo.bar'))
    expect(agentHomeForSelfRead('h_foo.bar')).toBe(path.join(home, '.hermes-foo.bar'))
  })

  // Docker also allows `hermes--x` and `hermes-_x`. Discovery gives both the
  // id `h__x`; the readers called with it must get a path, not a throw.
  it('maps a name that starts with a hyphen, and caps the length', () => {
    expect(agentHome('h__x', [])).toBe(path.join(home, '.hermes--x'))
    expect(agentHomeIfManaged('_x', [])).toBe(path.join(home, '.hermes--x'))
    expect(agentHome('a'.repeat(128), [])).toBe(path.join(home, '.hermes-' + 'a'.repeat(128)))
    expect(() => agentHome('a'.repeat(129), [])).toThrow(/invalid harness id/i)
    expect(agentHomeIfManaged('a'.repeat(129), [])).toBeNull()
  })

  // A case-insensitive disk folds more than ASCII case: "ſeraph-doer" (long
  // s) and "ﬁsh" (fi ligature) open the directories of seraph-doer and fish.
  // No agent name holds such a character, so neither lane accepts one.
  it.each(['\u017feraph-doer', 'h_\u017feraph_doer', '\ufb01sh', 'caf\u00e9', 'a b', 'a\tb'])(
    'no lane maps the name %j',
    (odd) => {
      const rows = [{ id: 'h_seraph_doer', runtime: RETIRED_TAG }, { id: 'h_fish', runtime: RETIRED_TAG }]
      expect(agentHomeIfManaged(odd, rows)).toBeNull()
      expect(() => agentHome(odd, rows)).toThrow(/invalid harness id/i)
      expect(() => agentHomeForSelfRead(odd)).toThrow(/invalid harness id/i)
    },
  )

  it('a stored row with no usable id is passed over, not crashed on', () => {
    const rows = [{ id: 7 as unknown as string, runtime: RETIRED_TAG }, { runtime: RETIRED_TAG }, null as unknown as { id?: string }]
    expect(agentHome('h_iris', rows)).toBe(path.join(home, '.hermes-iris'))
  })

  it('agentHomeIfManaged returns the path for a managed id', () => {
    expect(agentHomeIfManaged('h_iris', ROWS)).toBe(path.join(home, '.hermes-iris'))
  })

  it('agentHomeForSelfRead never refuses: an agent asking about itself reads its own home', () => {
    expect(agentHomeForSelfRead('old')).toBe(path.join(home, '.hermes-old'))
    expect(agentHomeForSelfRead('h_old')).toBe(path.join(home, '.hermes-old'))
    expect(agentHomeForSelfRead('personal')).toBe(path.join(home, '.hermes'))
  })

  it('agentHomeForName is path arithmetic only', () => {
    expect(agentHomeForName('old')).toBe(path.join(home, '.hermes-old'))
    expect(agentHomeForName('personal')).toBe(path.join(home, '.hermes'))
  })
})
