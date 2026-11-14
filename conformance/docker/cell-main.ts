// What runs in the cell container: the shim, which starts the harness. It is
// handed a nonce, a cell token and two timeouts, and nothing else. It refuses
// to start if its environment holds anything shaped like a real credential.
// A run against a real model also hands it the model's name (SMLAB_MODEL).
//
// The cell token is in this container's environment, so anything in the cell
// can read it. That is as designed: the whole cell is the untrusted side, and
// the token only proves "this is that cell" to its own door.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { startPiShim, type PiShimOptions } from '../../lib/runtimes/pi/shim.ts'
import { assertNoCredentials } from '../guards/preflight.ts'
import { BRAIN_PORT, LAB_DIR, ROUTE_PORT, SWARM_ROOT } from './compose.ts'

const nonce = process.env.SWARMLAB_NONCE ?? ''
try {
  // PWD and OLDPWD are the shell's "where am I", which the guard's name list would take for
  // a password. Their values are still checked, under a name it has no opinion about.
  const { PWD, OLDPWD, ...rest } = process.env
  assertNoCredentials({ ...rest, WORKING_DIR: PWD, WORKING_DIR_BEFORE: OLDPWD }, { nonce })
} catch (err) {
  console.error((err as Error).message)
  process.exit(2)
}

// The model the harness asks for. A name, never a key. The lab's own runs leave it unset.
const model = process.env.SMLAB_MODEL || 'scripted'
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) { console.error('cell: SMLAB_MODEL is not a model name'); process.exit(2) }

const dirs = { agent: path.join(LAB_DIR, 'agent'), sessions: path.join(LAB_DIR, 'sessions'), work: path.join(LAB_DIR, 'work'), home: path.join(LAB_DIR, 'home') }
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
// The harness is pointed at the door's model route and given a placeholder, never a key.
writeFileSync(path.join(dirs.agent, 'models.json'), JSON.stringify({
  providers: { swarm: { baseUrl: `http://door:${ROUTE_PORT}/v1`, api: 'openai-completions', apiKey: `PLACEHOLDER-${nonce}`, models: [{ id: model }] } },
}))

const gate = process.env.SMLAB_GATE === 'allows-all'
  ? `${SWARM_ROOT}/conformance/broken/gate-allows-all.ts`
  : `${SWARM_ROOT}/lib/runtimes/pi/cell/gate.ts`
const options: PiShimOptions = {
  host: 'door', port: BRAIN_PORT, token: process.env.SWARMLAB_BRAIN ?? '',
  piCommand: ['/usr/local/bin/pi'], agentDir: dirs.agent, sessionsDir: dirs.sessions, workDir: dirs.work, homeDir: dirs.home,
  gate: { path: gate }, gateReadyMs: 20_000, model,
  verdictTimeoutMs: Number(process.env.SMLAB_VERDICT_MS) || 400,
  gateTimeoutMs: Number(process.env.SMLAB_VETO_MS) || 2000,
}

// The door container starts at the same moment, so the first dials may be too early.
const deadline = Date.now() + 30_000
for (;;) {
  try {
    await startPiShim(options)
    console.log('CELL-UP')
    break
  } catch (err) {
    if (Date.now() > deadline) { console.error(`cell: could not reach the door: ${(err as Error).message}`); process.exit(1) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
process.on('SIGTERM', () => process.exit(0))
