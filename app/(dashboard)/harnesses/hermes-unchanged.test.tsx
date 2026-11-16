/**
 * A Hermes agent looks exactly as it did before door agents existed.
 *
 * The two snapshots beside this file were taken on `main` before any door
 * code was written, from the fleet table and from the agent page of a Hermes
 * agent: the whole fleet table, and the whole agent page with the list of
 * things it asks the server for. If a change for another runtime moves
 * anything a Hermes agent shows, this fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen, act } from '@testing-library/react'
import HarnessesPage from './page'
import HarnessDetailPage from './[id]/page'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.setConfig({ testTimeout: 20000 })

const ALPHA = {
  id: 'h_alpha', name: 'alpha', runtime: 'hermes', status: 'running', tier: 'team', platform: 'discord', channel: 'general',
  persona: 'An example agent', models: ['provider/model-a'], tools: [], costToday: 1.5, invocations: 7, cpu: 3, mem: 120,
  lastSeen: 0, health: { errors: 0 },
}
// A row written before the `runtime` field existed is Hermes too.
const BETA = { ...ALPHA, id: 'h_beta', name: 'beta', runtime: undefined, status: 'stopped', costToday: null, invocations: null }
const DRIFT = { checkedAt: 0, agents: [{ harnessId: 'h_alpha', name: 'alpha', state: 'current', containerSha: null, sourceSha: null, commitsBehind: null, ageBehindMs: null, hotPatched: false, detail: null }] }

let fetched: string[]

beforeEach(() => {
  fetched = []
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url)
    let status = 200
    let body: unknown = {}
    if (url === '/api/harnesses') body = [ALPHA, BETA]
    else if (url === '/api/harnesses/h_alpha') body = ALPHA
    else if (url === '/api/fleet/drift') body = DRIFT
    else if (url === '/api/integrity') body = { harnesses: [] }
    else if (['/api/tools', '/api/keys', '/api/memory-scopes', '/api/surfaces', '/api/harnesses/retired'].includes(url)) body = []
    else { status = 404; body = { error: 'not in this test' } }
    return { ok: status < 400, status, statusText: '', json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('a Hermes agent is drawn as before', () => {
  it('in the fleet table', async () => {
    const { container } = render(<HarnessesPage />)
    await screen.findByText('alpha')
    await screen.findByText('up to date')
    // The table, whole: every Hermes row with its chips, figures and actions.
    expect(container.querySelector('table')!.outerHTML).toMatchSnapshot()
  })

  it('on its own page, and the page asks for the same things', async () => {
    const params = Promise.resolve({ id: 'h_alpha' })
    let container!: HTMLElement
    await act(async () => {
      container = render(<Suspense fallback={null}><HarnessDetailPage params={params} /></Suspense>).container
      await params
    })
    await screen.findByRole('tab', { name: /settings/i }, { timeout: 10000 })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(container.innerHTML).toMatchSnapshot()
    expect([...new Set(fetched)].sort()).toMatchSnapshot()
  })
})
