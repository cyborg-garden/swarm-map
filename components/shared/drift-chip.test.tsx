/**
 * Tests for the fleet drift chip + banner.
 *
 * The load-bearing property is negative: no state other than a clean `current`
 * may be drawn green, and the chip must show an age delta rather than a
 * boolean. Both are asserted directly on the rendered output, not on the helper
 * functions alone — the incident was a rendering failure, not a logic failure.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  DriftChip,
  DriftBanner,
  driftLevel,
  driftLabel,
  formatAge,
  isCurrent,
  summarizeDrift,
  STALE_ALERT_MS,
  type DriftSummary,
} from './drift-chip'

const DAY = 86_400_000

function d(over: Partial<DriftSummary> = {}): DriftSummary {
  return {
    harnessId: 'h_iris',
    name: 'iris',
    state: 'current',
    containerSha: 'a'.repeat(40),
    sourceSha: 'a'.repeat(40),
    commitsBehind: null,
    ageBehindMs: null,
    hotPatched: false,
    detail: null,
    ...over,
  }
}

const ALL_STATES: DriftSummary['state'][] = [
  'current',
  'behind',
  'unknown-no-provenance',
  'unknown-not-running',
]

describe('drift level', () => {
  it('is green ONLY for a clean current agent', () => {
    // The single rule this whole module exists to enforce.
    for (const state of ALL_STATES) {
      const level = driftLevel(d({ state }))
      expect(level === 'ok').toBe(state === 'current')
    }
  })

  it('never treats an unknown state as current', () => {
    expect(isCurrent(d({ state: 'unknown-no-provenance' }))).toBe(false)
    expect(isCurrent(d({ state: 'unknown-not-running' }))).toBe(false)
    expect(isCurrent(undefined)).toBe(false)
    expect(isCurrent(null)).toBe(false)
    expect(isCurrent(d({ state: 'current' }))).toBe(true)
  })

  it('demotes a sha-matching container that was hot-patched', () => {
    expect(driftLevel(d({ state: 'current', hotPatched: true }))).toBe('alert')
    expect(isCurrent(d({ state: 'current', hotPatched: true }))).toBe(false)
  })

  it('escalates from warn to alert once the age gap reaches the incident threshold', () => {
    expect(driftLevel(d({ state: 'behind', ageBehindMs: STALE_ALERT_MS - 1 }))).toBe('behind')
    expect(driftLevel(d({ state: 'behind', ageBehindMs: STALE_ALERT_MS }))).toBe('alert')
  })
})

describe('drift label', () => {
  it('is an age delta, not a boolean', () => {
    expect(driftLabel(d({ state: 'behind', commitsBehind: 11, ageBehindMs: 4 * DAY }))).toBe(
      '11 commits / 4d behind',
    )
  })

  it('singularizes a one-commit gap', () => {
    expect(driftLabel(d({ state: 'behind', commitsBehind: 1, ageBehindMs: 3 * 3_600_000 }))).toBe(
      '1 commit / 3h behind',
    )
  })

  it('says the delta is unknown rather than implying it is small', () => {
    expect(driftLabel(d({ state: 'behind' }))).toBe('behind (delta unknown)')
  })

  it('names the two unknowns distinctly', () => {
    expect(driftLabel(d({ state: 'unknown-no-provenance' }))).toBe('build unknown')
    expect(driftLabel(d({ state: 'unknown-not-running' }))).toBe('not running')
  })

  it('formats ages at day, hour and minute scale', () => {
    expect(formatAge(4 * DAY)).toBe('4d')
    expect(formatAge(5 * 3_600_000)).toBe('5h')
    expect(formatAge(90_000)).toBe('1m')
  })
})

describe('DriftChip', () => {
  it('renders the age delta and a green class for a current agent only', () => {
    const { container, rerender } = render(<DriftChip drift={d({ state: 'current' })} />)
    expect(container.querySelector('span')!.className).toContain('green')

    rerender(
      <DriftChip drift={d({ state: 'behind', commitsBehind: 11, ageBehindMs: 4 * DAY })} />,
    )
    expect(screen.getByText('11 commits / 4d behind')).toBeTruthy()
    expect(container.querySelector('span')!.className).not.toContain('green')
  })

  it('renders an unknown chip — never nothing, never green — for a missing row', () => {
    // An agent the drift sweep did not report on is itself a finding. Hiding it
    // is how an agent runs stale code invisibly.
    const { container } = render(<DriftChip drift={undefined} />)
    const span = container.querySelector('span')!
    expect(span.textContent).toBe('build unknown')
    expect(span.className).not.toContain('green')
  })

  it('says hot-patched, and does not look ok, when files were copied in', () => {
    const { container } = render(<DriftChip drift={d({ state: 'current', hotPatched: true })} />)
    expect(container.textContent).toContain('hot-patched')
    expect(container.querySelector('span')!.className).not.toContain('green')
  })
})

describe('summarizeDrift', () => {
  it('counts a hot-patched current agent as NOT current', () => {
    const s = summarizeDrift([
      d({ harnessId: 'a', state: 'current' }),
      d({ harnessId: 'b', state: 'current', hotPatched: true }),
      d({ harnessId: 'c', state: 'behind', commitsBehind: 2 }),
      d({ harnessId: 'e', state: 'unknown-not-running' }),
    ])
    expect(s.total).toBe(4)
    expect(s.current).toBe(1)
    expect(s.behind).toBe(1)
    expect(s.unknown).toBe(1)
    expect(s.hotPatched).toBe(1)
    expect(s.worst).toBe('alert')
  })
})

describe('DriftBanner', () => {
  it('stays hidden only when every agent is provably current', () => {
    const { container } = render(
      <DriftBanner agents={[d({ harnessId: 'a' }), d({ harnessId: 'b' })]} />,
    )
    expect(container.textContent).toBe('')
  })

  it('fires for a merely-unknown fleet, not just a known-behind one', () => {
    // The 2026-08-10 state: no container could say what it was built from.
    render(<DriftBanner agents={[d({ state: 'unknown-no-provenance' })]} />)
    expect(screen.getByRole('status').textContent).toContain('0 of 1 agents are running current code')
    expect(screen.getByRole('status').textContent).toContain('1 with unknown build')
  })

  it('reports the behind count and says nothing rebuilds on its own', () => {
    render(
      <DriftBanner
        agents={[
          d({ harnessId: 'a', state: 'behind', commitsBehind: 11, ageBehindMs: 4 * DAY }),
          d({ harnessId: 'b', state: 'current' }),
        ]}
      />,
    )
    const text = screen.getByRole('status').textContent!
    expect(text).toContain('1 of 2 agents are running current code')
    expect(text).toContain('1 behind')
    expect(text).toContain('Nothing rebuilds on its own')
  })
})
