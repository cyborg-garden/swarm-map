'use client'

import { CHART_INK, formatCompact, niceTicks, seriesColor, thinIndices } from './chart-tokens'

export type LinePoint = { label: string; value: number }

type Props = {
  title: string
  data: LinePoint[]
  valueFormatter?: (n: number) => string
  height?: number
  emptyText?: string
}

const W = 600
const PAD = { top: 8, right: 12, bottom: 22, left: 44 }

/** Single-series line: 2px stroke, 10% area wash, ring-marked end point, no legend. */
export function LineChart({ title, data, valueFormatter = formatCompact, height = 140, emptyText = 'No data for this range.' }: Props) {
  const max = Math.max(0, ...data.map((d) => d.value))
  if (data.length === 0 || max === 0) {
    return (
      <figure>
        <figcaption className="text-xs text-muted-foreground mb-1">{title}</figcaption>
        <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
      </figure>
    )
  }

  const H = height + PAD.top + PAD.bottom
  const plotW = W - PAD.left - PAD.right
  const ticks = niceTicks(max)
  const yMax = ticks[ticks.length - 1]
  const x = (i: number) => (data.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (data.length - 1)) * plotW)
  const y = (v: number) => PAD.top + height - (v / yMax) * height
  const pts = data.map((d, i) => [x(i), y(d.value)] as const)
  const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)}L${pts[0][0].toFixed(1)},${y(0).toFixed(1)}Z`
  const color = seriesColor(0)
  const xLabels = new Set(thinIndices(data.length))
  const last = pts[pts.length - 1]

  return (
    <figure>
      <figcaption className="text-xs text-muted-foreground mb-1">{title}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: line over ${data.length} days`}
        className="w-full h-auto"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        <desc>{`${title}. Latest ${valueFormatter(data[data.length - 1].value)}, peak ${valueFormatter(max)}.`}</desc>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={CHART_INK.grid} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={CHART_INK.axisText}>
              {valueFormatter(t)}
            </text>
          </g>
        ))}
        {data.length > 1 && <path d={area} fill={color} fillOpacity={0.1} />}
        <path data-line d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle data-end-marker cx={last[0]} cy={last[1]} r={4} fill={color} stroke={CHART_INK.surface} strokeWidth={2} />
        {data.map((d, i) => (
          <g key={d.label}>
            {/* Hit target (r=8) larger than the mark, carrying the tooltip. */}
            <circle data-point cx={pts[i][0]} cy={pts[i][1]} r={8} fill={color} fillOpacity={0}>
              <title>{`${d.label}: ${valueFormatter(d.value)}`}</title>
            </circle>
            {xLabels.has(i) && (
              <text data-axis="x" x={pts[i][0]} y={H - 6} textAnchor="middle" fontSize={9} fill={CHART_INK.axisText}>
                {d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      <table className="sr-only" aria-label={`${title} data`}>
        <thead>
          <tr><th>Date</th><th>Value</th></tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}><td>{d.label}</td><td>{valueFormatter(d.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
