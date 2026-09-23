/**
 * AnalyticsTab (#206): fetches /api/harnesses/:id/analytics?days=N and renders
 * the charts. The contracts: the days selector changes the query; a pending
 * harness renders "pending", never $0; a snapshot read shows the stale note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AnalyticsTab } from './analytics-tab'

const sample = {
  harnessId: 'h_iris',
  days: [
    { date: '2026-09-21', cost: 1, tokens: 1000, sessions: 2, toolCalls: 4, byModel: { 'claude-sonnet-4-6': { cost: 1, tokens: 1000 } }, bySource: { discord: 2 } },
    { date: '2026-09-22', cost: 0.5, tokens: 500, sessions: 1, toolCalls: 1, byModel: { 'claude-haiku-4-5': { cost: 0.5, tokens: 500 } }, bySource: { cli: 1 } },
  ],
  topTools: [{ name: 'read_file', count: 5 }],
  topUsers: [{ source: 'discord', userHash: 'abcdef0123', sessions: 2 }],
  costStatus: 'estimated',
  stale: false,
}

let calls: string[]
function mockFetch(body: unknown) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }))
}

beforeEach(() => { mockFetch(sample) })
afterEach(() => { vi.unstubAllGlobals() })

describe('AnalyticsTab', () => {
  it('fetches 30 days by default and renders totals, charts and lists', async () => {
    render(<AnalyticsTab harnessId="h_iris" />)
    expect(await screen.findByText('$1.50')).toBeInTheDocument()
    expect(calls[0]).toBe('/api/harnesses/h_iris/analytics?days=30')
    expect(screen.getByRole('img', { name: /cost by model/i })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /sessions by surface/i })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /tool calls per day/i })).toBeInTheDocument()
    expect(screen.getByRole('list', { name: /top tools/i })).toHaveTextContent('read_file')
    expect(screen.getByRole('list', { name: /top users/i })).toHaveTextContent('discord · abcdef0123')
    expect(screen.getByText('3')).toBeInTheDocument() // sessions total
    expect(screen.queryByText(/stale/i)).toBeNull()
  })

  it('refetches with the selected range', async () => {
    render(<AnalyticsTab harnessId="h_iris" />)
    await screen.findByText('$1.50')
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(calls).toContain('/api/harnesses/h_iris/analytics?days=7'))
    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(calls).toContain('/api/harnesses/h_iris/analytics?days=90'))
  })

  it('renders "pending" for a migrated harness without a snapshot — never $0', async () => {
    mockFetch({ harnessId: 'h_iris', pending: true })
    render(<AnalyticsTab harnessId="h_iris" />)
    expect(await screen.findAllByText(/pending/i)).not.toHaveLength(0)
    expect(screen.queryByText('$0.00')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows the snapshot staleness note when the data came from a snapshot', async () => {
    mockFetch({ ...sample, stale: true, snapshotAt: Date.now() - 60_000 })
    render(<AnalyticsTab harnessId="h_iris" />)
    expect(await screen.findByText(/read from a snapshot export/i)).toHaveTextContent(/5 min/)
  })

  it('surfaces a fetch error instead of an empty chart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) })))
    render(<AnalyticsTab harnessId="h_iris" />)
    expect(await screen.findByText(/500/)).toBeInTheDocument()
  })
})
