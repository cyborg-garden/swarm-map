import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { FleetAnalytics } from './fleet-analytics'

const sample = {
  days: [
    { date: '2026-09-21', cost: 2, tokens: 10, sessions: 3, toolCalls: 1, byHarness: { heron: { cost: 2, tokens: 10, sessions: 3 } }, bySource: { discord: 3 } },
    { date: '2026-09-22', cost: 1, tokens: 5, sessions: 1, toolCalls: 0, byHarness: { ledger: { cost: 1, tokens: 5, sessions: 1 } }, bySource: { cli: 1 } },
  ],
  harnesses: [
    { harnessId: 'h_heron', name: 'heron', cost: 2, tokens: 10, sessions: 3, toolCalls: 1, costStatus: 'estimated', stale: false, pending: false },
    { harnessId: 'h_ledger', name: 'ledger', cost: 1, tokens: 5, sessions: 1, toolCalls: 0, costStatus: 'estimated', stale: true, pending: false },
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
    expect(table).toHaveTextContent('heron')
    expect(table).toHaveTextContent('$2.00')
    // Pending harness: "pending", never $0.
    const newRow = screen.getByRole('row', { name: /new/i })
    expect(newRow).toHaveTextContent(/pending/i)
    expect(newRow).not.toHaveTextContent('$0.00')
    expect(screen.getByText(/read from a snapshot export/i)).toHaveTextContent(/5 min/)
  })

  it('orders harnesses by use, biggest first, with pending rows last', async () => {
    const shuffled = {
      ...sample,
      harnesses: [
        sample.harnesses[2], // pending
        { harnessId: 'h_free', name: 'free', cost: 0, tokens: 50, sessions: 1, toolCalls: 0, costStatus: 'unknown', stale: false, pending: false },
        sample.harnesses[1], // ledger, $1
        sample.harnesses[0], // heron, $2
      ],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => shuffled })))
    render(<FleetAnalytics />)
    const table = await screen.findByRole('table', { name: /per harness/i })
    const names = within(table).getAllByRole('row').slice(1, 5).map((r) => within(r).getAllByRole('cell')[0].textContent)
    expect(names).toEqual(['heron', 'ledger·snapshot', 'free', 'new'])
  })

  it('shows a total row summing every counted harness', async () => {
    render(<FleetAnalytics />)
    await screen.findByRole('table', { name: /per harness/i })
    const total = screen.getByRole('row', { name: /total/i })
    const cells = within(total).getAllByRole('cell').map((c) => c.textContent)
    // heron + ledger; the pending harness adds nothing.
    expect(cells).toEqual(['$3.00', '4', '1', '15'])
  })

  it('refetches with the selected range', async () => {
    render(<FleetAnalytics />)
    await screen.findByRole('img', { name: /cost by harness/i })
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(calls).toContain('/api/fleet/analytics?days=7'))
  })
})
