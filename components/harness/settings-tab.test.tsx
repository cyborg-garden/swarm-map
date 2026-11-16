/**
 * Settings tab: the stored DM policy does not change who can DM an agent, so
 * the tab offers no control for it. A save still sends the stored value back
 * unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsTab } from './settings-tab'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('./tuning-card', () => ({ TuningCard: () => null }))
vi.mock('./chat-updates-card', () => ({ ChatUpdatesCard: () => null }))

const STORED = {
  dmPolicy: 'allow-all',
  groupInvitePolicy: 'approved-only',
  mentionGating: true,
  observeUnmentioned: true,
  commandApprovalAdminOnly: true,
  memoryScope: 'channel',
  vpnEnabled: false,
  capsolverConfigured: false,
  surfaces: {},
  version: 'v1',
}

let puts: Array<Record<string, unknown>>

beforeEach(() => {
  puts = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)))
      return { ok: true, status: 200, json: async () => ({ success: true, version: 'v2' }) }
    }
    return { ok: true, status: 200, json: async () => STORED }
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('SettingsTab', () => {
  it('offers no DM policy control', async () => {
    render(<SettingsTab harnessId="h_alpha" connectedSurfaces={[]} />)
    expect(await screen.findByText('Group Invite Policy')).toBeInTheDocument()
    expect(screen.queryByText(/DM Access Policy/)).toBeNull()
    expect(document.querySelector('input[name="dmPolicy"]')).toBeNull()
    // What does decide DMs is still explained.
    expect(screen.getByText(/DISCORD_DM_ALLOWED_USERS/)).toBeInTheDocument()
  })

  it('sends the stored DM policy back unchanged on save', async () => {
    render(<SettingsTab harnessId="h_alpha" connectedSurfaces={[]} />)
    await screen.findByText('Group Invite Policy')
    fireEvent.click(screen.getByLabelText('Allow all'))
    fireEvent.click(await screen.findByRole('button', { name: /save/i }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].dmPolicy).toBe('allow-all')
    expect(puts[0].groupInvitePolicy).toBe('allow-all')
  })
})
