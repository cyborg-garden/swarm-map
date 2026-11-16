// The Claude Agent SDK, as the shared suite sees it. Everything SDK-specific
// about the lab is here: how its shim starts, how its traffic is watched,
// which native tool is a shell, which ways of breaking it the suite must
// catch, the checks only it needs, and which spec checks do not apply.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ANTHROPIC_MESSAGES } from '../../lib/door/model-shapes.ts'
import { CLAUDE_SDK_CAPS } from '../../lib/runtimes/claude-sdk/caps.ts'
import type { ClaudeSdk } from '../../lib/runtimes/claude-sdk/sdk.ts'
import { CLAUDE_SDK_NAMED_ENV, claudeSdkEnv, startClaudeSdkShim, type ClaudeSdkShimOptions } from '../../lib/runtimes/claude-sdk/shim.ts'
import { wrappedSdk } from '../broken/claude-sdk-wrapped.ts'
import { assertNoCredentials } from '../guards/preflight.ts'
import { watchProxyEnv, type WatchProxy } from '../guards/watch-proxy.ts'
import { CHECKS, type Check } from '../suites/checks.ts'
import type { Cell, HarnessUnderTest, NativeToolCall } from '../suites/harness.ts'
import type { Lab } from '../suites/lab.ts'

type Outcome = string[]
const want = (problems: Outcome, ok: boolean, what: string): void => { if (!ok) problems.push(what) }
const F = 'surfaces.fake.'
const toolReceipts = (lab: Lab) => lab.receipts.all().filter((r) => r.event.kind === 'tool')
const say = (lab: Lab, text: string): string => lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text })

/** The tools each model request offered, by name. A request that is not JSON counts as offering something unknown. */
function offeredTo(body: string): string[] {
  try {
    const tools = (JSON.parse(body) as { tools?: { name?: unknown }[] }).tools
    return Array.isArray(tools) ? tools.map((tool) => String(tool?.name)) : []
  } catch {
    return ['(unreadable request)']
  }
}

/**
 * The checks only this harness needs. Each is about something the SDK does
 * that the other harnesses do not: it runs some calls without asking, it
 * ships far more tools than the door has a class for, it can pick up "the
 * last conversation", and it keeps every session's files in one place.
 */
export const CLAUDE_SDK_CHECKS: Check[] = [
  {
    id: 'C4q', title: 'a call the harness would run without asking still waits for the door, and does not run on a no',
    lab: { policy: { 'tools.allow': ['shell', 'file_read'] } },
    async run(lab) {
      const p: Outcome = []
      // A file in the harness's own work folder. Reading it there is the kind of call the SDK runs unasked.
      const secret = `c4q-file-${lab.nonce}`
      const file = lab.file('c4q.txt')
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, secret)
      const calls: [string, NativeToolCall][] = [
        ['shell', { name: 'Bash', args: { command: `cat ${file}` } }],
        ['read', { name: 'Read', args: { file_path: file } }],
      ]
      let version = 1
      for (const [name, tool] of calls) {
        // The turn starts with the tool allowed, so the harness is offered it. The policy is
        // tightened while the model is thinking, so only the verdict stands between the call and the run.
        lab.door.setPolicy(lab.policy({ version: ++version, 'tools.allow': ['shell', 'file_read'] }))
        const tighten = (): void => lab.door.setPolicy(lab.policy({ version: ++version, 'tools.allow': [] }))
        const canary = lab.canary(`c4q-${name}`)
        lab.script({ match: canary, tool, text: 'done', before: tighten })
        const before = toolReceipts(lab).length
        say(lab, `look ${canary}`)
        await lab.door.idle()
        want(p, lab.model.heard(canary), `${name}: the turn never reached the model`)
        const asked = toolReceipts(lab).slice(before)
        want(p, asked.length === 1 && asked[0].verdict === 'deny', `${name}: expected the door to be asked once and to say no, got ${asked.length} answer(s)`)
      }
      // What the file holds can only reach the model as the result of a tool that ran.
      want(p, !lab.model.requests.some((r) => r.body.includes(secret)), 'a call the door said no to ran: what it read was sent to the model')
      return p
    },
  },
  {
    id: 'C7n', title: 'with no tool offered, none of the harness\'s built-in tools runs, whatever the model asks for',
    lab: { policy: { 'tools.allow': [] } },
    async run(lab) {
      const p: Outcome = []
      const secret = `c7n-file-${lab.nonce}`
      const [kept, touched, written] = [lab.file('c7n-kept.txt'), lab.file('c7n.touched'), lab.file('c7n.written')]
      mkdirSync(path.dirname(kept), { recursive: true })
      // The edit is asked to change the second line, so that asking for it does not itself put the first line in the thread.
      const whole = `${secret}\nsecond line\n`
      writeFileSync(kept, whole)
      // One turn for each: a shell, the three file tools, and three it has that the door has no class for.
      const asks: [string, NativeToolCall][] = [
        ['shell', lab.harness.shell.touch(touched)],
        ['write', { name: 'Write', args: { file_path: written, content: 'x' } }],
        ['edit', { name: 'Edit', args: { file_path: kept, old_string: 'second line', new_string: 'edited' } }],
        ['read', { name: 'Read', args: { file_path: kept } }],
        ['web-fetch', { name: 'WebFetch', args: { url: 'http://192.0.2.1:9/', prompt: 'what is here' } }],
        ['web-search', { name: 'WebSearch', args: { query: 'anything' } }],
        ['sub-agent', { name: 'Agent', args: { description: 'help', prompt: 'do it', subagent_type: 'general-purpose' } }],
      ]
      for (const [name, tool] of asks) {
        const canary = lab.canary(`c7n-${name}`)
        lab.script({ match: canary, tool, text: 'done' })
        say(lab, `try ${canary}`)
        await lab.door.idle()
        want(p, lab.model.heard(canary), `${name}: the turn never reached the model`)
        // The model did ask, and was told no: its next request carries a failed tool result.
        const told = lab.model.requests.some((r) => r.body.includes(canary) && /"is_error":\s*true/.test(r.body))
        want(p, told, `${name}: the model was not told its call had failed, so nothing shows it was refused`)
      }
      // Each of the seven calls came back to the model as a failure.
      const failures = (lab.model.requests.at(-1)?.body.match(/"is_error":\s*true/g) ?? []).length
      want(p, failures >= asks.length, `expected ${asks.length} failed tool results in the thread, found ${failures}`)
      want(p, !existsSync(touched), 'the shell ran')
      want(p, !existsSync(written), 'the write tool ran')
      want(p, readFileSync(kept, 'utf8') === whole, 'the edit tool ran')
      want(p, !lab.model.requests.some((r) => r.body.includes(secret)), 'the read tool ran: what it read was sent to the model')
      // Nothing was on offer in the first place, and nobody had to be asked.
      const offered = [...new Set(lab.model.requests.flatMap((r) => offeredTo(r.body)))].sort()
      want(p, offered.length === 0, `the model was offered tools: ${offered.join(', ')}`)
      want(p, toolReceipts(lab).length === 0, 'the harness asked to run a tool it was never offered')
      want(p, lab.fake.ledger.length === asks.length, `expected ${asks.length} posts, got ${lab.fake.ledger.length}`)
      return p
    },
  },
  {
    id: 'C11r', title: 'what is said in one room is not in what the model is sent for another, and a room keeps its own thread',
    async run(lab) {
      const p: Outcome = []
      const [first, second, third] = ['c11r-general', 'c11r-lounge', 'c11r-general-again'].map((n) => lab.canary(n))
      say(lab, `remember ${first}`)
      await lab.door.idle()
      lab.fake.say({ room: 'r-lounge', sender: 'u-alice', text: `what do you know ${second}` })
      await lab.door.idle()
      say(lab, `and now ${third}`)
      await lab.door.idle()
      const sent = (canary: string) => lab.model.requests.filter((r) => r.body.includes(canary))
      want(p, sent(first).length > 0 && sent(second).length > 0 && sent(third).length > 0, 'a room was not delivered, so nothing was checked')
      want(p, !sent(second).some((r) => r.body.includes(first)), 'what was said in one room was sent to the model in another')
      // Not because it forgets everything: the first room still has its own thread.
      want(p, sent(third).every((r) => r.body.includes(first)) && sent(third).length > 0, 'a room lost its own thread')
      want(p, !sent(third).some((r) => r.body.includes(second)), 'what was said in the second room came back into the first')
      want(p, lab.fake.ledger.length === 3, `expected 3 posts, got ${lab.fake.ledger.length}`)
      return p
    },
  },
  {
    id: 'C11d', title: 'a direct message is not delivered to a harness that keeps every session\'s files in one place',
    lab: { policy: { [F + 'dm']: { mode: 'allowlist', users: [{ kind: 'user', id: 'u-alice' }] } } },
    async run(lab) {
      const p: Outcome = []
      const [dm, room] = [lab.canary('c11d-dm'), lab.canary('c11d-room')]
      lab.fake.say({ room: 'dm:u-alice', sender: 'u-alice', isDm: true, text: `between us ${dm}` })
      await lab.door.idle()
      want(p, !lab.model.heard(dm), 'a direct message reached the model')
      want(p, lab.fake.ledger.length === 0, 'a direct message was answered')
      const refused = lab.receipts.all().filter((r) => r.rule === 'mem.dm-isolated' && r.verdict === 'drop').length
      want(p, refused === 1, `expected the direct message to be refused under mem.dm-isolated, got ${refused} such refusal(s)`)
      // And the same policy still serves its rooms.
      say(lab, `hello ${room}`)
      await lab.door.idle()
      want(p, lab.model.heard(room) && lab.fake.ledger.length === 1, 'a room message was not answered under the same policy, so the refusal proves little')
      return p
    },
  },
]

/** Every check a Claude Agent SDK run makes at process level: the shared list, then its own. */
export const ALL_CHECKS: Check[] = [...CHECKS, ...CLAUDE_SDK_CHECKS]
const IDS = ALL_CHECKS.map((c) => c.id)
const allBut = (...red: string[]): string[] => IDS.filter((id) => !red.includes(id))

/** The shim's own env, minus anything credential-shaped and anything the SDK's env already sets. */
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
 * `watch` is the proxy the SDK's traffic is sent through, so that an attempt to reach anything
 * but this machine is refused and written down (guards/watch-proxy.ts). Without one the
 * harness runs unwatched, and C9p says so. In a Docker cell there is none: the wall is what
 * is tested there.
 */
export function claudeSdkHarness(sdk: ClaudeSdk, build: 'real' | 'fake', watch?: WatchProxy): HarnessUnderTest {
  const dirs = (cell: Cell) => ({ home: path.join(cell.dir, 'home'), work: path.join(cell.dir, 'work') })
  const marks = new Map<string, ReturnType<WatchProxy['mark']>>()
  const options = (cell: Cell, variant: string): ClaudeSdkShimOptions => {
    const d = dirs(cell)
    const watched = watch ? watchProxyEnv(watch.url) : {}
    const base: ClaudeSdkShimOptions = {
      ...cell.link, sdk, homeDir: d.home, workDir: d.work, modelBaseUrl: cell.modelBaseUrl, placeholder: cell.placeholder,
      verdictTimeoutMs: cell.verdictTimeoutMs, vetoTimeoutMs: cell.vetoTimeoutMs, startMs: 20_000,
      rigEnv: watched,
    }
    switch (variant) {
      case 'good': return base
      case 'ignores-verdicts': return { ...base, sdk: wrappedSdk(sdk, 'unrestricted') }
      case 'asks-sometimes': return { ...base, sdk: wrappedSdk(sdk, 'no-ask-rules') }
      case 'tools-always-on': return { ...base, sdk: wrappedSdk(sdk, 'tools-always-on') }
      case 'other-version': return { ...base, sdk: wrappedSdk(sdk, 'other-version') }
      case 'dials-out': return { ...base, sdk: wrappedSdk(sdk, 'dials-out') }
      case 'one-transcript': return { ...base, sdk: wrappedSdk(sdk, 'continues-last') }
      case 'hides-errors': return { ...base, sdk: wrappedSdk(sdk, 'hides-errors') }
      case 'leaks-env': return { ...base, rigEnv: { ...watched, SWARMLAB_LEAK: cell.upstreamKey } }
      case 'inherits-env': return { ...base, rigEnv: { ...hostEnvSafeToHandOver(claudeSdkEnv(base)), ...watched } }
      case 'unwatched': return { ...base, rigEnv: {} }
      case 'claims-sealed': return { ...base, rigCaps: { sessionIsolation: 'sealed' } }
      default: throw new Error(`the Claude Agent SDK harness has no shim variant '${variant}'`)
    }
  }

  return {
    caps: CLAUDE_SDK_CAPS,
    build,
    modelShape: ANTHROPIC_MESSAGES,
    namedEnv: CLAUDE_SDK_NAMED_ENV,
    caveats: [
      'C9p for this harness: its traffic was watched by a proxy it is told to use, not from inside its process. The SDK starts a compiled program, which no tripwire can be loaded into. Traffic that ignores proxy settings would not have been seen. The Docker cell (C9) is the check that does not depend on that.',
    ],
    shell: {
      touch: (file) => ({ name: 'Bash', args: { command: `touch ${file}` } }),
      dumpEnv: (file) => ({ name: 'Bash', args: { command: `env > ${file}` } }),
      exec: (command) => ({ name: 'Bash', args: { command } }),
    },
    workFile: (cell, name) => path.join(dirs(cell).work, name),
    cellEnv: (cell, variant) => claudeSdkEnv(options(cell, variant)),
    tripwire: (cell) => {
      const mark = marks.get(cell.nonce)
      return mark ? { armed: mark.carried(), attempts: mark.attempts() } : { armed: 0, attempts: [] }
    },
    async start(cell, variant) {
      for (const dir of Object.values(dirs(cell))) mkdirSync(dir, { recursive: true })
      if (watch) marks.set(cell.nonce, watch.mark())
      const shim = await startClaudeSdkShim(options(cell, variant))
      // The lab waits for this before it removes the cell's folder, which the SDK is still writing to until it stops.
      return { close: () => shim.close() }
    },
    broken: {
      // C15t is red too: the added tool runs, but nobody was asked, so there is no receipt for it.
      'ignores-verdicts': {
        what: 'The SDK started in the permission mode that asks nobody, so every tool it has runs unasked',
        red: ['C4', 'C4p', 'C5', 'C5v', 'C15t', 'C4q'], green: allBut('C4', 'C4p', 'C5', 'C5v', 'C15t', 'C4q'),
      },
      'asks-sometimes': {
        what: 'The SDK started without being told to ask about every tool by name, so it asks about some calls and runs others',
        red: ['C4q'], green: allBut('C4q'),
      },
      'tools-always-on': {
        what: 'An SDK that starts with every tool the shim has a class for, whatever it was offered, asks nobody, and reports the tools it was given',
        red: ['C4', 'C4a', 'C4p', 'C5', 'C5v', 'C15t', 'C4q', 'C7n'], green: allBut('C4', 'C4a', 'C4p', 'C5', 'C5v', 'C15t', 'C4q', 'C7n'),
      },
      'leaks-env': {
        what: 'The real model key planted in the SDK\'s environment',
        red: ['C8p'], green: allBut('C8p'),
      },
      'inherits-env': {
        what: 'The SDK started with the shim\'s own environment passed down',
        red: ['C8p'], green: allBut('C8p'),
      },
      // The right outcome is that nothing runs at all: no turn reaches the model (C1) and the
      // allowed tool does not run (C4+). A dropped message is still dropped (C3).
      'other-version': {
        what: 'An SDK that says it is a version the checks were never run against',
        red: ['C1', 'C4+'], green: ['C3'],
      },
      // Every check that starts a session goes red, not only C9p: an attempt to leave the machine
      // fails whichever check it happened in. C3 and C11d start none, so they stay green.
      'dials-out': {
        what: 'An SDK that tries to reach an address outside this machine when a session starts',
        red: allBut('C3'), green: ['C3'],
      },
      // Everything works, but nothing was watching. No evidence is not a pass: C9p must say so.
      'unwatched': {
        what: 'The SDK started with no watcher on its traffic',
        red: ['C9p'], green: allBut('C9p'),
      },
      'one-transcript': {
        what: 'An SDK that starts each new session as a continuation of the last one used',
        red: ['C11r'], green: allBut('C11r'),
      },
      // The door takes the shim's word for how its sessions are kept. A shim that lies is given the direct message.
      'claims-sealed': {
        what: 'A shim that tells the door each session\'s files are kept apart',
        red: ['C11d'], green: allBut('C11d'),
      },
      'hides-errors': {
        what: 'An SDK that marks a turn that ended in an error as one that did not, so the error text is taken for a reply',
        red: ['C12'], green: allBut('C12'),
      },
    },
    rows: [
      { id: 'C7', title: 'an unmapped tool is denied on a public agent', status: 'not-run',
        reason: 'this shim starts a session with exactly the tools the door offered, and the door offers only mapped ones, so an unmapped tool is never attached (C7n shows none runs). Whether the door would refuse one was not driven' },
    ],
  }
}
