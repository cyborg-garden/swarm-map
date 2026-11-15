/**
 * Fleet page: Stop, Restart and "Restart all running" interrupt agents, so
 * each asks first. Nothing is sent until the operator confirms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import HarnessesPage from './page'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/fleet/retired-rows', () => ({ RetiredRows: () => null }))

const FLEET = [
  { id: 'h_alpha', name: 'alpha', status: 'running', tier: 'private', platform: 'discord', channel: 'general', models: ['m1'], costToday: 0, invocations: 0, health: { errors: 0 } },
  { id: 'h_beta', name: 'beta', status: 'running', tier: 'private', platform: 'discord', channel: 'general', models: ['m1'], costToday: 0, invocations: 0, health: { errors: 0 } },
]

let posts: string[]

beforeEach(() => {
  posts = []
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(url)
    const body = url === '/api/harnesses' ? FLEET : {}
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

const button = (name: string | RegExp, scope: HTMLElement = document.body) =>
  within(scope).getByRole('button', { name, hidden: true })

async function alphaRow() {
  render(<HarnessesPage />)
  const cell = await screen.findByText('alpha')
  return cell.closest('tr')!
}

describe('fleet table actions', () => {
  it('asks before stopping, and sends nothing if cancelled', async () => {
    fireEvent.click(button('Stop', await alphaRow()))
    expect(screen.getByText('Stop alpha?')).toBeInTheDocument()
    expect(posts).toEqual([])
    fireEvent.click(button('Cancel'))
    expect(screen.queryByText('Stop alpha?')).toBeNull()
    expect(posts).toEqual([])
  })

  it('stops the agent once confirmed', async () => {
    fireEvent.click(button('Stop', await alphaRow()))
    fireEvent.click(button('Stop', document.querySelector('dialog')!))
    await waitFor(() => expect(posts).toEqual(['/api/harnesses/h_alpha/stop']))
  })

  it('asks before restarting one agent', async () => {
    fireEvent.click(button('Restart', await alphaRow()))
    expect(screen.getByText('Restart alpha?')).toBeInTheDocument()
    expect(posts).toEqual([])
    fireEvent.click(button('Restart', document.querySelector('dialog')!))
    await waitFor(() => expect(posts).toEqual(['/api/harnesses/h_alpha/restart']))
  })

  it('asks before restarting every running agent, naming how many', async () => {
    await alphaRow()
    fireEvent.click(button(/Restart all running/))
    expect(screen.getByText('Restart 2 running agents?')).toBeInTheDocument()
    expect(posts).toEqual([])
    fireEvent.click(button('Restart all'))
    await waitFor(() => expect(posts).toEqual(['/api/harnesses/restart-running']))
  })
})
