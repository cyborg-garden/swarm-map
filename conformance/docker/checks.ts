// The checks that need a real cell: C8, C9 and C10. They run inside the
// sidecar's container, like every other check, and reach the cell only
// through the harness: the scripted model asks for a shell tool, and that
// tool runs the lab's probe inside the cell. So what they show is what a
// tool run by the harness can reach and read.
//
// What the probe says is one half. The other half is seen from outside the
// rig, by whoever started it: the sink's own log, and a listener on the
// machine itself. Both must agree.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Check } from '../suites/checks.ts'
import type { Lab } from '../suites/lab.ts'
import { SWARM_ROOT } from './compose.ts'
import { netProblems, parseReport, secretProblems, type ProbeReport } from './report.ts'

type Outcome = string[]
const want = (problems: Outcome, ok: boolean, what: string): void => { if (!ok) problems.push(what) }
const SHELL = { 'tools.allow': ['shell'] }
// The probe walks the whole disk and waits out every dead address, so its turn is a long one.
const SLOW = { turnDeadlineMs: 90_000 }

/** Script the model to have the harness run the probe in the cell. `before` runs just before it asks. */
function probeScript(lab: Lab, name: string, before?: () => void): { canary: string; out: string } {
  const canary = lab.canary(name)
  const out = lab.file(`${name}.probe.json`)
  const command = [
    'node', `${SWARM_ROOT}/conformance/docker/probe.ts`, `nonce=${lab.nonce}`,
    `sink=${process.env.SMLAB_SINK_IP ?? ''}`, `hostip=${process.env.SMLAB_HOST_IP ?? ''}`, `hostport=${process.env.SMLAB_HOST_PORT ?? ''}`, `out=${out}`,
  ].join(' ')
  lab.script({ match: canary, tool: lab.harness.shell.exec(command), text: 'done', before })
  return { canary, out }
}
const readProbe = (file: string): ProbeReport | undefined => (existsSync(file) ? parseReport(readFileSync(file, 'utf8')) : undefined)
const ask = (lab: Lab, text: string): string => lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text })
const stamped = (lab: Lab): boolean => lab.fake.ledger.every((p) => p.text.includes(`FAKE-MODEL-${lab.nonce}`))

/** Files under `dir` that hold any of `secrets`. This is the sidecar reading the cell's folder from its own side. */
function filesHolding(dir: string, secrets: string[]): string[] {
  const found: string[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name)
      const stat = lstatSync(file)
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile() && secrets.some((s) => readFileSync(file).includes(s))) found.push(file)
    }
  }
  walk(dir)
  return found
}

export const DOCKER_CHECKS: Check[] = [
  {
    id: 'C8', title: 'no real secret is readable anywhere in the cell: not from the environment, another process or the disk',
    lab: { policy: SHELL, ...SLOW },
    async run(lab) {
      const p: Outcome = []
      // The probe is a tool run by the harness, so its own environment is a tool's environment.
      const probe = probeScript(lab, 'c8')
      ask(lab, `run ${probe.canary}`)
      await lab.door.idle()

      const report = readProbe(probe.out)
      want(p, report !== undefined, 'the probe did not run in the cell, so nothing was checked')
      if (report) p.push(...secretProblems(report))
      // The cell token is left out on purpose: the shim in the cell holds it, so the cell can read it.
      const real = { upstream: lab.secrets.upstream, chat: lab.secrets.chat }
      for (const [name, secret] of Object.entries(real)) {
        want(p, !lab.model.requests.some((r) => r.body.includes(secret)), `the ${name} secret reached the model`)
        want(p, !lab.fake.ledger.some((post) => post.text.includes(secret)), `the ${name} secret was posted`)
      }
      for (const file of filesHolding(lab.dir, Object.values(real))) p.push(`a secret of this run is in the cell's folder at ${file}`)
      // And the swap happened: the cell only ever presented the placeholder, the model only ever saw the key.
      want(p, lab.model.requests.length >= 2 && lab.model.requests.every((r) => r.authorization === `Bearer ${lab.secrets.upstream}`), 'the model did not see the real key on every call')
      want(p, lab.route.presented.length === lab.model.requests.length, 'a model call did not come through the route')
      want(p, lab.route.refused === 0, 'the cell presented something other than its placeholder')
      return p
    },
  },
  {
    id: 'C9', title: 'nothing leaves the cell except through the sidecar',
    lab: { policy: SHELL, ...SLOW },
    async run(lab) {
      const p: Outcome = []
      const probe = probeScript(lab, 'c9')
      ask(lab, `run ${probe.canary}`)
      await lab.door.idle()
      const report = readProbe(probe.out)
      want(p, report !== undefined, 'the probe did not run in the cell, so nothing was checked')
      if (report) p.push(...netProblems(report))
      want(p, lab.fake.ledger.length === 1 && stamped(lab), 'the turn did not end with one reply from the model')
      return p
    },
  },
  {
    // Run in a cell whose gate lets every tool run without asking. The policy
    // says no to the tool, and it runs anyway: that is the point. What is
    // checked is what the wall alone still holds.
    id: 'C10', title: 'with the gate removed, a tool the policy denies does run, and still nothing leaves and no secret is readable',
    lab: { policy: SHELL, ...SLOW },
    async run(lab) {
      const p: Outcome = []
      want(p, process.env.SMLAB_GATE === 'allows-all', 'this cell still has its gate, so the wall was not tested on its own')
      const tighten = (): void => lab.door.setPolicy(lab.policy({ version: 2, 'tools.allow': ['file_read'] }))
      const probe = probeScript(lab, 'c10', tighten)
      ask(lab, `run ${probe.canary}`)
      await lab.door.idle()
      want(p, !lab.door.policy().tools.allow.includes('shell'), 'the policy still allowed the tool, so nothing was denied')
      const report = readProbe(probe.out)
      want(p, report !== undefined, 'the denied tool did not run, so the gate was not removed and the wall was not tested on its own')
      if (report) p.push(...netProblems(report), ...secretProblems(report))
      // Whatever ran in there, the only thing that was posted came from the model, through the door.
      want(p, lab.fake.ledger.length === 1 && stamped(lab), `expected 1 post from the model, got ${lab.fake.ledger.length}`)
      const violations = lab.receipts.all().filter((r) => r.rule === 'turn.known' || r.rule === 'turn.one-reply').length
      want(p, violations === 0, `${violations} protocol violations`)
      for (const secret of [lab.secrets.upstream, lab.secrets.chat]) {
        want(p, !lab.fake.ledger.some((post) => post.text.includes(secret)), 'a secret of this run was posted')
      }
      return p
    },
  },
]
