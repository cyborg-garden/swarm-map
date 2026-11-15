// What happened to the restart that follows a save.
//
// A key or model change only takes effect once the agent's container is
// restarted. The save and the restart are two steps, and the second can fail
// while the first succeeded. These helpers carry that result from the server
// to the operator so the UI never reports "restarting" for a restart that
// did not start.

export type RestartOutcome = { harnessId: string; ok: boolean; error?: string }

/** Server side: restart each agent, recording the result instead of dropping it. */
export function restartEach<M extends string>(
  harnessIds: Iterable<string>,
  mode: M,
  restart: (harnessId: string, mode: M) => void,
): RestartOutcome[] {
  const outcomes: RestartOutcome[] = []
  for (const harnessId of harnessIds) {
    try {
      restart(harnessId, mode)
      outcomes.push({ harnessId, ok: true })
    } catch (err) {
      outcomes.push({ harnessId, ok: false, error: err instanceof Error ? err.message : 'Restart failed' })
    }
  }
  return outcomes
}

/** Client side: the failed restarts in a response body's `restarts` field. */
export function failedRestarts(body: unknown): RestartOutcome[] {
  const restarts = (body as { restarts?: unknown } | null)?.restarts
  if (!Array.isArray(restarts)) return []
  return restarts.filter(
    (r): r is RestartOutcome => !!r && typeof r === 'object' && typeof r.harnessId === 'string' && r.ok === false,
  )
}

/**
 * The warning to show when a save went through but a restart did not, or null
 * when every restart started. `saved` names what was saved, e.g. "Key saved".
 */
export function restartFailureMessage(
  saved: string,
  failed: RestartOutcome[],
  nameOf: (harnessId: string) => string = (id) => id,
): string | null {
  if (failed.length === 0) return null
  const reason = failed[0].error ?? 'Restart failed'
  if (failed.length === 1) {
    return `${saved}, but the restart of ${nameOf(failed[0].harnessId)} failed: ${reason}. Restart it to apply the change.`
  }
  const names = failed.map((f) => nameOf(f.harnessId)).join(', ')
  return `${saved}, but ${failed.length} restarts failed (${names}): ${reason}. Restart them to apply the change.`
}

/**
 * Client side: ask for a restart and report whether it started. A 409 means a
 * restart of this agent is already under way, which is what the caller wanted.
 */
export async function requestRestart(
  harnessId: string,
  mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/harnesses/${harnessId}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    if (res.ok || res.status === 409) return { ok: true }
    const body = await res.json().catch(() => null)
    return { ok: false, error: (body as { error?: string } | null)?.error ?? `Restart failed (${res.status})` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}
