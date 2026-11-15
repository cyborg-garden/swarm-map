/**
 * The wizard is both the first-run path and the fleet page's "Create New".
 * Its heading and back link say which one the operator is on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WizardPage from './page'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

let fleet: unknown

beforeEach(() => {
  push.mockClear()
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url === '/api/harnesses' ? fleet : url === '/api/health/docker' ? { available: true } : []
    return { ok: true, status: 200, json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('wizard heading', () => {
  it('is the first-agent setup step when there are no agents', async () => {
    fleet = []
    render(<WizardPage />)
    expect(await screen.findByRole('heading', { name: 'Create Your First Agent' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← Back to setup' }))
    expect(push).toHaveBeenCalledWith('/setup')
  })

  it('is "Create an agent" with a way back to the fleet when agents exist', async () => {
    fleet = [{ id: 'h_alpha', name: 'alpha' }]
    render(<WizardPage />)
    expect(await screen.findByRole('heading', { name: 'Create an agent' })).toBeInTheDocument()
    expect(screen.queryByText('Create Your First Agent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '← Back to harnesses' }))
    expect(push).toHaveBeenCalledWith('/harnesses')
  })
})
