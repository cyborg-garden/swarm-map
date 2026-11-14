// Letta Code, as the shared suite sees it. Everything Letta Code-specific
// about the lab is here: how its shim starts, what its provider file looks
// like, which native tool is a shell, which ways of breaking it the suite
// must catch, the two checks only it needs, and which spec checks do not apply.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENAI_CHAT } from '../../lib/door/model-shapes.ts'
import { LETTA_CODE_CAPS } from '../../lib/runtimes/letta-code/caps.ts'
import {
  lettaCodeEnv, startLettaCodeShim, writeLettaCodeProvider, type LettaCodeShimOptions,
} from '../../lib/runtimes/letta-code/shim.ts'
import { childTripwireEnv, readChildTripwire } from '../guards/child-tripwire.ts'
import { assertNoCredentials } from '../guards/preflight.ts'
import { CHECKS, type Check } from '../suites/checks.ts'
import type { Cell, HarnessUnderTest, NativeToolCall } from '../suites/harness.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WRAPPED = path.resolve(HERE, '..', 'broken', 'letta-code-wrapped.ts')

export function fakeLettaCodeCommand(): string[] {
  return [process.execPath, path.resolve(HERE, '..', 'rig', 'fake-letta-code.ts')]
}

/** Letta Code started wrong in one named way. See broken/letta-code-wrapped.ts. */
export const wrapped = (how: 'unrestricted' | 'other-version' | 'dials-out', command: string[]): string[] =>
  [process.execPath, WRAPPED, how, String(command.length), ...command]

const F = 'surfaces.fake.'
const room = (id: string, mode: 'mention' | 'free') => ({ match: { room: id }, mode })
/** The one room this harness is given. The lab's fixture opens more, and the door would then give it nothing. */
export const ONE_ROOM = { [F + 'rooms']: [room('r-general', 'mention')] }

/** A shell call that writes a note into the agent's own memory, the way Letta Code keeps one: a committed file. */
const plant = (note: string): NativeToolCall => ({
  name: 'Bash',
  args: { command: `cd "$MEMORY_DIR" && printf -- '---\\nname: planted\\ndescription: a note\\n---\\n%s\\n' '${note}' > planted.md && git add planted.md && git -c user.name=lab -c user.email=lab@example.invalid commit -q -m plant` },
})

type Outcome = string[]
const want = (problems: Outcome, ok: boolean, what: string): void => { if (!ok) problems.push(what) }

/** Every file under `dir`, links not followed. */
function filesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    const stat = lstatSync(file)
    if (stat.isDirectory()) filesUnder(file, out)
    else if (stat.isFile()) out.push(file)
  }
  return out
}

/**
 * The checks only this harness needs. Both are in the spec's list. They are
 * here, not in the shared list, because each is about something only a
 * harness like this one has: a memory of its own, and chat channels of its own.
 */
export const LETTA_CODE_CHECKS: Check[] = [
  {
    // The spec's C11 is wider: it also covers the sidecar's own memory and a DM against a
    // room, neither of which is built. This is the half about the harness's own memory.
    id: 'C11n', title: 'what the harness remembers from one room never reaches another, because a harness with one memory is refused a second room',
    lab: { policy: { 'tools.allow': ['shell'], [F + 'rooms']: [room('r-general', 'mention'), room('r-lounge', 'free')] } },
    async run(lab) {
      const p: Outcome = []
      const note = lab.canary('c11n-note')
      const [first, second] = [lab.canary('c11n-first'), lab.canary('c11n-second')]
      // Room one: the model is told to write a note into the agent's memory.
      lab.script({ match: first, tool: plant(note), text: 'noted' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `remember ${first}` })
      await lab.door.idle()
      // Room two: an ordinary question. What the model is sent for it must not hold the note.
      lab.script({ match: second, text: 'hello' })
      lab.fake.say({ room: 'r-lounge', sender: 'u-alice', text: `what do you know ${second}` })
      await lab.door.idle()
      const crossed = lab.model.requests.some((r) => r.body.includes(second) && r.body.includes(note))
      want(p, !crossed, 'a note written to memory in one room was sent to the model in another')
      // And it held for the reason given: the door turned both rooms away, so the model heard neither.
      const refused = lab.receipts.all().filter((r) => r.rule === 'mem.one-scope' && r.verdict === 'drop').length
      want(p, refused === 2, `expected both rooms to be refused under mem.one-scope, got ${refused}`)
      want(p, !lab.model.heard(first) && !lab.model.heard(second), 'a room was delivered to a harness that should have been refused it')

      // The same two rooms, opened one after the other. Each policy opens one room, so each
      // fits. The harness is given the first, writes a note there, and must not be given the second.
      const moved = lab.canary('c11n-moved-note')
      const [third, fourth] = [lab.canary('c11n-third'), lab.canary('c11n-fourth')]
      lab.door.setPolicy(lab.policy({ version: 2, [F + 'rooms']: [room('r-general', 'mention')] }))
      lab.script({ match: third, tool: plant(moved), text: 'noted' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `remember ${third}` })
      await lab.door.idle()
      want(p, lab.model.heard(third), 'the one room it may be given was not delivered, so moving it was not tested')
      lab.door.setPolicy(lab.policy({ version: 3, [F + 'rooms']: [room('r-lounge', 'free')] }))
      lab.script({ match: fourth, text: 'hello' })
      lab.fake.say({ room: 'r-lounge', sender: 'u-alice', text: `what do you know ${fourth}` })
      await lab.door.idle()
      want(p, !lab.model.heard(fourth), 'after its one room was moved, the harness was given the new room')
      want(p, !lab.model.requests.some((r) => r.body.includes(fourth) && r.body.includes(moved)), 'a note written to memory in one room was sent to the model in the room it was moved to')
      const after = lab.receipts.all().filter((r) => r.rule === 'mem.one-scope' && r.verdict === 'drop').length
      want(p, after === refused + 1, `expected the room it was moved to to be refused under mem.one-scope, got ${after - refused} such refusal(s)`)
      return p
    },
  },
  {
    id: 'C16', title: 'a harness that owns chat runs with its channels off and holds no chat credential',
    lab: { policy: { 'tools.allow': ['shell'] } },
    async run(lab) {
      const p: Outcome = []
      // One whole turn with a tool call, so the harness has started and written whatever it writes.
      const canary = lab.canary('c16')
      const dump = lab.file('c16.env')
      lab.script({ match: canary, tool: lab.harness.shell.dumpEnv(dump), text: 'done' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `run ${canary}` })
      await lab.door.idle()
      want(p, existsSync(dump), 'the turn did not run to the end, so nothing was checked')
      const files = filesUnder(lab.dir)
      want(p, files.length >= 3, `only ${files.length} files were found in the cell's folder, so nothing was checked`)
      // Channels are set up in a folder of that name under the harness's home. There must be none.
      const channelFiles = files.filter((f) => path.relative(lab.dir, f).split(path.sep).includes('channels'))
      want(p, channelFiles.length === 0, `the harness has chat channels set up: ${channelFiles.length} file(s) under a channels folder`)
      const holders = files.filter((f) => readFileSync(f).includes(lab.secrets.chat))
      want(p, holders.length === 0, `the chat token is in ${holders.length} file(s) in the cell's folder`)
      want(p, !lab.model.requests.some((r) => r.body.includes(lab.secrets.chat)), 'the chat token reached the model')
      // The only post came from the model, through the door: the harness posted nothing itself.
      want(p, lab.fake.ledger.length === 1 && lab.fake.ledger[0].text.includes(`FAKE-MODEL-${lab.nonce}`), `expected 1 post from the model, got ${lab.fake.ledger.length}`)
      return p
    },
  },
]

/** Every check a Letta Code run makes at process level: the shared list, then its own two. */
export const ALL_CHECKS: Check[] = [...CHECKS, ...LETTA_CODE_CHECKS]
const IDS = ALL_CHECKS.map((c) => c.id)
const allBut = (...red: string[]): string[] => IDS.filter((id) => !red.includes(id))

/** The shim's own env, minus anything credential-shaped and anything Letta Code's env already sets. */
function hostEnvSafeToHandOver(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name in base) continue
    try { assertNoCredentials({ [name]: value }) } catch { continue }
    out[name] = value
  }
  return out
}

export function lettaCodeHarness(command: string[], build: 'real' | 'fake'): HarnessUnderTest {
  const dirs = (cell: Cell) => ({ home: path.join(cell.dir, 'home'), work: path.join(cell.dir, 'work') })
  const tripwireLog = (cell: Cell): string => path.join(cell.dir, 'tripwire.log')
  const options = (cell: Cell, variant: string): LettaCodeShimOptions => {
    const d = dirs(cell)
    // Letta Code runs on Node, so Node is told to load the tripwire first in every one this lab starts.
    const watched = childTripwireEnv(tripwireLog(cell))
    const base: LettaCodeShimOptions = {
      ...cell.link, command, homeDir: d.home, workDir: d.work,
      verdictTimeoutMs: cell.verdictTimeoutMs, vetoTimeoutMs: cell.vetoTimeoutMs, startMs: 20_000,
      rigEnv: watched,
    }
    switch (variant) {
      case 'good': case 'holds-chat-token': return base
      case 'ignores-verdicts': return { ...base, command: wrapped('unrestricted', command) }
      case 'other-version': return { ...base, command: wrapped('other-version', command) }
      case 'dials-out': return { ...base, command: wrapped('dials-out', command) }
      case 'leaks-env': return { ...base, rigEnv: { ...watched, SWARMLAB_LEAK: cell.upstreamKey } }
      case 'inherits-env': return { ...base, rigEnv: { ...hostEnvSafeToHandOver(lettaCodeEnv(base)), ...watched } }
      case 'unwatched': return { ...base, rigEnv: {} }
      case 'hides-memory': return { ...base, rigCaps: { nativeMemory: 'none' } }
      default: throw new Error(`the Letta Code harness has no shim variant '${variant}'`)
    }
  }

  return {
    caps: LETTA_CODE_CAPS,
    build,
    modelShape: OPENAI_CHAT,
    policy: ONE_ROOM,
    shell: {
      touch: (file) => ({ name: 'Bash', args: { command: `touch ${file}` } }),
      dumpEnv: (file) => ({ name: 'Bash', args: { command: `env > ${file}` } }),
      exec: (command) => ({ name: 'Bash', args: { command } }),
    },
    workFile: (cell, name) => path.join(dirs(cell).work, name),
    cellEnv: (cell, variant) => lettaCodeEnv(options(cell, variant)),
    tripwire: (cell) => readChildTripwire(tripwireLog(cell)),
    async start(cell, variant) {
      const d = dirs(cell)
      for (const dir of Object.values(d)) mkdirSync(dir, { recursive: true })
      // Letta Code is pointed at the sidecar's model route and given a placeholder, never a key.
      writeLettaCodeProvider(d.home, { baseUrl: cell.modelBaseUrl, placeholder: cell.placeholder })
      if (variant === 'holds-chat-token') {
        // What a cell would hold if Letta Code's own chat channels had been set up in it.
        const account = path.join(d.home, '.letta', 'channels', 'discord', 'accounts.json')
        mkdirSync(path.dirname(account), { recursive: true })
        writeFileSync(account, JSON.stringify({ accounts: [{ token: `FAKECHAT-${cell.nonce}` }] }))
      }
      return startLettaCodeShim(options(cell, variant))
    },
    broken: {
      'ignores-verdicts': {
        what: 'Letta Code started in the permission mode that asks nobody, so every tool runs unasked',
        // C15t is red too: the added tool runs, but nobody was asked, so there is no receipt for it.
        red: ['C4', 'C4p', 'C5', 'C5v', 'C15t'], green: allBut('C4', 'C4p', 'C5', 'C5v', 'C15t'),
      },
      'leaks-env': {
        what: 'The real model key planted in Letta Code\'s environment',
        red: ['C8p'], green: allBut('C8p'),
      },
      'inherits-env': {
        what: 'Letta Code started with the shim\'s own environment passed down',
        red: ['C8p'], green: allBut('C8p'),
      },
      // The right outcome is that nothing runs at all: no turn reaches the model (C1) and the
      // allowed tool does not run (C4+). A dropped message is still dropped (C3).
      'other-version': {
        what: 'A Letta Code that says it is a version the checks were never run against',
        red: ['C1', 'C4+'], green: ['C3'],
      },
      // Every check that starts Letta Code goes red, not only C9p: an attempt to leave the
      // machine fails whichever check it happened in. C3 starts none, so it stays green.
      'dials-out': {
        what: 'A Letta Code that tries to connect to an address outside this machine when it starts',
        red: allBut('C3'), green: ['C3'],
      },
      // Everything works, but nothing was watching. No evidence is not a pass: C9p must say so.
      'unwatched': {
        what: 'Letta Code started without the tripwire loaded inside it',
        red: ['C9p'], green: allBut('C9p'),
      },
      // The door takes the shim's word for what memory the harness keeps. A shim that lies is
      // given the second room, and then the note does cross. That is the gap the rule covers.
      'hides-memory': {
        what: 'A shim that tells the door Letta Code keeps no memory of its own',
        red: ['C11n'], green: allBut('C11n'),
      },
      'holds-chat-token': {
        what: 'A cell where Letta Code\'s own chat channels were set up, with the chat token in a file',
        red: ['C16'], green: allBut('C16'),
      },
    },
    rows: [
      { id: 'C7', title: 'an unmapped tool is denied on a public agent', status: 'not-run',
        reason: 'this shim starts Letta Code with exactly the tools the door offered, and the door offers only mapped ones, so an unmapped tool is never attached. Whether the door would refuse one was not driven' },
    ],
  }
}
