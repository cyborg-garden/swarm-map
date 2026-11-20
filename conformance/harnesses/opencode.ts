// OpenCode, as the shared suite sees it, through the ACP shim. Everything
// OpenCode-specific about the lab is here: how its shim starts, which native
// tool is a shell, which ways of breaking it the suite must catch, which of
// the tool checks it runs, and which spec checks do not apply.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENAI_CHAT } from '../../lib/door/model-shapes.ts'
import { OPENCODE_CAPS } from '../../lib/runtimes/opencode/caps.ts'
import { openCodeEnv, startOpenCodeShim, type OpenCodeShimOptions } from '../../lib/runtimes/opencode/shim.ts'
import { childTripwireEnv, readChildTripwire } from '../guards/child-tripwire.ts'
import { assertNoCredentials } from '../guards/preflight.ts'
import { watchProxyEnv, type WatchProxy } from '../guards/watch-proxy.ts'
import { CHECKS, type Check } from '../suites/checks.ts'
import type { Cell, HarnessUnderTest } from '../suites/harness.ts'
import { TOOL_CHECKS } from '../suites/tool-checks.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WRAPPED = path.resolve(HERE, '..', 'broken', 'opencode-wrapped.ts')

export function fakeOpenCodeCommand(): string[] {
  return [process.execPath, path.resolve(HERE, '..', 'rig', 'fake-opencode.ts')]
}

export type WrappedHow = 'allows-all' | 'other-version' | 'dials-out' | 'ignores-reject' | 'picks-always'
/** OpenCode started wrong in one named way. See broken/opencode-wrapped.ts. */
export const wrapped = (how: WrappedHow, command: string[]): string[] =>
  [process.execPath, WRAPPED, how, String(command.length), ...command]

/**
 * The tool checks this harness runs: the ask flow. The shim holds each call while the door asks
 * in the room, and a yes is for one call, by its hash. The rest (the command policy's allow list,
 * the scratch folder, the limits, the web) need a gate that runs the tool, and OpenCode runs its
 * own: see `noTools`.
 */
export const OPENCODE_TOOL_CHECK_IDS = ['C6', 'C6n', 'C6d', 'C6t', 'C6x', 'C6r']
export const OPENCODE_TOOL_CHECKS: Check[] = TOOL_CHECKS.filter((c) => OPENCODE_TOOL_CHECK_IDS.includes(c.id))

/** Every check an OpenCode run makes at process level: the shared list, then the ask flow. */
export const ALL_CHECKS: Check[] = [...CHECKS, ...OPENCODE_TOOL_CHECKS]
const IDS = ALL_CHECKS.map((c) => c.id)
const allBut = (...red: string[]): string[] => IDS.filter((id) => !red.includes(id))

/** The shim's own env, minus anything credential-shaped and anything OpenCode's env already sets. */
function hostEnvSafeToHandOver(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name in base) continue
    try { assertNoCredentials({ [name]: value }) } catch { continue }
    out[name] = value
  }
  return out
}

/**
 * `hooks.onBreach` is told each time the shim catches the agent running something it was not given a yes for.
 * `hooks.watch` is a proxy the real OpenCode is told to send its traffic through. It is a compiled program,
 * which the tripwire cannot be loaded into; the fake, and the broken wrapper, are Node and get the tripwire too.
 */
export function openCodeHarness(command: string[], build: 'real' | 'fake', hooks: { onBreach?: (why: string) => void; watch?: WatchProxy } = {}): HarnessUnderTest {
  const marks = new Map<string, ReturnType<WatchProxy['mark']>>()
  // By their real paths: OpenCode resolves its folder through links (the temp dir is one on some systems),
  // and a call that names the same file by the other path would read to it as outside its folder.
  const real = (dir: string): string => { try { return realpathSync(dir) } catch { return dir } }
  const dirs = (cell: Cell) => ({ home: path.join(real(cell.dir), 'home'), work: path.join(real(cell.dir), 'work') })
  const tripwireLog = (cell: Cell): string => path.join(cell.dir, 'tripwire.log')
  const options = (cell: Cell, variant: string): OpenCodeShimOptions => {
    const d = dirs(cell)
    const watched = { ...childTripwireEnv(tripwireLog(cell)), ...(hooks.watch ? watchProxyEnv(hooks.watch.url) : {}) }
    const base: OpenCodeShimOptions = {
      ...cell.link, command, homeDir: d.home, workDir: d.work,
      modelBaseUrl: cell.modelBaseUrl, placeholder: cell.placeholder, systemPrompt: cell.systemPrompt,
      verdictTimeoutMs: cell.verdictTimeoutMs, vetoTimeoutMs: cell.vetoTimeoutMs, startMs: 30_000,
      rigEnv: watched, onBreach: hooks.onBreach,
    }
    switch (variant) {
      case 'good': return base
      case 'allows-all': case 'other-version': case 'dials-out': case 'ignores-reject': case 'picks-always':
        return { ...base, command: wrapped(variant, command) }
      case 'leaks-env': return { ...base, rigEnv: { ...watched, SWARMLAB_LEAK: cell.upstreamKey } }
      case 'inherits-env': return { ...base, rigEnv: { ...hostEnvSafeToHandOver(openCodeEnv(base, { configFile: '', permission: '', configDir: '' })), ...watched } }
      case 'unwatched': return { ...base, rigEnv: {} }
      default: throw new Error(`the OpenCode harness has no shim variant '${variant}'`)
    }
  }

  return {
    caps: OPENCODE_CAPS,
    build,
    modelShape: OPENAI_CHAT,
    shell: {
      touch: (file) => ({ name: 'bash', args: { command: `touch ${file}` } }),
      dumpEnv: (file) => ({ name: 'bash', args: { command: `env > ${file}` } }),
      exec: (command) => ({ name: 'bash', args: { command } }),
    },
    tools: {
      read: (file) => ({ name: 'read', args: { filePath: file } }),
      write: (file, content) => ({ name: 'write', args: { filePath: file, content } }),
      list: (dir) => ({ name: 'bash', args: { command: `ls ${dir}` } }),
      // OpenCode's own web tools are never started: the door has no class for them here.
      fetch: (url) => ({ name: 'webfetch', args: { url } }),
      search: (query) => ({ name: 'websearch', args: { query } }),
      outside: (cell) => {
        const dir = path.join(dirs(cell).home, 'outside')
        const file = path.join(dir, 'kept.txt')
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, `outside-${cell.nonce}`)
        return { file, holds: `outside-${cell.nonce}`, dir, dirHolds: 'kept.txt' }
      },
    },
    workFile: (cell, name) => path.join(dirs(cell).work, name),
    cellEnv: (cell, variant) => openCodeEnv(options(cell, variant), { configFile: path.join(dirs(cell).home, 'config.json'), permission: '{}', configDir: path.join(dirs(cell).home, 'config') }),
    tripwire: (cell) => {
      const inside = readChildTripwire(tripwireLog(cell))
      const mark = marks.get(cell.nonce)
      if (!hooks.watch) return inside
      // A real OpenCode is not Node: its proof of being watched is traffic the proxy carried.
      return mark ? { armed: mark.carried(), attempts: [...inside.attempts, ...mark.attempts()] } : { armed: 0, attempts: inside.attempts }
    },
    async start(cell, variant) {
      for (const dir of Object.values(dirs(cell))) mkdirSync(dir, { recursive: true })
      if (hooks.watch) marks.set(cell.nonce, hooks.watch.mark())
      return startOpenCodeShim(options(cell, variant))
    },
    broken: {
      // Its rules say "allow", so it asks nobody, and with every tool, not only the offered ones. The shim
      // sees a call finish that it never asked about and reports the turn as an error, so even a tool the
      // door would allow ends with no reply (C4+).
      'allows-all': {
        what: 'OpenCode started with its permission rules set to allow, so it asks nobody',
        red: ['C4', 'C4a', 'C4p', 'C4+', 'C5', 'C5v', 'C15t', 'C6', 'C6n', 'C6d', 'C6t', 'C6x', 'C6r'],
        green: ['C1', 'C2', 'C3', 'C9p', 'C12', 'C15'],
      },
      // The right outcome is that nothing runs at all: no prompt reaches it, so the model hears nothing.
      'other-version': {
        what: 'An OpenCode that says it is a version the checks were never run against',
        red: allBut('C3'), green: ['C3'],
      },
      'dials-out': {
        what: 'An OpenCode that tries to connect to an address outside this machine when it starts',
        red: allBut('C3'), green: ['C3'],
      },
      // ACP's permission request is advisory: the agent runs the tool. This one runs it on a no. The tool
      // has run by the time anyone can see it; the shim then reports the turn as an error, so its reply
      // is never posted (the must-fail tests check that), and the cell is what bounds what it reached.
      'ignores-reject': {
        what: 'An OpenCode that acts on a call the door said no to',
        red: ['C4', 'C4p', 'C5', 'C5v', 'C6n', 'C6d', 'C6t', 'C6r'],
        green: ['C1', 'C2', 'C3', 'C4a', 'C4+', 'C8p', 'C9p', 'C12', 'C15', 'C15t', 'C6', 'C6x'],
      },
      // A shim that answered "always": the agent stops asking, so the door is not asked about the same call again.
      'picks-always': {
        what: 'A shim whose yes reaches OpenCode as "always allow"',
        red: ['C6r'], green: allBut('C6r'),
      },
      'leaks-env': {
        what: 'The real model key planted in OpenCode\'s environment',
        red: ['C8p'], green: allBut('C8p'),
      },
      'inherits-env': {
        what: 'OpenCode started with the shim\'s own environment passed down',
        red: ['C8p'], green: allBut('C8p'),
      },
      'unwatched': {
        what: 'OpenCode started without the tripwire loaded inside it',
        red: ['C9p'], green: allBut('C9p'),
      },
    },
    noTools: 'not run for this harness: OpenCode runs its own tools, so the command policy\'s allow list, the scratch folder and the time and output limits are not the shim\'s to hold. The shim refuses a path outside the scratch folder that a call names, which is not the same as following links. Its web tools are never started. The ask flow (C6, C6n, C6d, C6t, C6x, C6r) is run',
    rows: [
      { id: 'C7', title: 'an unmapped tool is denied on a public agent', status: 'not-run',
        reason: 'OpenCode is started with every tool the door has no class for denied in its own rules, and the shim refuses any ACP tool kind it does not map. Unit tests drive the refusal; the door\'s answer to an unmapped name was not driven here' },
    ],
    caveats: [
      'ACP permission requests are advisory: OpenCode runs the tool itself. The shim catches a call that ran without a yes only after it ran, from what OpenCode reports. The sealed cell is what bounds it.',
    ],
  }
}
