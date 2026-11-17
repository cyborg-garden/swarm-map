// The checks that no turn ends in silence when its model call does not complete: the provider
// refuses it, the budget refuses it, or it never ends. Each is a turn with a tool in ask mode,
// as a live agent with tools has, and each must leave a receipt that says why and one short
// line in the room. docs/lab/tools-slice.md, "When a model call fails".
//
// They are run for a harness that runs the tool checks. Like those, they name no harness and
// read only the room, the scripted model, the files a tool touched and the door's receipts.
import { existsSync } from 'node:fs'
import { NOTICES } from '../../lib/door/door.ts'
import type { LedgerEntry } from '../../lib/door/connectors/fake.ts'
import type { ScriptEntry } from '../rig/scripted-model.ts'
import type { Check } from './checks.ts'
import type { Lab } from './lab.ts'

type Outcome = string[]
const want = (problems: Outcome, ok: boolean, what: string): void => { if (!ok) problems.push(what) }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const ROOM = 'r-general'
const ASK = { 'tools.allow': [], 'tools.ask': ['shell'] }
// As in the tool checks: the shim and the gate wait longer than the door does for an admin.
const HELD = { policy: ASK, approvalTimeoutMs: 6000, verdictTimeoutMs: 9000, vetoTimeoutMs: 12_000, turnDeadlineMs: 20_000 }

const say = (lab: Lab, text: string): string => lab.fake.say({ room: ROOM, sender: 'u-alice', mention: true, text })
const requests = (lab: Lab): LedgerEntry[] => lab.fake.ledger.filter((p) => p.text.startsWith('Approval needed.'))
const replies = (lab: Lab): LedgerEntry[] => lab.fake.ledger.filter((p) => !p.text.startsWith('Approval needed.'))
/** The door's first request in the room, once it is posted, or undefined if none comes. */
async function request(lab: Lab, timeoutMs = 5000): Promise<LedgerEntry | undefined> {
  const end = Date.now() + timeoutMs
  let over = false
  void lab.door.idle().then(() => { over = true })
  while (requests(lab).length < 1 && Date.now() < end && !over) await sleep(20)
  return requests(lab)[0]
}

export const MODEL_FAILURE_CHECKS: Check[] = [
  {
    id: 'C6m', title: 'tools on: a model call the provider refuses, after a tool ran, leaves a receipt and tells the room why',
    lab: HELD,
    async run(lab) {
      const p: Outcome = []
      const canary = lab.canary('c6m')
      const file = lab.file('c6m.touched')
      // The first call asks for the tool. Every call after it, the one with the tool's result in it, is refused.
      const entry: ScriptEntry = { match: canary, tools: [lab.harness.shell.touch(file)], text: 'never said' }
      entry.before = () => { entry.status = 400 }
      lab.script(entry)
      say(lab, `try ${canary}`)
      const req = await request(lab)
      want(p, req !== undefined, 'no request was posted, so nothing was checked')
      if (req) lab.fake.say({ room: ROOM, sender: 'u-root', text: 'approve', replyTo: req.id })
      await lab.door.idle()
      want(p, existsSync(file), 'the tool did not run, so the call after it was never made')
      const refused = lab.receipts.all().filter((r) => r.event.kind === 'model' && r.verdict === 'deny' && r.rule === 'model.provider' && r.note === 'status=400')
      want(p, refused.length >= 1, 'the refused model call left no receipt that says why')
      const said = replies(lab).map((post) => post.text)
      want(p, said.length === 1, `expected one line in the room after the request, got ${said.length}`)
      want(p, said[0] === NOTICES.failed('The model provider refused the call (status 400).'), `the room was not told why: ${JSON.stringify(said[0] ?? null)}`)
      return p
    },
  },
  {
    id: 'C6b', title: 'tools on: a model call refused because the budget is spent leaves a receipt and tells the room why',
    lab: { ...HELD, policy: { ...ASK, budget: { monthlyUsd: 1, onExceed: 'refuse' } } },
    async run(lab) {
      const p: Outcome = []
      // One scripted reply costs exactly the budget, so the turn after it is refused before it is forwarded.
      const [first, second] = [lab.canary('c6b-first'), lab.canary('c6b-second')]
      lab.script({ match: first, text: 'spent it' })
      lab.script({ match: second, text: 'never said' })
      say(lab, `one ${first}`)
      await lab.door.idle()
      say(lab, `two ${second}`)
      await lab.door.idle()
      want(p, lab.model.heard(first), 'the first turn never reached the model, so nothing was checked')
      want(p, !lab.model.heard(second), 'a call over the budget reached the model')
      want(p, lab.receipts.all().some((r) => r.event.kind === 'model' && r.verdict === 'deny' && r.rule === 'budget.cap'), 'the refused call left no receipt')
      const said = replies(lab).map((post) => post.text)
      want(p, said.length === 2 && said[0].includes(`FAKE-MODEL-${lab.nonce}`), `expected the first answer and one line for the second, got ${JSON.stringify(said)}`)
      want(p, said[1] === NOTICES.failed('The monthly budget is spent.'), `the room was not told why: ${JSON.stringify(said[1] ?? null)}`)
      return p
    },
  },
  {
    id: 'C6s', title: 'tools on: a model call slower than the turn is allowed tells the room the door stopped waiting',
    lab: { ...HELD, turnDeadlineMs: 6000 },
    async run(lab) {
      const p: Outcome = []
      const canary = lab.canary('c6s')
      lab.script({ match: canary, text: 'too late', hang: true })
      say(lab, `try ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the turn never reached the model, so nothing was checked')
      want(p, lab.receipts.all().some((r) => r.verdict === 'drop' && r.why === 'The harness did not finish the turn in time.'), 'no receipt says the turn ran out of time')
      const said = replies(lab).map((post) => post.text)
      want(p, said.length === 1 && said[0] === NOTICES.timeout, `the room was not told: ${JSON.stringify(said)}`)
      return p
    },
  },
]
