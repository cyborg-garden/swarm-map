/**
 * Shared chart vocabulary. Every colour is a CSS variable reference so the
 * rendered SVG/HTML carries `var(--chart-N)` and next-themes' `.dark` scope
 * can re-step it — an inline hex emitted at render time would be immune to
 * dark mode (see the dark-mode skill).
 *
 * The eight categorical slots are defined in app/globals.css (light + dark),
 * validated with the dataviz palette checker. They are assigned in FIXED
 * order and never cycled: a series past the eighth folds into "Other".
 */
export const SERIES_TOKENS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
] as const

export const MAX_SERIES = SERIES_TOKENS.length
export const OTHER_KEY = 'Other'

/** Non-data ink: grid, axis, labels. Text never wears a series colour. */
export const CHART_INK = {
  grid: 'var(--border)',
  axisText: 'var(--text-secondary)',
  surface: 'var(--surface)',
} as const

export function seriesColor(index: number): string {
  return SERIES_TOKENS[Math.min(index, MAX_SERIES - 1)]
}

/**
 * Pick which keys get their own slot. Order is alphabetical (deterministic,
 * so an entity keeps its colour as the date range changes); when there are
 * more keys than slots, the largest `MAX_SERIES - 1` by total are kept and
 * the remainder becomes "Other" in the last slot.
 */
export function foldKeys(totals: Record<string, number>): { keys: string[]; fold: (key: string) => string } {
  const all = Object.keys(totals).filter((k) => totals[k] > 0)
  if (all.length <= MAX_SERIES) {
    const keys = [...all].sort()
    return { keys, fold: (k) => k }
  }
  const kept = new Set(
    [...all].sort((a, b) => totals[b] - totals[a] || a.localeCompare(b)).slice(0, MAX_SERIES - 1),
  )
  const keys = [...kept].sort()
  keys.push(OTHER_KEY)
  return { keys, fold: (k) => (kept.has(k) ? k : OTHER_KEY) }
}

export function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(n / 1_000)}K`
  return Number.isInteger(n) ? String(n) : trim(n)
}

function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.005) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/** "Nice" axis ticks: 0..max in `count` steps, rounded to 1/2/5 × 10^k. */
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0]
  const rough = max / count
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)))
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)))
  return ticks
}

/** Indices of x labels to draw so ~`target` labels fit without colliding. */
export function thinIndices(n: number, target = 8): number[] {
  if (n <= target) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil(n / target)
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(i)
  return out
}
