// Fleet code-drift chip + banner.
//
// Types are structural mirrors of /api/fleet/drift's payload — this is a client
// component and must not import lib/services/drift.ts, which pulls in
// child_process. Same arrangement as db-health-badge.
//
// THE ONE RULE: only `current` and not hot-patched is green. `unknown-*` is
// never drawn like `current`. An agent nobody can interrogate is exactly the
// agent that ran four-day-old code for days while the dashboard stayed green.
//
// And the chip shows an AGE DELTA, not a boolean. "behind" tells you nothing
// about whether to act; "11 commits / 4d behind" does.

export type DriftState = 'current' | 'behind' | 'unknown-no-provenance' | 'unknown-not-running'

export type DriftSummary = {
  harnessId: string
  name: string
  state: DriftState
  containerSha: string | null
  sourceSha: string | null
  commitsBehind: number | null
  ageBehindMs: number | null
  hotPatched: boolean
  buildSource?: {
    dir: string
    branch: string | null
    upstream: string | null
    behindUpstream: number | null
  } | null
  detail: string | null
}

export type DriftLevel = 'ok' | 'unknown' | 'behind' | 'alert'

const styles: Record<DriftLevel, string> = {
  ok: 'bg-green-500/10 text-green-600',
  // Grey, NOT green. "We could not tell" must not look like "we checked".
  unknown: 'bg-muted text-muted-foreground',
  behind: 'bg-orange-500/10 text-orange-500',
  alert: 'bg-red-500/10 text-red-600',
}

/** How stale is too stale to shrug at. Four days is what the incident cost. */
export const STALE_ALERT_MS = 4 * 24 * 60 * 60 * 1000

export function formatAge(ms: number): string {
  const abs = Math.abs(ms)
  const d = Math.floor(abs / 86_400_000)
  if (d >= 1) return `${d}d`
  const h = Math.floor(abs / 3_600_000)
  if (h >= 1) return `${h}h`
  const m = Math.floor(abs / 60_000)
  return `${m}m`
}

/**
 * The single place that decides whether an agent counts as up to date. Both the
 * chip and the banner go through it, so they can never disagree.
 */
export function isCurrent(d: DriftSummary | null | undefined): boolean {
  return !!d && d.state === 'current' && !d.hotPatched
}

export function driftLevel(d: DriftSummary): DriftLevel {
  // Hot-patched outranks everything: the container's recorded SHA is a lie and
  // the next recreate silently reverts whatever was copied in.
  if (d.hotPatched) return 'alert'
  if (d.state === 'behind') {
    if (d.ageBehindMs != null && d.ageBehindMs >= STALE_ALERT_MS) return 'alert'
    return 'behind'
  }
  if (d.state === 'current') return 'ok'
  return 'unknown'
}

export function driftLabel(d: DriftSummary): string {
  if (d.hotPatched) return 'hot-patched'
  switch (d.state) {
    case 'current':
      return 'up to date'
    case 'behind': {
      const parts: string[] = []
      if (d.commitsBehind != null) {
        parts.push(`${d.commitsBehind} commit${d.commitsBehind === 1 ? '' : 's'}`)
      }
      if (d.ageBehindMs != null && d.ageBehindMs > 0) parts.push(formatAge(d.ageBehindMs))
      // Never collapse to a bare "behind" when we have no numbers — say the
      // delta is unknown rather than implying it is small.
      return parts.length ? `${parts.join(' / ')} behind` : 'behind (delta unknown)'
    }
    case 'unknown-no-provenance':
      return 'build unknown'
    case 'unknown-not-running':
      return 'not running'
  }
}

function tooltip(d: DriftSummary): string {
  const parts: string[] = []
  if (d.containerSha) parts.push(`running ${d.containerSha.slice(0, 12)}`)
  if (d.sourceSha) parts.push(`source HEAD ${d.sourceSha.slice(0, 12)}`)
  if (d.buildSource?.dir) {
    const b = d.buildSource
    const branch = b.branch ? ` @ ${b.branch}` : ''
    parts.push(`build source ${b.dir}${branch}`)
    if (b.behindUpstream != null && b.behindUpstream > 0) {
      parts.push(
        `checkout itself is ${b.behindUpstream} behind ${b.upstream ?? 'upstream'} (as of the last fetch)`,
      )
    }
  }
  if (d.hotPatched) {
    parts.push('files were copied into the container after build — the next recreate reverts them')
  }
  if (d.detail) parts.push(d.detail)
  return parts.join(' · ') || 'no build provenance available'
}

export function DriftChip({ drift }: { drift?: DriftSummary | null }) {
  // No row for this agent at all is itself an unknown — render it, don't hide it.
  const d: DriftSummary = drift ?? {
    harnessId: '',
    name: '',
    state: 'unknown-no-provenance',
    containerSha: null,
    sourceSha: null,
    commitsBehind: null,
    ageBehindMs: null,
    hotPatched: false,
    detail: 'no drift information reported for this agent',
  }
  const level = driftLevel(d)
  return (
    <span
      title={tooltip(d)}
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ${styles[level]}`}
    >
      {driftLabel(d)}
    </span>
  )
}

export function summarizeDrift(agents: DriftSummary[]): {
  total: number
  current: number
  behind: number
  unknown: number
  hotPatched: number
  worst: DriftLevel
} {
  let behind = 0
  let unknown = 0
  let patched = 0
  let worst: DriftLevel = 'ok'
  const rank: Record<DriftLevel, number> = { ok: 0, unknown: 1, behind: 2, alert: 3 }

  for (const a of agents) {
    if (a.hotPatched) patched++
    if (a.state === 'behind') behind++
    else if (a.state !== 'current') unknown++
    const lvl = driftLevel(a)
    if (rank[lvl] > rank[worst]) worst = lvl
  }

  return {
    total: agents.length,
    current: agents.filter(isCurrent).length,
    behind,
    unknown,
    hotPatched: patched,
    worst,
  }
}

const bannerStyles: Record<Exclude<DriftLevel, 'ok'>, string> = {
  unknown: 'border-[var(--border)] bg-muted text-foreground',
  behind: 'border-orange-500/30 bg-orange-500/10 text-orange-600',
  alert: 'border-red-500/30 bg-red-500/10 text-red-600',
}

/**
 * Fleet banner. Shown whenever ANY agent is not provably current — including
 * agents that are merely unknown. Nothing on this host pulls or rebuilds, so
 * "behind" is a standing condition until a human rebuilds that agent; the
 * banner is the thing that makes it impossible to miss.
 */
export function DriftBanner({ agents }: { agents?: DriftSummary[] | null }) {
  if (!agents || agents.length === 0) return null
  const s = summarizeDrift(agents)
  if (s.worst === 'ok') return null

  const bits: string[] = []
  if (s.behind > 0) bits.push(`${s.behind} behind`)
  if (s.hotPatched > 0) bits.push(`${s.hotPatched} hot-patched`)
  if (s.unknown > 0) bits.push(`${s.unknown} with unknown build`)

  return (
    <div
      className={`mb-4 rounded-xl border px-4 py-3 text-sm ${bannerStyles[s.worst as Exclude<DriftLevel, 'ok'>]}`}
      role="status"
    >
      <span className="font-medium">
        {s.current} of {s.total} agents are running current code.
      </span>{' '}
      <span>{bits.join(', ')}. Nothing rebuilds on its own — rebuild each agent to clear this.</span>
    </div>
  )
}
