/**
 * SavedCascades: the named cascade library under the editor. Apply goes
 * through POST /api/cascades/:name/apply (which restarts the harness itself —
 * the component must NOT also call /restart); Save as… snapshots the harness
 * cascade via POST /api/harnesses/:id/cascade/save-as, offering overwrite on
 * 409; rename and delete confirm before writing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SavedCascades } from './saved-cascades'
import { toast } from 'sonner'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

type Call = { url: string; init?: RequestInit }
let calls: Call[]
let responders: Array<(url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined>

const LIB = [
  { name: 'Cheap', entries: [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, { provider: 'ollama', model: 'qwen3:8b', base_url: 'http://x' }], createdAt: 1, updatedAt: 1 },
  { name: 'Frontier', entries: [{ provider: 'anthropic', model: 'claude-opus-4-7' }], createdAt: 2, updatedAt: 2, sourceHarness: 'h_iris' },
]

function installFetch() {
  calls = []
  responders = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    for (const r of responders) {
      const hit = r(url, init)
      if (hit) return { ok: hit.status < 400, status: hit.status, statusText: '', json: async () => hit.body ?? {} }
    }
    if (url === '/api/cascades' && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => LIB }
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }
  }))
}

function bodyOf(c: Call): Record<string, unknown> {
  return JSON.parse(String(c.init?.body ?? '{}'))
}

beforeEach(() => { installFetch() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('SavedCascades', () => {
  it('lists library entries compactly', async () => {
    render(<SavedCascades harnessId="h_test" />)
    const list = await screen.findByRole('list', { name: /saved cascades/i })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list).toHaveTextContent('Cheap')
    expect(list).toHaveTextContent('2 models')
    expect(list).toHaveTextContent('z-ai/glm-5.2')
    expect(list).toHaveTextContent('Frontier')
  })

  it('shows an empty state when the library is empty', async () => {
    responders.push((url, init) => (url === '/api/cascades' && !init?.method ? { status: 200, body: [] } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    expect(await screen.findByText(/no saved cascades/i)).toBeInTheDocument()
  })

  it('Apply posts {harnessId} to the apply route, never calls /restart, and toasts', async () => {
    const onApplied = vi.fn()
    responders.push((url, init) => (url === '/api/cascades/Cheap/apply' && init?.method === 'POST' ? { status: 200, body: { ok: true, name: 'Cheap', harness: 'h_test', applied: 2, restarted: true } } : undefined))
    render(<SavedCascades harnessId="h_test" onApplied={onApplied} />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /apply cheap/i }))
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1))
    const apply = calls.find((c) => c.url === '/api/cascades/Cheap/apply')!
    expect(bodyOf(apply)).toEqual({ harnessId: 'h_test' })
    expect(calls.some((c) => /\/restart$/.test(c.url))).toBe(false)
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/applied "cheap"/i))
  })

  it('Apply surfaces the 400 error text from the API', async () => {
    const onApplied = vi.fn()
    responders.push((url, init) => (url === '/api/cascades/Frontier/apply' && init?.method === 'POST' ? { status: 400, body: { error: 'No anthropic credential on this harness' } } : undefined))
    render(<SavedCascades harnessId="h_test" onApplied={onApplied} />)
    await screen.findByText('Frontier')
    fireEvent.click(screen.getByRole('button', { name: /apply frontier/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No anthropic credential on this harness'))
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('Save as… prompts for a name and posts to save-as', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  Nightly ')
    responders.push((url, init) => (url === '/api/harnesses/h_test/cascade/save-as' && init?.method === 'POST' ? { status: 201, body: { name: 'Nightly', entries: [], createdAt: 3, updatedAt: 3 } } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /save as/i }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/saved "nightly"/i)))
    const save = calls.find((c) => c.url === '/api/harnesses/h_test/cascade/save-as')!
    expect(bodyOf(save)).toEqual({ name: 'Nightly' })
    // The list is refetched after a save.
    expect(calls.filter((c) => c.url === '/api/cascades' && !c.init?.method).length).toBeGreaterThanOrEqual(2)
  })

  it('Save as… on 409 offers overwrite and retries with overwrite:true', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Cheap')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let n = 0
    responders.push((url, init) => {
      if (url !== '/api/harnesses/h_test/cascade/save-as' || init?.method !== 'POST') return undefined
      n += 1
      if (n === 1) return { status: 409, body: { error: 'A cascade named "Cheap" already exists' } }
      return { status: 201, body: { name: 'Cheap', entries: [], createdAt: 1, updatedAt: 9 } }
    })
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /save as/i }))
    await waitFor(() => expect(n).toBe(2))
    const saves = calls.filter((c) => c.url === '/api/harnesses/h_test/cascade/save-as')
    expect(bodyOf(saves[0])).toEqual({ name: 'Cheap' })
    expect(bodyOf(saves[1])).toEqual({ name: 'Cheap', overwrite: true })
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/already exists/i))
  })

  it('Save as… on 409 with overwrite declined does not retry', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Cheap')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    responders.push((url, init) => (url === '/api/harnesses/h_test/cascade/save-as' && init?.method === 'POST' ? { status: 409, body: { error: 'exists' } } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /save as/i }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(calls.filter((c) => c.url === '/api/harnesses/h_test/cascade/save-as')).toHaveLength(1)
  })

  it('Save as… cancelled at the prompt sends nothing', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /save as/i }))
    expect(calls.filter((c) => c.url.includes('save-as'))).toHaveLength(0)
  })

  it('Rename prompts with the current name and PUTs {name}', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Budget')
    responders.push((url, init) => (url === '/api/cascades/Cheap' && init?.method === 'PUT' ? { status: 200, body: { name: 'Budget' } } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Cheap')
    fireEvent.click(screen.getByRole('button', { name: /rename cheap/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/cascades/Cheap' && c.init?.method === 'PUT')).toBe(true))
    expect(window.prompt).toHaveBeenCalledWith(expect.any(String), 'Cheap')
    expect(bodyOf(calls.find((c) => c.url === '/api/cascades/Cheap' && c.init?.method === 'PUT')!)).toEqual({ name: 'Budget' })
  })

  it('Delete confirms first; declined → no request, accepted → DELETE', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    responders.push((url, init) => (url === '/api/cascades/Frontier' && init?.method === 'DELETE' ? { status: 200, body: { ok: true } } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('Frontier')
    fireEvent.click(screen.getByRole('button', { name: /delete frontier/i }))
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /delete frontier/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/cascades/Frontier' && c.init?.method === 'DELETE')).toBe(true))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('URL-encodes cascade names with spaces or slashes', async () => {
    responders.push((url, init) => (url === '/api/cascades' && !init?.method ? { status: 200, body: [{ name: 'my cascade/v2', entries: [{ provider: 'zai', model: 'glm-5' }], createdAt: 1, updatedAt: 1 }] } : undefined))
    render(<SavedCascades harnessId="h_test" />)
    await screen.findByText('my cascade/v2')
    fireEvent.click(screen.getByRole('button', { name: /apply my cascade\/v2/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/cascades/my%20cascade%2Fv2/apply')).toBe(true))
  })
})
