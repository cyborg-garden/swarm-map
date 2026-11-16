/**
 * The page of a door agent, and its row in the fleet table.
 *
 * It shows the four tabs that apply to it and none of the Hermes ones, asks
 * for nothing Hermes-specific once it knows what it is, shows a dash where
 * a figure is not known, and saves the rules with one button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import HarnessDetailPage from '@/app/(dashboard)/harnesses/[id]/page'
import HarnessesPage from '@/app/(dashboard)/harnesses/page'
import { usd } from './door-agent-page'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() } }))
const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))
vi.setConfig({ testTimeout: 20000 })

const ROW = {
  id: 'h_pi_one', name: 'pi-one', runtime: 'pi', status: 'stopped', tier: 'team', platform: 'discord', channel: '100000000000000001',
  persona: 'Answers questions.', models: ['provider/model-a'], tools: [], costToday: null, invocations: null, cpu: 0, mem: 0, lastSeen: 0, health: { errors: 0 },
}
const HERMES = { ...ROW, id: 'h_alpha', name: 'alpha', runtime: 'hermes', status: 'running', costToday: 0, invocations: 0 }
const RULES = {
  agentId: 'pi-one', persona: { name: 'Pi', description: 'Answers questions.' },
  discord: {
    guildId: '100000000000000000', channelId: '100000000000000001', adminUserIds: ['100000000000000002'], allowedUserIds: [], allowedRoleIds: [],
    anyoneInChannel: false, mentionRequired: true, bots: 'none', allowedBotIds: [], botLoopLimit: 4, readAllMessages: false,
  },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'provider/model-a', usdPerMTokIn: 1, usdPerMTokOut: 5 },
}
const view = (over: Record<string, unknown> = {}) => ({
  record: { schema: 1, id: 'h_pi_one', name: 'pi-one', runtime: 'pi', version: 3, updatedAt: '2026-11-16T12:00:00.000Z', rules: RULES, secrets: { discordTokenFile: '/keys/token', modelKeyFile: '/keys/key' } },
  status: { state: 'stopped', cellSealed: null, rulesInForce: null, startedBy: null },
  harness: { runtime: 'pi', label: 'Pi', version: '1.5.2', oneRoomOnly: false, limits: ['It keeps no memory of its own. It remembers a conversation only until it is restarted.', 'No tools: it reads the messages it is sent and answers in text.', 'No direct messages.'] },
  usage: { month: '2026-11', spentThisMonthUsd: null, budgetMonthlyUsd: 5, costToday: null, invocations: null },
  dryRun: null,
  problems: { rules: [], secrets: [] },
  supervisor: { command: "pm2 start '/data/door-agents/h_pi_one/start.sh' --name 'door-pi-one'", startScript: '/data/door-agents/h_pi_one/start.sh' },
  ...over,
})
const RECEIPTS = [
  { ts: '2026-11-16T10:00:03.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'inbound' }, verdict: 'drop', rule: 'adm.users', why: 'The sender is not on the list.' },
  { ts: '2026-11-16T10:00:01.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'inbound' }, verdict: 'deliver', rule: 'addr.mention', why: 'A listed person mentioned the bot.' },
]

let current: ReturnType<typeof view>
let requests: Array<{ url: string; method: string; body?: unknown }>
let fail: Record<string, { status: number; body: unknown }>

const native = { prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() }
const RUNNING = { state: 'running', pid: 1, startedAt: '2026-11-16T12:00:00.000Z', cellSealed: true, sealCheckedAt: '2026-11-16T11:59:00.000Z', rulesInForce: true, startedBy: 'page' }
const LETTA = { runtime: 'letta-code', label: 'Letta Code', version: '0.34.60', oneRoomOnly: true, limits: ['One room only. It keeps one memory for the whole agent, so it is given its one channel and no other for as long as its door runs.', 'No tools: it reads the messages it is sent and answers in text.', 'No direct messages.'] }

beforeEach(() => {
  nav.push.mockReset()
  window.history.replaceState({}, '', '/harnesses/h_pi_one')
  for (const [name, spy] of Object.entries(native)) { spy.mockReset(); vi.stubGlobal(name, spy) }
  current = view()
  requests = []
  fail = {}
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    let status = 200
    let body: unknown = {}
    if (fail[`${method} ${url}`]) ({ status, body } = fail[`${method} ${url}`])
    else if (url === '/api/harnesses') body = [HERMES, { ...ROW, status: 'running' }]
    else if (url === '/api/harnesses/h_pi_one') body = ROW
    else if (url === '/api/harnesses/h_pi_one/door') body = current
    else if (url === '/api/harnesses/h_pi_one/door/rules') body = { applied: 'stored', record: current.record }
    else if (url.startsWith('/api/harnesses/h_pi_one/door/receipts')) body = { receipts: RECEIPTS }
    else if (url.startsWith('/api/harnesses/h_pi_one/logs')) body = { logs: 'cell up and sealed', lines: 100, source: 'door' }
    else if (url === '/api/fleet/drift') body = { checkedAt: 0, agents: [] }
    else if (url === '/api/integrity') body = { harnesses: [] }
    else if (['/api/tools', '/api/keys', '/api/memory-scopes', '/api/surfaces', '/api/harnesses/retired'].includes(url)) body = []
    else if (method === 'GET') { status = 409; body = { error: 'not for a door agent' } }
    return { ok: status < 400, status, statusText: '', json: async () => body }
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  // Nothing on a door agent's page, or in its fleet row, asks through the browser's own pop-ups.
  for (const spy of Object.values(native)) expect(spy).not.toHaveBeenCalled()
})

async function openPage() {
  const params = Promise.resolve({ id: 'h_pi_one' })
  await act(async () => {
    render(<Suspense fallback={null}><HarnessDetailPage params={params} /></Suspense>)
    await params
  })
  await screen.findByRole('tab', { name: 'Rules' }, { timeout: 10000 })
}
async function openTab(name: string) {
  const tab = screen.getByRole('tab', { name })
  fireEvent.mouseDown(tab)
  fireEvent.click(tab)
}

describe('the page of a door agent', () => {
  it('shows the four tabs that apply, and none of the others', async () => {
    await openPage()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Rules', 'Receipts', 'Logs'])
    expect(screen.getByText('Pi · door')).toBeInTheDocument()
    expect(screen.queryByText('Quick Restart')).toBeNull()
    expect(screen.queryByText('Duplicate')).toBeNull()
  })

  it('asks the server only for what applies to a door agent', async () => {
    await openPage()
    await openTab('Receipts')
    await openTab('Logs')
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect([...new Set(requests.map((r) => r.url))].sort()).toEqual([
      '/api/harnesses/h_pi_one',
      '/api/harnesses/h_pi_one/door',
      '/api/harnesses/h_pi_one/door/receipts?last=100',
      '/api/harnesses/h_pi_one/logs?lines=100',
    ])
  })

  it('shows the door\'s status, the model, and a dash for spend it does not know', async () => {
    await openPage()
    const row = (label: string) => screen.getByText(label).parentElement!
    expect(row('Door')).toHaveTextContent('stopped')
    expect(row('Cell sealed')).toHaveTextContent('not checked yet')
    expect(row('Model')).toHaveTextContent('provider/model-a')
    expect(row('Spent this month')).toHaveTextContent('—')
    expect(row('Spent this month')).not.toHaveTextContent('$0')
    expect(row('Monthly limit')).toHaveTextContent('$5.00')
    expect(row('Cost today')).toHaveTextContent('—')
  })

  it('says yes or no about the cell only from a dry run', async () => {
    current = view({ status: { state: 'running', pid: 1, startedAt: '2026-11-16T12:00:00.000Z', cellSealed: true, sealCheckedAt: '2026-11-16T11:59:00.000Z', rulesInForce: true, startedBy: 'page' }, usage: { month: '2026-11', spentThisMonthUsd: 1.25, budgetMonthlyUsd: 5, costToday: null, invocations: null } })
    await openPage()
    expect(screen.getByText('Cell sealed').parentElement).toHaveTextContent(/^Cell sealedyes \(checked/)
    expect(screen.getByText('Spent this month').parentElement).toHaveTextContent('$1.25')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('writes money as a dash when unknown and as a figure when known, zero included', () => {
    expect(usd(null)).toBe('—')
    expect(usd(undefined)).toBe('—')
    expect(usd(0)).toBe('$0.00')
    expect(usd(1.255)).toBe('$1.25')
  })

  it('lists what still stands between a draft and a start, with the runbook', async () => {
    current = view({ problems: { rules: ['discord.guildId: must be a Discord id (digits only, in quotes)'], secrets: ['The bot token file is not set. Give the path of a file that holds the secret'] } })
    await openPage()
    expect(screen.getByText(/discord\.guildId/)).toBeInTheDocument()
    expect(screen.getByText(/bot token file is not set/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'The runbook' })[0]).toHaveAttribute('href', expect.stringContaining('docs/lab/pi-discord.md'))
  })

  it('saves the whole record with one button, against the version it loaded', async () => {
    await openPage()
    await openTab('Rules')
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(screen.getAllByRole('button', { name: /^Sav/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('switch', { name: 'Anyone in the channel' }))
    fireEvent.change(document.querySelector('input[name="discord.botLoopLimit"]')!, { target: { value: '2' } })
    fireEvent.click(save)
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    const put = requests.find((r) => r.method === 'PUT')!
    expect(put.url).toBe('/api/harnesses/h_pi_one/door/rules')
    expect(put.body).toEqual({
      rules: { ...RULES, discord: { ...RULES.discord, anyoneInChannel: true, botLoopLimit: 2 } },
      secrets: { discordTokenFile: '/keys/token', modelKeyFile: '/keys/key' },
      version: 3,
    })
  })

  it('shows every reason a save was refused', async () => {
    fail['PUT /api/harnesses/h_pi_one/door/rules'] = { status: 422, body: { error: 'Not saved. The rules were refused', details: ['budget.monthlyUsd: must be a number above 0'] } }
    await openPage()
    await openTab('Rules')
    fireEvent.change(document.querySelector('input[name="budget.monthlyUsd"]')!, { target: { value: '0' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Not saved. The rules were refused')
    expect(alert).toHaveTextContent('budget.monthlyUsd: must be a number above 0')
  })

  it('has fields for the two secret paths, and none for a secret', async () => {
    await openPage()
    await openTab('Rules')
    await screen.findByRole('button', { name: 'Save' })
    expect(document.querySelector('input[name="secrets.discordTokenFile"]')).toHaveValue('/keys/token')
    expect(document.querySelector('input[name="secrets.modelKeyFile"]')).toHaveValue('/keys/key')
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
    const names = [...document.querySelectorAll('input[name]')].map((i) => i.getAttribute('name'))
    expect(names.filter((n) => /token|key|secret/i.test(n!))).toEqual(['secrets.discordTokenFile', 'secrets.modelKeyFile'])
  })

  it('shows the receipts newest first, each with its plain reason', async () => {
    await openPage()
    await openTab('Receipts')
    await screen.findByText('The sender is not on the list.')
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[2].textContent)).toEqual(['adm.users', 'addr.mention'])
    expect(rows[1]).toHaveTextContent('A listed person mentioned the bot.')
  })

  it('shows the door\'s log', async () => {
    await openPage()
    await openTab('Logs')
    expect(await screen.findByText('cell up and sealed')).toBeInTheDocument()
  })

  it('shows why a start was refused', async () => {
    fail['POST /api/harnesses/h_pi_one/start'] = { status: 422, body: { error: 'Not started. The dry run did not end "ready to start"', details: ['FAIL  S1   only the door answers'] } }
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('FAIL S1 only the door answers')
  })
})

describe('what the Overview says about the door, plainly', () => {
  const row = (label: string) => screen.getByText(label).parentElement!

  it('names the harness and the one version that is pinned', async () => {
    await openPage()
    expect(row('Harness')).toHaveTextContent('Pi 1.5.2, pinned')
  })

  it('says when the seal was last checked, and that it never was when it never was', async () => {
    await openPage()
    expect(row('Cell sealed')).toHaveTextContent('not checked yet. It is checked at every Start')
  })

  it('a failed check is a no with its time, never a yes', async () => {
    current = view({ status: { state: 'stopped', cellSealed: false, sealCheckedAt: '2026-11-16T11:59:00.000Z', rulesInForce: null, startedBy: null } })
    await openPage()
    expect(row('Cell sealed')).toHaveTextContent(/^Cell sealedno \(checked/)
  })

  it('says whether the rules in force are the ones on record', async () => {
    current = view({ status: RUNNING })
    await openPage()
    expect(row('Rules in force')).toHaveTextContent('the rules on record')
  })

  it('says so when the door runs on older rules than the record', async () => {
    current = view({ status: { ...RUNNING, rulesInForce: false } })
    await openPage()
    expect(row('Rules in force')).toHaveTextContent('older rules than the ones on record')
    expect(row('Rules in force')).not.toHaveTextContent('the rules on record.')
  })

  it('says nothing about rules in force, or who started it, while the door is stopped', async () => {
    await openPage()
    expect(screen.queryByText('Rules in force')).toBeNull()
    expect(screen.queryByText('Started by')).toBeNull()
  })

  it.each([
    ['page', /this page, as a background process\. Nothing restarts it if it exits/],
    ['supervisor', /a supervisor\. It is started again if it exits with an error/],
    ['elsewhere', /not this page/],
  ])('says who started a running door: %s', async (startedBy, says) => {
    current = view({ status: { ...RUNNING, startedBy } })
    await openPage()
    expect(row('Started by')).toHaveTextContent(says)
    for (const [other, text] of [['page', 'this page, as'], ['supervisor', 'a supervisor.']] as const) {
      if (other !== startedBy) expect(row('Started by')).not.toHaveTextContent(text)
    }
  })
})

describe('a Letta Code agent behind a door', () => {
  beforeEach(() => { current = view({ harness: LETTA, record: { ...view().record, runtime: 'letta-code' } }) })

  it('shows its harness in the badge and on the Overview', async () => {
    const original = ROW.runtime
    ROW.runtime = 'letta-code'
    try {
      await openPage()
      expect(screen.getByText('Letta Code · door')).toBeInTheDocument()
      expect(screen.getByText('Harness').parentElement).toHaveTextContent('Letta Code 0.34.60, pinned')
      expect(screen.getByText(/One room only/)).toBeInTheDocument()
    } finally { ROW.runtime = original }
  })

  it('its Rules tab says plainly, beside the channel, that it has that one room only', async () => {
    await openPage()
    await openTab('Rules')
    const channel = document.querySelector('input[name="discord.channelId"]')!
    const note = document.getElementById(channel.getAttribute('aria-describedby')!.split(' ').at(-1)!)!
    expect(note).toHaveTextContent(/One room only\. It keeps one memory for the whole agent/)
  })

  it('a Pi agent\'s Rules tab says no such thing', async () => {
    current = view()
    await openPage()
    await openTab('Rules')
    await screen.findByRole('button', { name: 'Save' })
    expect(screen.queryByText(/One room only/)).toBeNull()
    // No note at all beside the channel: not the one-room note, and not some other limit dressed as it.
    expect(document.querySelector('input[name="discord.channelId"]')).not.toHaveAttribute('aria-describedby')
    expect(document.querySelector('input[name="discord.channelId"]')!.closest('div')!.querySelectorAll('p')).toHaveLength(0)
  })
})

describe('arriving, stopping and removing', () => {
  it('opens on the Rules tab when the address asks for it, as it does after an agent is made', async () => {
    window.history.replaceState({}, '', '/harnesses/h_pi_one?tab=rules')
    await openPage()
    expect(screen.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('opens on the Overview otherwise, and for a tab that does not exist', async () => {
    window.history.replaceState({}, '', '/harnesses/h_pi_one?tab=secrets')
    await openPage()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    // And the Overview is what is drawn, not an empty page.
    expect(screen.getByText('Cell sealed')).toBeInTheDocument()
  })

  const dialog = () => document.querySelector('dialog[aria-labelledby]') as HTMLElement

  it('asks before removing, in the app\'s own dialog, and removes nothing if cancelled', async () => {
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('Remove pi-one?')).toBeInTheDocument()
    expect(dialog()).toHaveTextContent('The two secret files are left where they are')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel', hidden: true }))
    expect(screen.queryByText('Remove pi-one?')).toBeNull()
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([])
  })

  it('removes it once confirmed, and goes back to the fleet', async () => {
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/harnesses'))
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([{ url: '/api/harnesses/h_pi_one', method: 'DELETE', body: undefined }])
  })

  it('asks before stopping a running door, and stops it only once confirmed', async () => {
    current = view({ status: RUNNING })
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText('Stop pi-one?')).toBeInTheDocument()
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([])
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Stop', hidden: true }))
    await waitFor(() => expect(requests.filter((r) => r.method !== 'GET')).toEqual([{ url: '/api/harnesses/h_pi_one/stop', method: 'POST', body: undefined }]))
  })
})

describe('a door agent in the fleet table', () => {
  async function rows() {
    render(<HarnessesPage />)
    const door = (await screen.findByText('pi-one')).closest('tr')!
    const hermes = screen.getByText('alpha').closest('tr')!
    await waitFor(() => expect(within(hermes).queryByText('build unknown')).toBeInTheDocument())
    return { door, hermes }
  }

  it('is a row with a runtime badge, its model and a dash for cost', async () => {
    const { door, hermes } = await rows()
    expect(within(door).getByText('Pi · door')).toBeInTheDocument()
    expect(door).toHaveTextContent('provider/model-a')
    const cells = within(door).getAllByRole('cell')
    expect(cells[4].textContent).toBe('—')
    expect(cells[5].textContent).toBe('—')
    expect(within(hermes).queryByText(/door/)).toBeNull()
  })

  it('is not marked as an unknown build, and has no action that does not apply', async () => {
    const { door } = await rows()
    expect(within(door).queryByText('build unknown')).toBeNull()
    expect(within(door).queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(within(door).queryByTitle('Duplicate')).toBeNull()
    expect(within(door).getByTitle('Remove')).toBeInTheDocument()
    expect(within(door).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('is removed only after the app\'s own dialog is confirmed', async () => {
    const { door } = await rows()
    fireEvent.click(within(door).getByTitle('Remove'))
    expect(screen.getByText('Remove pi-one?')).toBeInTheDocument()
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([])
    const dialog = document.querySelector('dialog[aria-labelledby]') as HTMLElement
    expect(dialog).toHaveTextContent('The two secret files are left where they are')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(requests.filter((r) => r.method !== 'GET')).toEqual([{ url: '/api/harnesses/h_pi_one', method: 'DELETE', body: undefined }]))
  })

  it('is left out of "Restart all running"', async () => {
    await rows()
    expect(screen.getByRole('button', { name: 'Restart all running (1)' })).toBeInTheDocument()
  })
})
