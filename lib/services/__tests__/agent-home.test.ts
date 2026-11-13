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
