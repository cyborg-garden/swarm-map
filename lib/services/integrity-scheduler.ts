/**
 * Server-side scheduler for the fleet integrity sweep (#204, PR1).
 *
 * HSM has no job runner — the UI polls, and the server is a single always-on
 * pm2 fork — so a plain setInterval registered from instrumentation.ts is the
 * whole scheduler. Timers are unref'd so they never hold the process open.
 */

import { services } from '@/lib/services'
import { runFleetIntegritySweep, sweepTargetFor, type SweepTarget } from './integrity'
import { checkGithubCredentials } from './github-credential-check'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const INITIAL_DELAY_MS = 30 * 1000 // let the server finish booting first

/** Current container harnesses as sweep targets (Letta rows have no state.db). */
export function sweepTargets(): SweepTarget[] {
  return services.harness
    .list()
    .filter((h) => h.runtime !== 'letta' && h.runtime !== 'letta-server')
    .map((h) => sweepTargetFor(h.id, h.name, h.runtime))
}

export async function runScheduledSweep(): Promise<void> {
  try {
    const targets = sweepTargets()
    const github = checkGithubCredentials({ agents: targets.map((t) => ({ name: t.name, dataDir: t.dataDir })) })
    if (github.status !== 'ok') console.error(`[github-credentials] ${github.message}`)
    await runFleetIntegritySweep(targets)
  } catch (err) {
    // A failed sweep must never take the server down; stale cache beats a crash.
    console.error('[integrity] fleet sweep failed:', err)
  }
}

// Survives dev/HMR module re-evaluation — the flag lives on globalThis, not
// in module scope, so a re-imported module can't double-register timers.
declare global {
  var __hsmIntegritySchedulerStarted: boolean | undefined
}

export function startIntegrityScheduler(): void {
  if (globalThis.__hsmIntegritySchedulerStarted) return
  globalThis.__hsmIntegritySchedulerStarted = true

  const envInterval = parseInt(process.env.INTEGRITY_SWEEP_INTERVAL_MS ?? '', 10)
  const intervalMs = Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS

  const initial = setTimeout(() => void runScheduledSweep(), INITIAL_DELAY_MS)
  initial.unref?.()
  const recurring = setInterval(() => void runScheduledSweep(), intervalMs)
  recurring.unref?.()
}
