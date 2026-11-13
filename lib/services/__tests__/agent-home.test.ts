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
import { agentHome, agentHomeIfManaged, agentHomeForSelfRead } from '../agent-home'
import { agentHomeForName } from '../data-dir'
import { RETIRED_RUNTIMES, UnsupportedRuntimeError } from '../runtime-adapter'

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

  // The row is matched on what the id MEANS, not on how it is spelled. Every
  // spelling below builds the same directory as `h_seraph_doer` (the last
  // two on a case-insensitive disk), so every one must hit the same row.
  it.each(['h_seraph_doer', 'seraph-doer', 'seraph_doer', 'h_seraph-doer', 'SERAPH-DOER', 'h_SERAPH_DOER', 'Seraph_Doer'])(
    'an unmanaged row is found under the spelling %s',
    (spelling) => {
      const rows = [{ id: 'h_seraph_doer', name: 'seraph-doer', runtime: RETIRED_TAG }]
      expect(() => agentHome(spelling, rows)).toThrow(UnsupportedRuntimeError)
      expect(agentHomeIfManaged(spelling, rows)).toBeNull()
    },
  )

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
  it('agentHomeIfManaged keeps a bare name verbatim and converts only an id', () => {
    expect(agentHomeIfManaged('foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo_bar'))
    expect(agentHomeIfManaged('h_foo_bar', ROWS)).toBe(path.join(home, '.hermes-foo-bar'))
    expect(agentHomeIfManaged('personal', ROWS)).toBe(path.join(home, '.hermes'))
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
