// What runs in the door container: the sidecar's side of one rig. It starts a
// lab that listens for the cell, runs the one check it was told to run, and
// prints the result as a line the rig reads from outside. With `hold` it
// starts the lab and waits, so the rig can probe the containers from outside.
import { OPENAI_CHAT } from '../../lib/door/model-shapes.ts'
import { LETTA_CODE_CHECKS, lettaCodeHarness } from '../harnesses/letta-code.ts'
import { piHarness } from '../harnesses/pi.ts'
import { CHECKS, runChecks } from '../suites/checks.ts'
import type { HarnessUnderTest } from '../suites/harness.ts'
import { startLab, type RemoteCell } from '../suites/lab.ts'
import { DOCKER_CHECKS } from './checks.ts'
import { BRAIN_PORT, LAB_DIR, ROUTE_PORT } from './compose.ts'

const remote: RemoteCell = {
  nonce: process.env.SWARMLAB_NONCE ?? '', brainToken: process.env.SWARMLAB_BRAIN ?? '',
  dir: LAB_DIR, advertise: 'door', brainPort: BRAIN_PORT, routePort: ROUTE_PORT,
}

// The harness as this side sees it: it is in another container and starts
// itself. Nothing is started from here and no environment is handed over from
// here; the rig did that, and checked it, before the containers came up.
const second = process.env.SMLAB_HARNESS === 'letta-code'
const local = second ? lettaCodeHarness(['/usr/local/bin/letta'], 'real') : piHarness(['/usr/local/bin/pi'], 'real')
// A harness that takes seconds to start needs longer than the lab's default before a turn is given up on.
const base = second ? { turnDeadlineMs: 60_000 } : {}
const harness: HarnessUnderTest = {
  ...local, modelShape: OPENAI_CHAT,
  cellEnv: () => ({}),
  start: async () => ({ close() {} }),
  // There is no tripwire in a cell: the wall is what is being tested, and the sink is what watches.
  tripwire: () => ({ armed: 0, attempts: [] }),
  broken: {},
}

process.on('SIGTERM', () => process.exit(0))
const check = process.env.SMLAB_CHECK ?? ''
if (check === 'hold') {
  await startLab({ ...base, harness, shim: 'good', remote, policy: { 'tools.allow': ['shell'] } })
  console.log('SMLAB-READY')
  setInterval(() => {}, 60_000)
} else {
  const [result] = await runChecks({ ...base, harness, shim: 'good', remote }, [check], [...CHECKS, ...DOCKER_CHECKS, ...(second ? LETTA_CODE_CHECKS : [])])
  console.log(`SMLAB-RESULT ${JSON.stringify(result ?? { id: check, title: check, pass: false, detail: 'no such check' })}`)
  process.exit(0)
}
