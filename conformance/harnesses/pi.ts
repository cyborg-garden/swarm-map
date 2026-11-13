// Pi, as the shared suite sees it. Everything Pi-specific about the lab is
// here: how its shim starts, what its config file looks like, which native
// tool is a shell, which ways of breaking it the suite must catch, and which
// spec checks do not apply.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENAI_CHAT } from '../../lib/door/model-shapes.ts'
import { PI_CAPS } from '../../lib/runtimes/pi/caps.ts'
import { piEnv, startPiShim, type PiShimOptions } from '../../lib/runtimes/pi/shim.ts'
import { childTripwireEnv, readChildTripwire } from '../guards/child-tripwire.ts'
import { assertNoCredentials } from '../guards/preflight.ts'
import type { Cell, HarnessUnderTest } from '../suites/harness.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GATE = path.resolve(HERE, '..', '..', 'lib', 'runtimes', 'pi', 'cell', 'gate.ts')
const BROKEN = path.resolve(HERE, '..', 'broken')

export function fakePiCommand(): string[] {
  return [process.execPath, path.resolve(HERE, '..', 'rig', 'fake-pi.ts')]
}

const OTHERS = ['C1', 'C2', 'C3', 'C4', 'C4a', 'C4p', 'C4+', 'C5', 'C5v', 'C8p', 'C9p', 'C12', 'C15', 'C15t']
const allBut = (...red: string[]): string[] => OTHERS.filter((id) => !red.includes(id))

/** The shim's own env, minus anything credential-shaped and anything Pi's env already sets. */
function hostEnvSafeToHandOver(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name in base || name.startsWith('PI_')) continue
    try { assertNoCredentials({ [name]: value }) } catch { continue }
    out[name] = value
  }
  return out
}

export function piHarness(piCommand: string[], build: 'real' | 'fake'): HarnessUnderTest {
  const dirs = (cell: Cell) => ({
    agent: path.join(cell.dir, 'agent'), sessions: path.join(cell.dir, 'sessions'),
    work: path.join(cell.dir, 'work'), home: path.join(cell.dir, 'home'),
  })
  const tripwireLog = (cell: Cell): string => path.join(cell.dir, 'tripwire.log')
  const options = (cell: Cell, variant: string): PiShimOptions => {
    const d = dirs(cell)
    // Pi runs on Node, so Node is told to load the tripwire first in every Pi this lab starts.
    const watched = childTripwireEnv(tripwireLog(cell))
    const base: PiShimOptions = {
      ...cell.link, piCommand, agentDir: d.agent, sessionsDir: d.sessions, workDir: d.work, homeDir: d.home,
      gate: { path: GATE }, verdictTimeoutMs: cell.verdictTimeoutMs, gateTimeoutMs: cell.vetoTimeoutMs, gateReadyMs: 10_000,
      rigEnv: watched,
    }
    switch (variant) {
      case 'good': return base
      case 'ignores-verdicts': return { ...base, gate: { path: path.join(BROKEN, 'gate-allows-all.ts') } }
      case 'gate-missing': return { ...base, gate: { path: path.join(cell.dir, 'no-such-gate.ts') } }
      // Short wait: every turn in this variant is refused only once the wait runs out.
      case 'gate-silent': return { ...base, gate: { path: path.join(BROKEN, 'gate-silent.ts') }, gateReadyMs: 700 }
      case 'leaks-env': return { ...base, rigEnv: { ...watched, SWARMLAB_LEAK: cell.upstreamKey } }
      case 'inherits-env': return { ...base, rigEnv: { ...hostEnvSafeToHandOver(piEnv(base)), ...watched } }
      case 'dials-out': return { ...base, gate: { path: path.join(BROKEN, 'gate-dials-out.ts') } }
      case 'unwatched': return { ...base, rigEnv: {} }
      default: throw new Error(`the Pi harness has no shim variant '${variant}'`)
    }
  }

  return {
    caps: PI_CAPS,
    build,
    modelShape: OPENAI_CHAT,
    shell: {
      touch: (file) => ({ name: 'bash', args: { command: `touch ${file}` } }),
      dumpEnv: (file) => ({ name: 'bash', args: { command: `env > ${file}` } }),
    },
    workFile: (cell, name) => path.join(dirs(cell).work, name),
    cellEnv: (cell, variant) => piEnv(options(cell, variant)),
    tripwire: (cell) => readChildTripwire(tripwireLog(cell)),
    async start(cell, variant) {
      const d = dirs(cell)
      for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true })
      // Pi is pointed at the sidecar's model route and given a placeholder, never a key.
      writeFileSync(path.join(d.agent, 'models.json'), JSON.stringify({
        providers: { swarm: { baseUrl: cell.modelBaseUrl, api: 'openai-completions', apiKey: cell.placeholder, models: [{ id: 'scripted' }] } },
      }))
      return startPiShim(options(cell, variant))
    },
    broken: {
      'ignores-verdicts': {
        what: 'A gate that announces itself, then lets every tool run without asking',
        // C15t is red too: the added tool runs, but nobody was asked, so there is no receipt for it.
        red: ['C4', 'C4p', 'C5', 'C5v', 'C15t'], green: allBut('C4', 'C4p', 'C5', 'C5v', 'C15t'),
      },
      'leaks-env': {
        what: 'The real model key planted in Pi\'s environment',
        red: ['C8p'], green: allBut('C8p'),
      },
      'inherits-env': {
        what: 'Pi started with the shim\'s own environment passed down',
        red: ['C8p'], green: allBut('C8p'),
      },
      // With no gate, the right outcome is that nothing runs at all: no turn
      // reaches the model (C1) and the allowed tool does not run (C4+). A
      // dropped message is still dropped (C3).
      'gate-missing': {
        what: 'The gate file is not there, so Pi cannot load it',
        red: ['C1', 'C4+'], green: ['C3'],
      },
      'gate-silent': {
        what: 'Pi loads a gate that never announces itself and blocks nothing',
        red: ['C1', 'C4+'], green: ['C3'],
      },
      // Every check that starts Pi goes red, not only C9p: an attempt to leave the
      // machine fails whichever check it happened in. C3 starts no Pi, so it stays green.
      'dials-out': {
        what: 'A working gate that also tries to connect to an address outside this machine when Pi starts',
        red: allBut('C3'), green: ['C3'],
      },
      // Everything works, but nothing was watching. No evidence is not a pass: C9p must say so.
      'unwatched': {
        what: 'Pi started without the tripwire loaded inside it',
        red: ['C9p'], green: allBut('C9p'),
      },
    },
    rows: [
      { id: 'C7', title: 'an unmapped tool is denied on a public agent', status: 'not-run',
        reason: 'needs a second tool surface (MCP), which this shim starts Pi without' },
    ],
  }
}
