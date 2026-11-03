import { NextResponse } from 'next/server'
import {
  getFleetIntegritySnapshot,
  getIntegrityForHarness,
  getWriteFailureSignal,
  runFleetIntegritySweep,
} from '@/lib/services/integrity'
import { sweepTargets } from '@/lib/services/integrity-scheduler'
import { checkGithubCredentials } from '@/lib/services/github-credential-check'

// Fleet DB health view (#204, PR1): cached quick_check results from the
// scheduled sweep + a per-harness write-failure signal from errors.log.
function fleetView() {
  const snapshot = getFleetIntegritySnapshot()
  const targets = sweepTargets()
  const harnesses = targets.map((t) => ({
    harnessId: t.harnessId,
    name: t.name,
    // null until the first sweep has covered this harness.
    integrity: getIntegrityForHarness(t.harnessId),
    writeFailures: getWriteFailureSignal(t.harnessId),
  }))
  return {
    lastSweepAt: snapshot.lastSweepAt,
    sweepInProgress: snapshot.sweepInProgress,
    harnesses,
    // Read fresh: a credential coming back should show on the next poll.
    githubCredentials: checkGithubCredentials({ agents: targets.map((t) => ({ name: t.name, dataDir: t.dataDir, composeFile: t.composeFile })) }),
  }
}

// GET /api/integrity → cached fleet snapshot
export async function GET() {
  try {
    return NextResponse.json(fleetView())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'integrity snapshot failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/integrity → run a sweep now, return the fresh snapshot
export async function POST() {
  try {
    await runFleetIntegritySweep(sweepTargets())
    return NextResponse.json(fleetView())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'integrity sweep failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
