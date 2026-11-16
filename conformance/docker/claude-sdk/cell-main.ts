// What runs in a Claude Agent SDK cell container: the shim, which starts the
// SDK. It is handed a nonce, a cell token and two timeouts, and nothing
// else. It refuses to start if its environment holds anything shaped like a
// real credential.
//
// The cell token is in this container's environment, so anything in the cell
// can read it. That is as designed: the whole cell is the untrusted side, and
// the token only proves "this is that cell" to its own door.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadClaudeSdk } from '../../../lib/runtimes/claude-sdk/load.ts'
import { startClaudeSdkShim, type ClaudeSdkShimOptions } from '../../../lib/runtimes/claude-sdk/shim.ts'
import { wrappedSdk } from '../../broken/claude-sdk-wrapped.ts'
import { assertNoCredentials } from '../../guards/preflight.ts'
import { BRAIN_PORT, LAB_DIR, ROUTE_PORT } from '../compose.ts'

/** Where the image holds the pinned SDK. See the Dockerfile, stage `cell-claude-sdk`. */
export const CLAUDE_SDK_DIR = '/opt/claude-sdk'

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

const dirs = { home: path.join(LAB_DIR, 'home'), work: path.join(LAB_DIR, 'work') }
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

const real = await loadClaudeSdk(CLAUDE_SDK_DIR)
const options: ClaudeSdkShimOptions = {
  host: 'door', port: BRAIN_PORT, token: process.env.SWARMLAB_BRAIN ?? '',
  // "The gate removed", for this harness: every session started in the mode where it asks nobody.
  sdk: process.env.SMLAB_GATE === 'allows-all' ? wrappedSdk(real, 'unrestricted') : real,
  homeDir: dirs.home, workDir: dirs.work, startMs: 60_000,
  // The SDK is pointed at the door's model route and given a placeholder, never a key.
  modelBaseUrl: `http://door:${ROUTE_PORT}/v1`, placeholder: `PLACEHOLDER-${nonce}`,
  verdictTimeoutMs: Number(process.env.SMLAB_VERDICT_MS) || 400,
  vetoTimeoutMs: Number(process.env.SMLAB_VETO_MS) || 2000,
}

// The door container starts at the same moment, so the first dials may be too early.
const deadline = Date.now() + 30_000
for (;;) {
  try {
    await startClaudeSdkShim(options)
    console.log('CELL-UP')
    break
  } catch (err) {
    if (Date.now() > deadline) { console.error(`cell: could not reach the door: ${(err as Error).message}`); process.exit(1) }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
process.on('SIGTERM', () => process.exit(0))
