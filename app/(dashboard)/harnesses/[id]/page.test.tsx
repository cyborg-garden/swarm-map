/**
 * Agent page, Keys tab: when a key change is saved but the restart that
 * applies it fails, the page says so and still shows the saved state, and
 * "deleted" / "unassigned" are not reported as clean successes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { toast } from 'sonner'
import HarnessDetailPage from './page'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.setConfig({ testTimeout: 20000 })

const HARNESS = {
  id: 'h_alpha', name: 'alpha', status: 'running', tier: 'private', platform: 'discord', channel: 'general',
  models: ['m1'], tools: [], costToday: 0, invocations: 0, health: { errors: 0, restartCount: 0 },
}
const POOL_KEY = { id: 'k_pool', provider: 'openai', maskedValue: 'masked-1', assignedTo: [], health: 'good' }
const HELD_KEY = { id: 'k_held', provider: 'brave', maskedValue: 'masked-2', assignedTo: ['h_alpha'], health: 'good' }

let keyListFetches: number
let restartStatus: number
let restarts: unknown

beforeEach(() => {
  keyListFetches = 0
  restartStatus = 500
  restarts = [{ harnessId: 'h_alpha', ok: false, error: 'compose file missing' }]
  for (const fn of [toast.success, toast.error]) vi.mocked(fn).mockClear()
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    let status = 200
    let body: unknown = {}
    if (url === '/api/harnesses/h_alpha') body = HARNESS
    else if (url === '/api/keys' && method === 'GET') { keyListFetches++; body = [POOL_KEY, HELD_KEY] }
    else if (url === '/api/harnesses/h_alpha/restart') { status = restartStatus; body = { error: 'compose file missing' } }
    else if (url.startsWith('/api/keys/')) body = method === 'DELETE' ? { ok: true, restarts } : { ...HELD_KEY, restarts }
    else if (['/api/tools', '/api/memory-scopes', '/api/surfaces'].includes(url)) body = []
    // Everything else on the page (usage, models, settings…) stays unloaded.
    else { status = 404; body = { error: 'not in this test' } }
    return { ok: status < 400, status, statusText: '', json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

async function openKeysTab() {
  const params = Promise.resolve({ id: 'h_alpha' })
  await act(async () => {
    render(<Suspense fallback={null}><HarnessDetailPage params={params} /></Suspense>)
    await params
  })
  const tab = await screen.findByRole('tab', { name: /keys/i }, { timeout: 10000 })
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
  await screen.findByText('masked-2')
}

describe('agent page keys', () => {
  it('reloads the key list when an assigned key could not be applied by a restart', async () => {
    await openKeysTab()
    const before = keyListFetches
    fireEvent.click(screen.getByRole('button', { name: /assign existing/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Key assigned, but the restart failed: compose file missing. Restart the agent to apply it.',
    ))
    expect(keyListFetches).toBeGreaterThan(before)
  })

  it('does not report a clean unassign when the restart failed', async () => {
    await openKeysTab()
    fireEvent.click(screen.getByRole('button', { name: /unassign/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/^Key unassigned, but the restart of alpha failed: compose file missing/)))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
