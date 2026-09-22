/**
 * Chart components (#206). Inline SVG, no chart library.
 *
 * The properties that matter: every series colour is a CSS variable in the
 * rendered output (dark mode can't reach an inline hex — see the dark-mode
 * rule), identity is never colour-alone (legend + <title> + a data table),
 * and categorical hues are assigned in fixed order and never cycled past the
 * palette (extra series fold into "Other").
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { StackedBarChart, type StackedBarDatum } from './stacked-bar-chart'
import { LineChart } from './line-chart'
import { HorizontalBarList } from './horizontal-bar-list'
import { SERIES_TOKENS, formatCompact, formatUsd } from './chart-tokens'

const stacked: StackedBarDatum[] = [
  { label: '2026-09-20', values: { 'claude-sonnet-4-6': 2, 'claude-haiku-4-5': 1 } },
  { label: '2026-09-21', values: { 'claude-sonnet-4-6': 0, 'claude-haiku-4-5': 3 } },
  { label: '2026-09-22', values: { 'claude-sonnet-4-6': 1.5 } },
]

describe('chart-tokens', () => {
  it('exposes exactly eight categorical slots, all CSS variables', () => {
    expect(SERIES_TOKENS).toHaveLength(8)
    for (const t of SERIES_TOKENS) expect(t).toMatch(/^var\(--chart-\d\)$/)
  })
  it('formats compact numbers and dollars', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(12_900)).toBe('12.9K')
    expect(formatCompact(4_200_000)).toBe('4.2M')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1.234)).toBe('$1.23')
    expect(formatUsd(0.004)).toBe('<$0.01')
  })
})

describe('StackedBarChart', () => {
  it('renders an accessible svg with one segment per non-zero value, coloured by CSS variable', () => {
    const { container } = render(<StackedBarChart title="Cost by model" data={stacked} valueFormatter={formatUsd} />)
    const svg = screen.getByRole('img', { name: /cost by model/i })
    expect(svg.tagName.toLowerCase()).toBe('svg')
    const segments = container.querySelectorAll('rect[data-segment]')
    expect(segments).toHaveLength(4) // 2 + 1 + 1 non-zero values
    // Keys are assigned colours in a fixed (alphabetical) order: haiku < sonnet.
    const haiku = container.querySelectorAll('rect[data-segment="claude-haiku-4-5"]')
    const sonnet = container.querySelectorAll('rect[data-segment="claude-sonnet-4-6"]')
    expect(haiku).toHaveLength(2)
    expect(sonnet).toHaveLength(2)
    haiku.forEach((r) => expect(r.getAttribute('fill')).toBe('var(--chart-1)'))
    sonnet.forEach((r) => expect(r.getAttribute('fill')).toBe('var(--chart-2)'))
    // No resolved hex anywhere in the svg.
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('labels every segment with a <title> tooltip carrying label, key and formatted value', () => {
    const { container } = render(<StackedBarChart title="Cost by model" data={stacked} valueFormatter={formatUsd} />)
    const titles = Array.from(container.querySelectorAll('rect[data-segment] > title')).map((t) => t.textContent)
    expect(titles).toContain('2026-09-20 · claude-sonnet-4-6: $2.00')
    expect(titles).toContain('2026-09-22 · claude-sonnet-4-6: $1.50')
  })

  it('renders a legend with a swatch per series (in colour order) and a hidden data table', () => {
    render(<StackedBarChart title="Cost by model" data={stacked} valueFormatter={formatUsd} />)
    const legend = screen.getByRole('list', { name: /legend/i })
    const items = within(legend).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    const swatch = items[0].querySelector('[data-swatch]') as HTMLElement
    expect(swatch.getAttribute('style')).toContain('var(--chart-1)')

    const table = screen.getByRole('table', { name: /cost by model/i })
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Date', 'claude-haiku-4-5', 'claude-sonnet-4-6'])
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(1 + stacked.length)
    expect(rows[1].textContent).toContain('2026-09-20')
    expect(rows[1].textContent).toContain('$1.00')
  })

  it('folds series beyond the palette into "Other" instead of generating a ninth hue', () => {
    const values: Record<string, number> = {}
    for (let i = 0; i < 12; i++) values[`model-${String(i).padStart(2, '0')}`] = 12 - i
    const { container } = render(<StackedBarChart title="Many" data={[{ label: 'd', values }]} />)
    const legend = screen.getByRole('list', { name: /legend/i })
    const items = within(legend).getAllByRole('listitem').map((i) => i.textContent)
    expect(items).toHaveLength(8)
    expect(items[items.length - 1]).toBe('Other')
    // model-00..model-06 (largest seven) are kept; the rest fold into Other.
    expect(items.slice(0, 7)).toEqual(['model-00', 'model-01', 'model-02', 'model-03', 'model-04', 'model-05', 'model-06'])
    const other = container.querySelector('rect[data-segment="Other"] > title')
    expect(other?.textContent).toBe('d · Other: 15') // 5+4+3+2+1
    const fills = new Set(Array.from(container.querySelectorAll('rect[data-segment]')).map((r) => r.getAttribute('fill')))
    expect(fills.size).toBe(8)
  })

  it('shows an empty state when every value is zero', () => {
    render(<StackedBarChart title="Empty" data={[{ label: 'a', values: {} }, { label: 'b', values: { x: 0 } }]} />)
    expect(screen.getByText(/no data/i)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: /legend/i })).toBeNull()
  })

  it('thins x-axis labels so long ranges do not collide', () => {
    const data = Array.from({ length: 90 }, (_, i) => ({ label: `2026-07-${String(i + 1).padStart(2, '0')}`, values: { a: 1 } }))
    const { container } = render(<StackedBarChart title="Long" data={data} />)
    const labels = container.querySelectorAll('text[data-axis="x"]')
    expect(labels.length).toBeGreaterThanOrEqual(4)
    expect(labels.length).toBeLessThanOrEqual(12)
    expect(labels[0].textContent).toBe('2026-07-01')
  })
})

describe('LineChart', () => {
  const points = [
    { label: '2026-09-20', value: 3 },
    { label: '2026-09-21', value: 7 },
    { label: '2026-09-22', value: 5 },
  ]

  it('renders one 2px path in the first series token, an end marker, and per-point titles', () => {
    const { container } = render(<LineChart title="Tool calls per day" data={points} />)
    const svg = screen.getByRole('img', { name: /tool calls per day/i })
    const path = container.querySelector('path[data-line]') as SVGPathElement
    expect(path).not.toBeNull()
    expect(path.getAttribute('stroke')).toBe('var(--chart-1)')
    expect(path.getAttribute('stroke-width')).toBe('2')
    expect(path.getAttribute('fill')).toBe('none')
    const marker = container.querySelector('circle[data-end-marker]') as SVGCircleElement
    expect(marker).not.toBeNull()
    expect(marker.getAttribute('fill')).toBe('var(--chart-1)')
    expect(marker.getAttribute('stroke')).toBe('var(--surface)')
    const titles = Array.from(container.querySelectorAll('[data-point] > title')).map((t) => t.textContent)
    expect(titles).toEqual(['2026-09-20: 3', '2026-09-21: 7', '2026-09-22: 5'])
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('has no legend (single series) but does have a hidden data table', () => {
    render(<LineChart title="Tool calls per day" data={points} />)
    expect(screen.queryByRole('list', { name: /legend/i })).toBeNull()
    const table = screen.getByRole('table', { name: /tool calls per day/i })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
  })

  it('shows an empty state when all values are zero', () => {
    render(<LineChart title="Flat" data={[{ label: 'a', value: 0 }]} />)
    expect(screen.getByText(/no data/i)).toBeInTheDocument()
  })
})

describe('HorizontalBarList', () => {
  const items = [
    { label: 'read_file', value: 40 },
    { label: 'terminal', value: 10 },
    { label: 'web_search', value: 5 },
  ]

  it('renders rows in the given order with proportional bar widths and text values', () => {
    const { container } = render(<HorizontalBarList title="Top tools" items={items} />)
    const list = screen.getByRole('list', { name: /top tools/i })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['read_file40', 'terminal10', 'web_search5'])
    const bars = container.querySelectorAll('[data-bar]')
    expect((bars[0] as HTMLElement).getAttribute('style')).toContain('width: 100%')
    expect((bars[1] as HTMLElement).getAttribute('style')).toContain('width: 25%')
    expect((bars[0] as HTMLElement).getAttribute('style')).toContain('var(--chart-1)')
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('formats values with the supplied formatter', () => {
    render(<HorizontalBarList title="Users" items={[{ label: 'discord · ab12', value: 1234 }]} valueFormatter={formatCompact} />)
    expect(screen.getByText('1.2K')).toBeInTheDocument()
  })

  it('shows an empty state for no items', () => {
    render(<HorizontalBarList title="Top tools" items={[]} />)
    expect(screen.getByText(/no data/i)).toBeInTheDocument()
  })
})
