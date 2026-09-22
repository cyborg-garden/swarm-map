import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FleetAnalytics } from './fleet-analytics'

const sample = {
  days: [
    { date: '2026-09-21', cost: 2, tokens: 10, sessions: 3, toolCalls: 1, byHarness: { iris: { cost: 2, tokens: 10, sessions: 3 } }, bySource: { discord: 3 } },
    { date: '2026-09-22', cost: 1, tokens: 5, sessions: 1, toolCalls: 0, byHarness: { osint: { cost: 1, tokens: 5, sessions: 1 } }, bySource: { cli: 1 } },
  ],
  harnesses: [
    { harnessId: 'h_iris', name: 'iris', cost: 2, tokens: 10, sessions: 3, toolCalls: 1, costStatus: 'estimated', stale: false, pending: false },
    { harnessId: 'h_osint', name: 'osint', cost: 1, tokens: 5, sessions: 1, toolCalls: 0, costStatus: 'estimated', stale: true, pending: false },
    { harnessId: 'h_new', name: 'new', cost: null, tokens: null, sessions: null, toolCalls: null, costStatus: 'unknown', stale: false, pending: true },
  ],
  costStatus: 'estimated',
  stale: true,
  pendingCount: 1,
}

let calls: string[]
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url)
    return { ok: true, status: 200, statusText: 'OK', json: async () => sample }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('FleetAnalytics', () => {
  it('renders fleet cost by harness and sessions by surface, plus per-harness totals', async () => {
    render(<FleetAnalytics />)
    expect(await screen.findByRole('img', { name: /cost by harness/i })).toBeInTheDocument()
    expect(calls[0]).toBe('/api/fleet/analytics?days=30')
    expect(screen.getByRole('img', { name: /sessions by surface/i })).toBeInTheDocument()
    const table = screen.getByRole('table', { name: /per harness/i })
    expect(table).toHaveTextContent('iris')
    expect(table).toHaveTextContent('$2.00')
    // Pending harness: "pending", never $0.
    const newRow = screen.getByRole('row', { name: /new/i })
    expect(newRow).toHaveTextContent(/pending/i)
    expect(newRow).not.toHaveTextContent('$0.00')
    expect(screen.getByText(/read from a snapshot export/i)).toHaveTextContent(/5 min/)
  })

  it('refetches with the selected range', async () => {
    render(<FleetAnalytics />)
    await screen.findByRole('img', { name: /cost by harness/i })
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(calls).toContain('/api/fleet/analytics?days=7'))
  })
})
