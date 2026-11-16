/**
 * The home page's daily totals beside a door agent.
 *
 * A door agent keeps no daily cost and no call count. It adds nothing to the
 * two totals, and the cards say that it was left out. With Hermes agents
 * only, the cards carry no such line.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import DashboardPage from './page'

const HERMES = {
  id: 'h_alpha', name: 'alpha', runtime: 'hermes', status: 'running', tier: 'team', platform: 'discord', channel: 'general',
  persona: 'An example agent', models: [], tools: [], costToday: 1.5, invocations: 7, cpu: 0, mem: 0, lastSeen: 0, health: { errors: 0 },
}
const DOOR = { ...HERMES, id: 'h_pi_one', name: 'pi-one', runtime: 'pi', costToday: null, invocations: null }

function serve(fleet: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const known: Record<string, unknown> = {
      '/api/harnesses': fleet, '/api/audit': [], '/api/health/docker': { available: true }, '/api/fleet/drift': { checkedAt: 0, agents: [] },
    }
    const ok = url in known
    return { ok, status: ok ? 200 : 404, statusText: '', json: async () => known[url] ?? {} }
  }))
}
afterEach(() => vi.unstubAllGlobals())

describe('the daily totals on the home page', () => {
  it('say when a door agent is not counted, and never count it as $0', async () => {
    serve([HERMES, DOOR])
    render(<DashboardPage />)
    expect((await screen.findAllByText('$1.50')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('not counting 1 door agent: no daily figure is kept for it')).toHaveLength(2)
  })

  it('carry no such line for Hermes agents alone', async () => {
    serve([HERMES, { ...HERMES, id: 'h_beta', name: 'beta', costToday: null, invocations: null }])
    render(<DashboardPage />)
    expect((await screen.findAllByText('$1.50')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/not counting/)).toBeNull()
  })
})
