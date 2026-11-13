// The shim conformance checks. Each one drives a fresh lab and reads only
// harness-blind observables:
//   heard     the canary reached the scripted model
//   answered  the fake connector got a post, stamped by the scripted model
//   toolRan   a canary file was touched
//   secret    a planted secret showed up where it must not
// plus the door's own receipts. A check returns pass or fail with a reason;
// it never throws for a failed expectation, so the must-fail suite can see
// exactly which checks a broken shim turns red.
//
// The checks name no harness. Which native tool is a shell, and what the
// harness is called, come from the HarnessUnderTest the lab was started with.
import { existsSync, readFileSync } from 'node:fs'
import { startLab, type Lab, type LabOptions } from './lab.ts'

export interface CheckResult { id: string; title: string; pass: boolean; detail: string }
type Outcome = string[] // problems found; empty means pass

interface Check {
  id: string
  title: string
  lab?: Partial<LabOptions>
  run(lab: Lab): Promise<Outcome>
}

const F = 'surfaces.fake.'
const violations = (lab: Lab): number =>
  lab.receipts.all().filter((r) => r.rule === 'turn.known' || r.rule === 'turn.one-reply').length
const stamped = (lab: Lab): boolean => lab.fake.ledger.every((p) => p.text.includes(`FAKE-MODEL-${lab.nonce}`))
const want = (problems: Outcome, ok: boolean, what: string): void => { if (!ok) problems.push(what) }
const ask = (lab: Lab, text: string, sender: Parameters<Lab['fake']['say']>[0]['sender'] = 'u-alice'): string =>
  lab.fake.say({ room: 'r-general', sender, mention: true, text })
/** Script the model to ask for a shell call that touches a canary file. `before` runs just before it asks. */
const touchScript = (lab: Lab, name: string, before?: () => void): { canary: string; file: string } => {
  const canary = lab.canary(name)
  const file = lab.file(`${name}.touched`)
  lab.script({ match: canary, tool: lab.harness.shell.touch(file), text: 'done', before })
  return { canary, file }
}
const toolReceipts = (lab: Lab) => lab.receipts.all().filter((r) => r.event.kind === 'tool')

export const CHECKS: Check[] = [
  {
    id: 'C1', title: 'a delivered turn gives exactly one reply, from the model, for the right turn',
    async run(lab) {
      const p: Outcome = []
      const canary = lab.canary('c1')
      lab.script({ match: canary, text: 'the answer' })
      ask(lab, `please ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the model never heard the message')
      want(p, lab.fake.ledger.length === 1, `expected 1 post, got ${lab.fake.ledger.length}`)
      want(p, lab.fake.ledger.length > 0 && stamped(lab), 'a post did not come from the scripted model')
      want(p, lab.fake.ledger[0]?.text.startsWith('the answer') === true, 'the post is not the scripted reply')
      want(p, violations(lab) === 0, `${violations(lab)} protocol violations`)
      return p
    },
  },
  {
    id: 'C2', title: 'overheard lines arrive as context on the next turn and cause no reply',
    lab: { policy: { [F + 'observeUnmentioned']: true } },
    async run(lab) {
      const p: Outcome = []
      const overheard = lab.canary('c2-overheard')
      const asked = lab.canary('c2-asked')
      lab.fake.say({ room: 'r-general', sender: 'u-alice', text: `psst ${overheard}` })
      await lab.door.idle()
      want(p, !lab.model.heard(overheard), 'an overheard line reached the model on its own')
      want(p, lab.fake.ledger.length === 0, 'an overheard line was answered')
      ask(lab, `now ${asked}`)
      await lab.door.idle()
      const turn = lab.model.requests.find((r) => r.body.includes(asked))
      want(p, turn?.body.includes(overheard) === true, 'the overheard line was not in the next turn')
      want(p, lab.fake.ledger.length === 1, `expected 1 post, got ${lab.fake.ledger.length}`)
      return p
    },
  },
  {
    id: 'C3', title: 'a dropped message never reaches the model',
    async run(lab) {
      const p: Outcome = []
      const canary = lab.canary('c3')
      ask(lab, `hello ${canary}`, 'u-mallory')
      await lab.door.idle()
      await new Promise((resolve) => setTimeout(resolve, 60))
      want(p, !lab.model.heard(canary), 'a dropped message reached the model')
      want(p, lab.fake.ledger.length === 0, 'a dropped message was answered')
      want(p, lab.receipts.all()[0]?.rule === 'adm.users', 'no drop receipt')
      want(p, violations(lab) === 0, `${violations(lab)} protocol violations`)
      return p
    },
  },
  {
    id: 'C4', title: 'a tool the harness was offered, then denied, does not run',
    lab: { policy: { 'tools.allow': ['shell'] } },
    async run(lab) {
      const p: Outcome = []
      // The turn starts with shell allowed, so the harness is offered the tool.
      // The policy is tightened while the model is thinking, just before it asks
      // for the tool. Only the verdict stands between the call and the run.
      const tighten = (): void => lab.door.setPolicy(lab.policy({ version: 2, 'tools.allow': ['file_read'] }))
      const { canary, file } = touchScript(lab, 'c4', tighten)
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the turn never reached the model')
      want(p, !existsSync(file), 'the denied tool ran')
      const tool = toolReceipts(lab)[0]
      want(p, tool?.verdict === 'deny' && tool.rule === 'tools.lists', 'no deny receipt for the tool')
      return p
    },
  },
  {
    id: 'C4a', title: 'a tool the policy never allowed is not offered to the harness and does not run',
    lab: { policy: { 'tools.allow': ['file_read'] } },
    async run(lab) {
      const p: Outcome = []
      const { canary, file } = touchScript(lab, 'c4a')
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the turn never reached the model')
      want(p, !existsSync(file), 'a tool that was never allowed ran')
      want(p, toolReceipts(lab).length === 0, 'the harness asked to run a tool it should never have been offered')
      return p
    },
  },
  {
    id: 'C4+', title: 'positive control: an allowed tool does run',
    lab: { policy: { 'tools.allow': ['shell'] } },
    async run(lab) {
      const p: Outcome = []
      const { canary, file } = touchScript(lab, 'c4plus')
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, existsSync(file), 'the allowed tool did not run, so C4 and C5 prove nothing')
      want(p, lab.fake.ledger.length === 1 && stamped(lab), 'no reply after the tool')
      return p
    },
  },
  {
    id: 'C5', title: 'no verdict means no run',
    lab: { policy: { 'tools.allow': ['shell'] }, silentVerdicts: true },
    async run(lab) {
      const p: Outcome = []
      const { canary, file } = touchScript(lab, 'c5')
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the turn never reached the model')
      want(p, !existsSync(file), 'the tool ran with no verdict')
      return p
    },
  },
  {
    id: 'C5v', title: 'the veto inside the cell says no on its own when nobody answers it',
    // The door stays silent and the shim is told to wait far longer than the
    // in-cell veto does. So the only thing that can stop the tool is the veto
    // giving up by itself. (In C5 the shim gives up first and sends a plain no.)
    lab: { policy: { 'tools.allow': ['shell'] }, silentVerdicts: true, verdictTimeoutMs: 7000, vetoTimeoutMs: 300 },
    async run(lab) {
      const p: Outcome = []
      const { canary, file } = touchScript(lab, 'c5v')
      const started = Date.now()
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(canary), 'the turn never reached the model')
      want(p, !existsSync(file), 'the tool ran with no verdict')
      want(p, Date.now() - started < 5000, 'the turn only ended when the shim gave up, so the in-cell veto was not what stopped the tool')
      want(p, lab.fake.ledger.length === 1 && stamped(lab), 'no reply after the blocked tool')
      return p
    },
  },
  {
    id: 'C8p', title: 'no real secret is readable from a tool, and the key swap happened (process level)',
    lab: { policy: { 'tools.allow': ['shell'] } },
    async run(lab) {
      const p: Outcome = []
      const canary = lab.canary('c8')
      const dump = lab.file('env.dump')
      lab.script({ match: canary, tool: lab.harness.shell.dumpEnv(dump), text: 'done' })
      ask(lab, `run ${canary}`)
      await lab.door.idle()
      want(p, existsSync(dump), 'the env dump tool did not run, so nothing was checked')
      const env = existsSync(dump) ? readFileSync(dump, 'utf8') : ''
      for (const [name, secret] of Object.entries(lab.secrets)) {
        want(p, !env.includes(secret), `the ${name} secret is in the harness environment`)
        want(p, !lab.model.requests.some((r) => r.body.includes(secret)), `the ${name} secret reached the model`)
        want(p, !lab.fake.ledger.some((post) => post.text.includes(secret)), `the ${name} secret was posted`)
      }
      // The harness gets a hand-listed environment, not the shim's. The lab
      // planted a variable in this process before the shim started; a harness
      // that inherited its environment would have it.
      const host = lab.hostCanary
      want(p, process.env[host.name] === host.value, 'the host canary is not set in this process, so inheritance was not tested')
      want(p, !env.includes(host.name) && !env.includes(host.value), 'the harness inherited the environment of the process that started it')
      want(p, lab.model.requests.length > 0 && lab.model.requests.every((r) => r.authorization === `Bearer ${lab.secrets.upstream}`), 'the model did not see the real key')
      want(p, lab.route.presented.length === lab.model.requests.length, 'a model call bypassed the route')
      return p
    },
  },
  {
    id: 'C12', title: 'usage is counted, and the turn after the budget is spent is refused',
    lab: { policy: { budget: { monthlyUsd: 2, onExceed: 'refuse' } } },
    async run(lab) {
      const p: Outcome = []
      const [a, b, c] = ['c12-a', 'c12-b', 'c12-c'].map((n) => lab.canary(n))
      for (const canary of [a, b, c]) {
        ask(lab, `count ${canary}`)
        await lab.door.idle()
      }
      want(p, lab.model.heard(a) && lab.model.heard(b), 'a turn inside the budget did not reach the model')
      want(p, !lab.model.heard(c), 'a turn after the budget was spent reached the model')
      const m = lab.route.meter()
      want(p, m.requests === 2 && m.inTokens === 200 && m.outTokens === 40 && m.usd === 2, `meter is off: ${JSON.stringify(m)}`)
      want(p, lab.receipts.all().some((r) => r.rule === 'budget.cap' && r.verdict === 'deny'), 'no budget refusal receipt')
      want(p, lab.fake.ledger.length === 2, `expected 2 posts, got ${lab.fake.ledger.length}`)
      return p
    },
  },
  {
    id: 'C15', title: 'a policy change takes effect on the next message with no restart',
    async run(lab) {
      const p: Outcome = []
      const [before, after] = [lab.canary('c15-before'), lab.canary('c15-after')]
      ask(lab, `one ${before}`)
      await lab.door.idle()
      const hash = lab.door.heartbeat().policyHash
      lab.door.setPolicy(lab.policy({ version: 2, [F + 'rooms']: [{ match: { room: 'r-lounge' }, mode: 'free' }] }))
      ask(lab, `two ${after}`)
      await lab.door.idle()
      want(p, lab.model.heard(before), 'the first turn did not reach the model')
      want(p, !lab.model.heard(after), 'a message to a closed room reached the model')
      want(p, lab.fake.ledger.length === 1, `expected 1 post, got ${lab.fake.ledger.length}`)
      want(p, lab.door.heartbeat().policyHash !== hash, 'the heartbeat hash did not change')
      want(p, lab.door.heartbeat().caps?.harness === lab.harness.caps.harness, 'the heartbeat does not name the harness')
      return p
    },
  },
  {
    id: 'C15t', title: 'the tools a turn may use follow the policy as it is at that turn, in a session that is already running',
    lab: { policy: { 'tools.allow': ['file_read'] } },
    async run(lab) {
      const p: Outcome = []
      // Turn 1: the session starts with no shell.
      const first = lab.canary('c15t-first')
      ask(lab, `remember ${first}`)
      await lab.door.idle()
      // Turn 2: the policy now allows shell. The same session must be able to use it.
      lab.door.setPolicy(lab.policy({ version: 2, 'tools.allow': ['file_read', 'shell'] }))
      const added = touchScript(lab, 'c15t-added')
      ask(lab, `run ${added.canary}`)
      await lab.door.idle()
      want(p, existsSync(added.file), 'a tool the policy added was not usable on the next turn')
      want(p, lab.model.requests.some((r) => r.body.includes(added.canary) && r.body.includes(first)),
        'the session lost its conversation when its tools changed')
      const allowed = toolReceipts(lab).length
      want(p, allowed >= 1, 'no receipt for the added tool')
      // Turn 3: shell is taken away again. It must not even be offered.
      lab.door.setPolicy(lab.policy({ version: 3, 'tools.allow': ['file_read'] }))
      const removed = touchScript(lab, 'c15t-removed')
      ask(lab, `run ${removed.canary}`)
      await lab.door.idle()
      want(p, lab.model.heard(removed.canary), 'the third turn never reached the model')
      want(p, !existsSync(removed.file), 'a tool the policy removed still ran')
      want(p, toolReceipts(lab).length === allowed, 'a tool the policy removed was still offered: the harness asked to run it')
      want(p, lab.fake.ledger.length === 3, `expected 3 posts, got ${lab.fake.ledger.length}`)
      return p
    },
  },
]

/** Run checks (all, or the ids given) against one shim of one harness. */
export async function runChecks(base: LabOptions, ids?: string[]): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of CHECKS.filter((c) => !ids || ids.includes(c.id))) {
    let problems: Outcome
    let lab: Lab | undefined
    try {
      lab = await startLab({ ...base, ...check.lab, policy: { ...base.policy, ...check.lab?.policy } })
      problems = await check.run(lab)
    } catch (err) {
      problems = [`check threw: ${(err as Error).message}`]
    } finally {
      await lab?.close()
    }
    results.push({ id: check.id, title: check.title, pass: problems.length === 0, detail: problems.join('; ') || 'ok' })
  }
  return results
}
