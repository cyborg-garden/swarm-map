/**
 * ModelsTab: the Models tab body. Composes the cascade editor with the
 * per-row status it needs — tracking flags (PUT /models/tracking), retired
 * badges (GET /api/models/live, fail-soft on 204), successor hints from the
 * fleet report (GET /api/fleet/model-updates) with one-click apply
 * (POST /api/fleet/model-updates/apply) — plus the saved-cascade library.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ModelsTab, cascadeSaveConflict } from './models-tab'
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
    if (hit.status === 204) return { ok: true, status: 204, statusText: 'No Content', json: async () => { throw new Error('no body') } }
    return { ok: hit.status < 400, status: hit.status, statusText: '', json: async () => hit.body ?? {} }
  }))
}

const CONFIG = {
  provider: 'openrouter',
  primary: 'z-ai/glm-5.2',
  models: ['z-ai/glm-5.2', 'claude-sonnet-4-6', 'qwen3:30b'],
  fallbackProviders: [
    { provider: 'openrouter', model: 'z-ai/glm-5.2' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
  ],
}

const REPORT = {
  checkedAt: 1_700_000_000_000,
  enabled: true,
  mode: 'notify',
  harnesses: [
    { id: 'h_other', name: 'other', entries: [{ provider: 'openrouter', model: 'z-ai/glm-5.2', tracked: false, retired: false, successor: 'z-ai/glm-9' }] },
    { id: 'h_test', name: 'test', entries: [
      { provider: 'openrouter', model: 'z-ai/glm-5.2', tracked: true, retired: false, successor: 'z-ai/glm-5.3', kind: 'version' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', tracked: false, retired: false },
    ] },
  ],
}

function baseProps() {
  return {
    harnessId: 'h_test',
    modelConfig: CONFIG,
    modelTracking: { 'openrouter/z-ai/glm-5.2': true },
    onSave: vi.fn(),
    saving: false,
    editorKey: 'h_test:0',
    onCascadeChanged: vi.fn(),
  }
}

beforeEach(() => {
  routes = {
    'GET /api/cascades': { status: 200, body: [] },
    'GET /api/fleet/model-updates': { status: 200, body: REPORT },
    'GET /api/models/live?provider=openrouter': { status: 200, body: { provider: 'openrouter', fetchedAt: 1, models: [{ id: 'z-ai/glm-5.2' }, { id: 'z-ai/glm-5.3' }] } },
    'GET /api/models/live?provider=anthropic': { status: 204 },
  }
  installFetch()
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('ModelsTab', () => {
  it('renders the editor rows and the saved cascades section', async () => {
    render(<ModelsTab {...baseProps()} />)
    expect(screen.getByText('z-ai/glm-5.2')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: /saved cascades/i })).toBeInTheDocument()
  })

  it('fetches the live list once per trackable provider in the cascade (never ollama)', async () => {
    render(<ModelsTab {...baseProps()} />)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/models/live?provider=openrouter')).toBe(true))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/models/live?provider=anthropic')).toBe(true))
    expect(calls.filter((c) => c.url.startsWith('/api/models/live')).map((c) => c.url).sort()).toEqual([
      '/api/models/live?provider=anthropic',
      '/api/models/live?provider=openrouter',
    ])
  })

  it('shows a retired badge only when the live list marks the id retired; 204 → no badge', async () => {
    routes['GET /api/models/live?provider=openrouter'] = { status: 200, body: { provider: 'openrouter', fetchedAt: 1, models: [{ id: 'z-ai/glm-5.3' }] } }
    render(<ModelsTab {...baseProps()} />)
    const badge = await screen.findByText('retired')
    expect(badge.closest('[data-row]')).toHaveTextContent('z-ai/glm-5.2')
    // anthropic answered 204 → claude row must not be flagged
    expect(screen.getAllByText('retired')).toHaveLength(1)
  })

  it('seeds Track latest from harness.modelTracking and PUTs a change', async () => {
    routes['PUT /api/harnesses/h_test/models/tracking'] = { status: 200, body: { modelTracking: { 'openrouter/z-ai/glm-5.2': true, 'anthropic/claude-sonnet-4-6': true } } }
    render(<ModelsTab {...baseProps()} />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.2/i })).toHaveAttribute('aria-checked', 'true')
    const claude = screen.getByRole('switch', { name: /track latest for claude-sonnet-4-6/i })
    expect(claude).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(claude)
    await waitFor(() => expect(claude).toHaveAttribute('aria-checked', 'true'))
    const put = calls.find((c) => c.url === '/api/harnesses/h_test/models/tracking')!
    expect(put.init?.method).toBe('PUT')
    expect(JSON.parse(String(put.init?.body))).toEqual({ 'anthropic/claude-sonnet-4-6': true })
  })

  it('a refused tracking change (409) toasts the API text and leaves the toggle unchanged', async () => {
    routes['PUT /api/harnesses/h_test/models/tracking'] = { status: 409, body: { error: 'not in this harness; reload and try again' } }
    render(<ModelsTab {...baseProps()} />)
    const claude = screen.getByRole('switch', { name: /track latest for claude-sonnet-4-6/i })
    fireEvent.click(claude)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('not in this harness; reload and try again'))
    expect(claude).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the successor hint for THIS harness only and applies it via the fleet apply route', async () => {
    routes['POST /api/fleet/model-updates/apply'] = { status: 200, body: { ok: true, harnessId: 'h_test', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' } }
    const props = baseProps()
    render(<ModelsTab {...props} />)
    expect(await screen.findByText(/newer: z-ai\/glm-5\.3/)).toBeInTheDocument()
    expect(screen.queryByText(/glm-9/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /update z-ai\/glm-5\.2 to z-ai\/glm-5\.3/i }))
    await waitFor(() => expect(props.onCascadeChanged).toHaveBeenCalled())
    const apply = calls.find((c) => c.url === '/api/fleet/model-updates/apply')!
    expect(JSON.parse(String(apply.init?.body))).toEqual({ harnessId: 'h_test', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' })
    expect(toast.success).toHaveBeenCalled()
    // No client-side restart: the apply route already restarts the harness.
    expect(calls.some((c) => /\/restart$/.test(c.url))).toBe(false)
  })

  it('a blocked apply surfaces the API error text', async () => {
    routes['POST /api/fleet/model-updates/apply'] = { status: 400, body: { error: 'Blocked: price-ceiling' } }
    const props = baseProps()
    render(<ModelsTab {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: /update z-ai\/glm-5\.2/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Blocked: price-ceiling'))
    expect(props.onCascadeChanged).not.toHaveBeenCalled()
  })

  // --- Re-audit -----------------------------------------------------------

  it('warns when config.yaml\'s primary (model.default) is not the first cascade row', async () => {
    render(<ModelsTab {...baseProps()} modelConfig={{ ...CONFIG, primary: 'moonshotai/kimi-k3' }} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('moonshotai/kimi-k3')
    expect(alert).toHaveTextContent('z-ai/glm-5.2')
    expect(alert).toHaveTextContent(/model\.default/)
  })

  it('no warning when model.default is row 0', async () => {
    render(<ModelsTab {...baseProps()} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Track latest follows the modelTracking prop after the cascade was rotated server-side', async () => {
    const props = baseProps()
    const { rerender } = render(<ModelsTab {...props} />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.2/i })).toHaveAttribute('aria-checked', 'true')
    // The apply route rotated glm-5.2 → 5.3 and moved the tracking key; the page refetched.
    const rotated = {
      ...CONFIG,
      primary: 'z-ai/glm-5.3',
      models: ['z-ai/glm-5.3', 'claude-sonnet-4-6', 'qwen3:30b'],
      fallbackProviders: [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, ...CONFIG.fallbackProviders.slice(1)],
    }
    rerender(<ModelsTab {...props} modelConfig={rotated} modelTracking={{ 'openrouter/z-ai/glm-5.3': true }} editorKey="h_test:1" />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.3/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('an in-app switch to another harness does not inherit the previous harness\'s tracking', async () => {
    const props = baseProps()
    const { rerender } = render(<ModelsTab {...props} />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.2/i })).toHaveAttribute('aria-checked', 'true')
    rerender(<ModelsTab {...props} harnessId="h_b" modelTracking={{}} editorKey="h_b:0" />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.2/i })).toHaveAttribute('aria-checked', 'false')
    // …and a harness with no modelTracking at all (undefined) resets too.
    rerender(<ModelsTab {...props} harnessId="h_c" modelTracking={undefined} editorKey="h_c:0" />)
    expect(screen.getByRole('switch', { name: /track latest for z-ai\/glm-5\.2/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('no report / no live data → editor still renders, without hints or badges', async () => {
    routes['GET /api/fleet/model-updates'] = { status: 500, body: { error: 'boom' } }
    routes['GET /api/models/live?provider=openrouter'] = { status: 204 }
    render(<ModelsTab {...baseProps()} />)
    await screen.findByRole('heading', { name: /saved cascades/i })
    expect(screen.getByText('z-ai/glm-5.2')).toBeInTheDocument()
    expect(screen.queryByText(/newer:/)).toBeNull()
    expect(screen.queryByText('retired')).toBeNull()
  })
})

describe('cascadeSaveConflict — how the page reads a 409 from PUT /models (round-3 audit)', () => {
  it('a primary-mismatch 409 carries the writer\'s message and keeps the edit', () => {
    const body = { error: 'primary-mismatch: model.default is "X" but fallback_providers[0] is "A"; put "X" at the top of the cascade before saving' }
    expect(cascadeSaveConflict(body)).toEqual({ kind: 'primary-mismatch', message: body.error })
  })

  it('any other 409 (expected_fallback_providers no longer matches) means reload', () => {
    expect(cascadeSaveConflict({ error: 'The model cascade changed since it was read; reload and try again' })).toEqual({ kind: 'stale' })
    expect(cascadeSaveConflict({})).toEqual({ kind: 'stale' })
    expect(cascadeSaveConflict(null)).toEqual({ kind: 'stale' })
  })
})
