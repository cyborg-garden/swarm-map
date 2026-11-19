// What runs in an OpenCode cell container: the ACP shim, which starts
// OpenCode. It is handed a nonce, a cell token and two timeouts, and nothing
// else. It refuses to start if its environment holds anything shaped like a
// real credential.
// A run against a real model also hands it the model's name (SMLAB_MODEL) and
// what the harness is to be told it is (SMLAB_SYSTEM_PROMPT). Neither is a secret.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { openCodeSystemPromptProblem, startOpenCodeShim, type OpenCodeShimOptions } from '../../../lib/runtimes/opencode/shim.ts'
import { assertNoCredentials } from '../../guards/preflight.ts'
import { BRAIN_PORT, LAB_DIR, ROUTE_PORT, SWARM_ROOT } from '../compose.ts'

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

const model = process.env.SMLAB_MODEL || undefined
if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) { console.error('cell: SMLAB_MODEL is not a model name'); process.exit(2) }

const systemPrompt = process.env.SMLAB_SYSTEM_PROMPT || undefined
const promptProblem = systemPrompt === undefined ? undefined : openCodeSystemPromptProblem(systemPrompt)
if (promptProblem) { console.error(`cell: ${promptProblem}`); process.exit(2) }

const dirs = { home: path.join(LAB_DIR, 'home'), work: path.join(LAB_DIR, 'work') }
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

const bin = '/usr/local/bin/opencode'
// "The gate removed", for this harness: its permission rules set to allow, so it asks nobody.
const command = process.env.SMLAB_GATE === 'allows-all'
  ? [process.execPath, `${SWARM_ROOT}/conformance/broken/opencode-wrapped.ts`, 'allows-all', '1', bin]
  : [bin]
const options: OpenCodeShimOptions = {
  host: 'door', port: BRAIN_PORT, token: process.env.SWARMLAB_BRAIN ?? '',
  command, homeDir: dirs.home, workDir: dirs.work, startMs: 60_000, model, systemPrompt,
  // The harness is pointed at the door's model route and given a placeholder, never a key.
  modelBaseUrl: `http://door:${ROUTE_PORT}/v1`, placeholder: `PLACEHOLDER-${nonce}`,
  verdictTimeoutMs: Number(process.env.SMLAB_VERDICT_MS) || 400,
  vetoTimeoutMs: Number(process.env.SMLAB_VETO_MS) || 2000,
  onBreach: (why) => console.error(`cell: ${why}`),
}

// The door container starts at the same moment, so the first dials may be too early.
const deadline = Date.now() + 30_000
for (;;) {
  try {
    await startOpenCodeShim(options)
    console.log('CELL-UP')
    break
  } catch (err) {
    if (Date.now() > deadline) { console.error(`cell: could not reach the door: ${(err as Error).message}`); process.exit(1) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
process.on('SIGTERM', () => process.exit(0))
