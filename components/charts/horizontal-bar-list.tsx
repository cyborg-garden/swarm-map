'use client'

import { formatCompact, seriesColor } from './chart-tokens'

export type BarListItem = { label: string; value: number; hint?: string }

type Props = {
  title: string
  items: BarListItem[]
  valueFormatter?: (n: number) => string
  emptyText?: string
}

/** Top-N list: label, a thin bar proportional to the max, the value at the tip. */
export function HorizontalBarList({ title, items, valueFormatter = formatCompact, emptyText = 'No data for this range.' }: Props) {
  const max = Math.max(0, ...items.map((i) => i.value))
  return (
    <figure>
      <figcaption className="text-xs text-muted-foreground mb-1">{title}</figcaption>
      {items.length === 0 || max === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">{emptyText}</p>
      ) : (
        <ul aria-label={title} className="space-y-1.5">
          {items.map((it) => (
            <li key={it.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs" title={it.hint}>
              <span className="truncate font-mono">{it.label}</span>
              <span className="h-2 rounded-r-[4px] bg-[var(--muted)]">
                <span
                  data-bar
                  className="block h-2 rounded-r-[4px]"
                  style={{ width: `${(it.value / max) * 100}%`, backgroundColor: seriesColor(0) }}
                />
              </span>
              <span className="tabular-nums text-muted-foreground">{valueFormatter(it.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}
