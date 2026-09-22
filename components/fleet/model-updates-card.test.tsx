/**
 * ModelUpdatesCard (fleet dashboard): the global model-auto-update policy
 * (GET/PUT /api/settings/model-auto-update), a "Check now" trigger
 * (POST /api/fleet/model-updates/check), and the pending successors from the
 * last report (GET /api/fleet/model-updates) with one-click apply
 * (POST /api/fleet/model-updates/apply).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ModelUpdatesCard } from './model-updates-card'
import { ModelAutoUpdateControls, useModelAutoUpdate } from './model-auto-update-controls'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

type Call = { url: string; init?: RequestInit }
let calls: Call[]
let routes: Record<string, { status: number; body?: unknown } | ((init?: RequestInit) => { status: number; body?: unknown })>

function installFetch() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url}`
    const r = routes[key]
    if (!r) return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }
    const hit = typeof r === 'function' ? r(init) : r
    return { ok: hit.status < 400, status: hit.status, statusText: '', json: async () => hit.body ?? {} }
  }))
}

const OFF = { enabled: false, mode: 'notify', intervalHours: 24, maxPriceMultiplier: 1.5 }
const ON_NOTIFY = { ...OFF, enabled: true }
const ON_APPLY = { ...OFF, enabled: true, mode: 'apply' }

const REPORT = {
  checkedAt: Date.now() - 3 * 60_000,
  enabled: true,
  mode: 'notify',
  harnesses: [
    { id: 'h_iris', name: 'iris', entries: [
      { provider: 'openrouter', model: 'z-ai/glm-5.2', tracked: true, retired: false, successor: 'z-ai/glm-5.3', kind: 'version' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', tracked: false, retired: false },
    ] },
    { id: 'h_mare', name: 'mare', entries: [
      { provider: 'anthropic', model: 'claude-3-opus', tracked: false, retired: true, successor: 'claude-opus-4-7', kind: 'version', applied: true },
      { provider: 'openrouter', model: 'meta/llama-3', tracked: false, retired: false, successor: 'meta/llama-4', blocked: 'price-ceiling' },
    ] },
  ],
}

beforeEach(() => {
  routes = {
    'GET /api/settings/model-auto-update': { status: 200, body: OFF },
    'GET /api/fleet/model-updates': { status: 200, body: { checkedAt: null, enabled: false, mode: 'notify', harnesses: [] } },
  }
  installFetch()
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('ModelUpdatesCard — policy', () => {
  it('disabled state reads "Off — models stay pinned" and hides mode/price', async () => {
    render(<ModelUpdatesCard />)
    expect(await screen.findByText('Off — models stay pinned')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /model updates/i })).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByLabelText('Mode')).toBeNull()
    expect(screen.queryByLabelText(/price ceiling/i)).toBeNull()
    expect(screen.getByText(/never checked/i)).toBeInTheDocument()
  })

  it('toggling on PUTs {enabled:true} and reveals mode + price ceiling', async () => {
    routes['PUT /api/settings/model-auto-update'] = (init) => ({ status: 200, body: { ...OFF, ...JSON.parse(String(init?.body)) } })
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('switch', { name: /model updates/i }))
    expect(await screen.findByText(/On — notify only/i)).toBeInTheDocument()
    const put = calls.find((c) => c.url === '/api/settings/model-auto-update' && c.init?.method === 'PUT')!
    expect(JSON.parse(String(put.init?.body))).toEqual({ enabled: true })
    expect(screen.getByLabelText('Mode')).toHaveValue('notify')
    expect(screen.getByLabelText(/price ceiling/i)).toHaveValue(1.5)
  })

  it('changing the mode PUTs {mode} and the status line follows', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_NOTIFY }
    routes['PUT /api/settings/model-auto-update'] = (init) => ({ status: 200, body: { ...ON_NOTIFY, ...JSON.parse(String(init?.body)) } })
    render(<ModelUpdatesCard />)
    const mode = await screen.findByLabelText('Mode')
    fireEvent.change(mode, { target: { value: 'apply' } })
    expect(await screen.findByText(/On — applies tracked updates/i)).toBeInTheDocument()
    const put = calls.find((c) => c.url === '/api/settings/model-auto-update' && c.init?.method === 'PUT')!
    expect(JSON.parse(String(put.init?.body))).toEqual({ mode: 'apply' })
  })

  it('price ceiling commits on blur as a number; a 400 toasts the API text and reverts', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_APPLY }
    let n = 0
    routes['PUT /api/settings/model-auto-update'] = (init) => {
      n += 1
      const patch = JSON.parse(String(init?.body))
      if (patch.maxPriceMultiplier === 2) return { status: 200, body: { ...ON_APPLY, ...patch } }
      return { status: 400, body: { error: 'modelAutoUpdate.maxPriceMultiplier must be a positive number' } }
    }
    render(<ModelUpdatesCard />)
    const price = await screen.findByLabelText(/price ceiling/i)
    fireEvent.change(price, { target: { value: '2' } })
    fireEvent.blur(price)
    await waitFor(() => expect(n).toBe(1))
    const put = calls.find((c) => c.url === '/api/settings/model-auto-update' && c.init?.method === 'PUT')!
    expect(JSON.parse(String(put.init?.body))).toEqual({ maxPriceMultiplier: 2 })

    fireEvent.change(price, { target: { value: '-1' } })
    fireEvent.blur(price)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('modelAutoUpdate.maxPriceMultiplier must be a positive number'))
    expect(price).toHaveValue(2)
  })

  it('an unchanged price ceiling does not PUT', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_APPLY }
    render(<ModelUpdatesCard />)
    const price = await screen.findByLabelText(/price ceiling/i)
    fireEvent.blur(price)
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false)
  })
})

describe('ModelUpdatesCard — report', () => {
  it('lists pending successors (not applied ones) with harness name, last-checked time and blocked reason', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_NOTIFY }
    routes['GET /api/fleet/model-updates'] = { status: 200, body: REPORT }
    render(<ModelUpdatesCard />)
    const list = await screen.findByRole('list', { name: /pending model updates/i })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('iris')
    expect(items[0]).toHaveTextContent('z-ai/glm-5.2')
    expect(items[0]).toHaveTextContent('z-ai/glm-5.3')
    expect(items[1]).toHaveTextContent('mare')
    expect(items[1]).toHaveTextContent('meta/llama-4')
    expect(items[1]).toHaveTextContent(/price-ceiling/)
    expect(screen.queryByText('claude-opus-4-7')).toBeNull()
    expect(screen.getByText(/checked 3m ago/i)).toBeInTheDocument()
  })

  it('shows "No pending updates" when the report has no successors', async () => {
    routes['GET /api/fleet/model-updates'] = { status: 200, body: { checkedAt: Date.now(), enabled: false, mode: 'notify', harnesses: [{ id: 'h', name: 'h', entries: [{ provider: 'anthropic', model: 'x', tracked: false, retired: false }] }] } }
    render(<ModelUpdatesCard />)
    expect(await screen.findByText(/no pending updates/i)).toBeInTheDocument()
  })

  it('Check now POSTs the check route, then refetches the report', async () => {
    routes['POST /api/fleet/model-updates/check'] = { status: 200, body: REPORT }
    let gets = 0
    routes['GET /api/fleet/model-updates'] = () => { gets += 1; return { status: 200, body: gets > 1 ? REPORT : { checkedAt: null, enabled: false, mode: 'notify', harnesses: [] } } }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/fleet/model-updates/check' && c.init?.method === 'POST')).toBe(true))
    expect(await screen.findByRole('list', { name: /pending model updates/i })).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalled()
  })

  // Re-audit: in apply mode the check route rotates tracked successors and
  // restarts those harnesses. The toast said "every model is current".
  it('Check now in apply mode reports what was applied and restarted, never "every model is current"', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_APPLY }
    routes['POST /api/fleet/model-updates/check'] = {
      status: 200,
      body: {
        checkedAt: Date.now(),
        enabled: true,
        mode: 'apply',
        harnesses: [
          { id: 'h_bh', name: 'blackhouse', entries: [{ provider: 'openrouter', model: 'z-ai/glm-5.2', tracked: true, retired: false, successor: 'z-ai/glm-5.3', kind: 'version', applied: true }] },
          { id: 'h_iris', name: 'iris', entries: [{ provider: 'openrouter', model: 'moonshotai/kimi-k2.7', tracked: false, retired: false, successor: 'moonshotai/kimi-k3', kind: 'version' }] },
        ],
      },
    }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const msg = String(vi.mocked(toast.success).mock.calls[0][0])
    expect(msg).toMatch(/1 update applied/)
    expect(msg).toMatch(/blackhouse/)
    expect(msg).toMatch(/restart/)
    expect(msg).toMatch(/1 more available/)
    expect(msg).not.toMatch(/every model is current/)
  })

  it('Check now with nothing applied and nothing pending says every model is current', async () => {
    routes['POST /api/fleet/model-updates/check'] = { status: 200, body: { checkedAt: Date.now(), enabled: true, mode: 'notify', harnesses: [{ id: 'h', name: 'h', entries: [{ provider: 'anthropic', model: 'x', tracked: false, retired: false }] }] } }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Checked — every model is current'))
  })

  it('Check now failure toasts the error', async () => {
    routes['POST /api/fleet/model-updates/check'] = { status: 500, body: { error: 'model update check failed' } }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /check now/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('model update check failed'))
  })

  it('per-row Update posts {harnessId, from, to} to the fleet apply route and refetches', async () => {
    routes['GET /api/fleet/model-updates'] = { status: 200, body: REPORT }
    routes['POST /api/fleet/model-updates/apply'] = { status: 200, body: { ok: true, harnessId: 'h_iris', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' } }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /update z-ai\/glm-5\.2 to z-ai\/glm-5\.3/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/fleet/model-updates/apply')).toBe(true))
    const apply = calls.find((c) => c.url === '/api/fleet/model-updates/apply')!
    expect(JSON.parse(String(apply.init?.body))).toEqual({ harnessId: 'h_iris', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' })
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/fleet/model-updates' && !c.init?.method).length).toBeGreaterThanOrEqual(2))
    expect(toast.success).toHaveBeenCalled()
  })

  it('per-row Update error toasts the API text', async () => {
    routes['GET /api/fleet/model-updates'] = { status: 200, body: REPORT }
    routes['POST /api/fleet/model-updates/apply'] = { status: 409, body: { error: 'Blocked: restart-in-flight' } }
    render(<ModelUpdatesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /update z-ai\/glm-5\.2 to z-ai\/glm-5\.3/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Blocked: restart-in-flight'))
  })
})

describe('ModelAutoUpdateControls (shared with the settings page)', () => {
  function Host() {
    const policy = useModelAutoUpdate()
    return <ModelAutoUpdateControls {...policy} />
  }
  it('renders the same toggle block standalone', async () => {
    routes['GET /api/settings/model-auto-update'] = { status: 200, body: ON_APPLY }
    render(<Host />)
    expect(await screen.findByRole('switch', { name: /model updates/i })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText(/On — applies tracked updates/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Mode')).toHaveValue('apply')
  })
})
