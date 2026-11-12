/**
 * RetiredRows (fleet page): stored rows whose runtime Swarm Map no longer
 * drives. They are shown with a label and exactly one action, "Forget row",
 * which calls DELETE /api/harnesses/:id and never asks for file deletion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RetiredRows } from './retired-rows'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type Call = { url: string; init?: RequestInit }
let calls: Call[]
let rows: unknown
let deleteStatus: number

const OLD = {
  id: 'h_old',
  name: 'old',
  runtime: 'retired-runtime-x',
  reason: 'retired',
  note: 'Retired runtime: this path was removed.',
}

beforeEach(() => {
  calls = []
  rows = [OLD]
  deleteStatus = 200
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if ((init?.method ?? 'GET') === 'DELETE') {
      return { ok: deleteStatus < 400, status: deleteStatus, statusText: '', json: async () => ({ removed: deleteStatus < 400, error: 'nope' }) }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => rows }
  }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RetiredRows', () => {
  it('renders nothing when there are no such rows', async () => {
    rows = []
    const { container } = render(<RetiredRows />)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/harnesses/retired')).toBe(true))
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the endpoint answers with an error object', async () => {
    rows = { error: 'disk gone', retired: [] }
    const { container } = render(<RetiredRows />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the name, the stored runtime tag and the reason, with no link to a detail page', async () => {
    render(<RetiredRows />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    expect(screen.getByText('retired-runtime-x')).toBeInTheDocument()
    expect(screen.getByText('Retired runtime: this path was removed.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
    // One action only. No restart, stop or duplicate.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Forget row'])
  })

  it('"Forget row" sends a plain DELETE (no deleteFiles) and reloads', async () => {
    render(<RetiredRows />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget row' }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true))
    const del = calls.find((c) => c.init?.method === 'DELETE')!
    expect(del.url).toBe('/api/harnesses/h_old')
    expect(del.url).not.toContain('deleteFiles')
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    // Reloaded after the delete.
    expect(calls.filter((c) => c.url === '/api/harnesses/retired').length).toBeGreaterThan(1)
  })

  it('does nothing when the operator cancels the confirm', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    render(<RetiredRows />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget row' }))
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false)
  })

  it('reports a failed delete and keeps the row', async () => {
    deleteStatus = 500
    render(<RetiredRows />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget row' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
    expect(screen.getByText('old')).toBeInTheDocument()
  })
})
