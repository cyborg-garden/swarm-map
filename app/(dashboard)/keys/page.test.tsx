/**
 * Keys page: the budget is labelled the same, true way wherever it appears,
 * and a save whose restart failed is not reported as a clean success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import KeysPage from './page'
import { BUDGET_LABEL } from '@/lib/budget-copy'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/keys',
  useSearchParams: () => new URLSearchParams(),
}))

const KEY = { id: 'k1', provider: 'openai', maskedValue: 'sk-…0001', assignedTo: ['h_alpha'], budgetUsd: 20, health: 'good' }
let restarts: unknown

beforeEach(() => {
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  restarts = [{ harnessId: 'h_alpha', ok: true }]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.method === 'PUT' ? { ...KEY, restarts }
      : url === '/api/keys' ? [KEY]
      : [{ id: 'h_alpha', name: 'alpha', tier: 'private' }]
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

async function rotate() {
  render(<KeysPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByPlaceholderText('Paste new key to rotate...'), { target: { value: 'test-value-0000000000000002' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

describe('budget wording', () => {
  it('says "not enforced" on the table and on the add form', async () => {
    render(<KeysPage />)
    await screen.findByRole('button', { name: 'Edit' })
    expect(BUDGET_LABEL).toMatch(/not enforced/)
    expect(screen.getAllByText(BUDGET_LABEL)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '+ Add Key' }))
    expect(screen.getAllByText(BUDGET_LABEL)).toHaveLength(2)
    expect(screen.queryByText('Budget ($/mo)')).toBeNull()
  })
})

describe('rotating a key', () => {
  it('reports success when the restarts started', async () => {
    await rotate()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key rotated & updated across all harnesses'))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says the key was saved but the restart failed, naming the agent', async () => {
    restarts = [{ harnessId: 'h_alpha', ok: false, error: 'compose file missing' }]
    await rotate()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Key rotated, but the restart of alpha failed: compose file missing. Restart it to apply the change.',
    ))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
