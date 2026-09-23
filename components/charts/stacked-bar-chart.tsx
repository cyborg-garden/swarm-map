'use client'

import { CHART_INK, foldKeys, formatCompact, niceTicks, seriesColor, thinIndices } from './chart-tokens'

export type StackedBarDatum = { label: string; values: Record<string, number> }

type Props = {
  title: string
  data: StackedBarDatum[]
  valueFormatter?: (n: number) => string
  /** Logical height of the plot area in viewBox units (width is 600, responsive). */
  height?: number
  emptyText?: string
}

const W = 600
const PAD = { top: 8, right: 8, bottom: 22, left: 44 }
const MAX_BAR = 24
const GAP = 2 // surface gap between stacked segments

/** Top segment gets 4px rounded data-ends; everything else is square. */
function segmentPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, w / 2, h) : 0
  if (r === 0) return `M${x},${y}h${w}v${h}h${-w}Z`
  return `M${x},${y + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}h${-w}Z`
}

export function StackedBarChart({ title, data, valueFormatter = formatCompact, height = 160, emptyText = 'No data for this range.' }: Props) {
  const totals: Record<string, number> = {}
  for (const d of data) for (const [k, v] of Object.entries(d.values)) totals[k] = (totals[k] ?? 0) + v
  const { keys, fold } = foldKeys(totals)

  const rows = data.map((d) => {
    const values: Record<string, number> = {}
    for (const [k, v] of Object.entries(d.values)) {
      if (v > 0) values[fold(k)] = (values[fold(k)] ?? 0) + v
    }
    const total = Object.values(values).reduce((s, v) => s + v, 0)
    return { label: d.label, values, total }
  })
  const max = Math.max(0, ...rows.map((r) => r.total))

  if (keys.length === 0 || max === 0) {
    return (
      <figure>
        <figcaption className="text-xs text-muted-foreground mb-1">{title}</figcaption>
        <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
      </figure>
    )
  }

  const H = height + PAD.top + PAD.bottom
  const plotW = W - PAD.left - PAD.right
  const slot = plotW / rows.length
  const barW = Math.min(MAX_BAR, slot * 0.7)
  const ticks = niceTicks(max)
  const yMax = ticks[ticks.length - 1]
  const y = (v: number) => PAD.top + height - (v / yMax) * height
  const xLabels = new Set(thinIndices(rows.length))
  const colorOf = (k: string) => seriesColor(keys.indexOf(k))

  return (
    <figure>
      <figcaption className="text-xs text-muted-foreground mb-1">{title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: stacked bars per day, ${keys.length} series`}
        className="w-full h-auto"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <desc>{`${title}. ${rows.length} days. Series: ${keys.join(', ')}.`}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={CHART_INK.grid} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={CHART_INK.axisText}>
              {valueFormatter(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2
          let acc = 0
          const present = keys.filter((k) => (r.values[k] ?? 0) > 0)
          return (
            <g key={r.label}>
              {present.map((k, si) => {
                const v = r.values[k]
                const y0 = y(acc + v)
                const y1 = y(acc)
                acc += v
                const isTop = si === present.length - 1
                const h = Math.max(0, y1 - y0 - (isTop ? 0 : GAP))
                return (
                  <g key={k}>
                    <path d={segmentPath(x, y0, barW, h, isTop)} fill={colorOf(k)} />
                    {/* Hit target + tooltip: an invisible rect sized to the segment. */}
                    <rect data-segment={k} x={x} y={y0} width={barW} height={Math.max(h, 1)} fill={colorOf(k)} fillOpacity={0}>
                      <title>{`${r.label} · ${k}: ${valueFormatter(v)}`}</title>
                    </rect>
                  </g>
                )
              })}
              {xLabels.has(i) && (
                <text data-axis="x" x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize={9} fill={CHART_INK.axisText}>
                  {r.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <ul aria-label={`${title} legend`} className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
        {keys.map((k) => (
          <li key={k} className="flex items-center gap-1 text-xs text-muted-foreground">
            <span data-swatch className="inline-block h-2 w-2 rounded-[2px]" style={{ backgroundColor: colorOf(k) }} />
            {k}
          </li>
        ))}
      </ul>
      <table className="sr-only" aria-label={`${title} data`}>
        <thead>
          <tr>
            <th>Date</th>
            {keys.map((k) => <th key={k}>{k}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              {keys.map((k) => <td key={k}>{valueFormatter(r.values[k] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
