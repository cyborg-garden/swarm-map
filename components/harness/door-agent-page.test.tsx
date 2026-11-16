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
import { modeOf, TOOL_ROWS, withMode } from './door-tools-card'
import { parseConfig, toolModes } from '@/lib/lab/pi-discord/config'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
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
  status: { state: 'stopped', cellSealed: null, rulesInForce: null },
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
let receipts: unknown[]
let requests: Array<{ url: string; method: string; body?: unknown }>
let fail: Record<string, { status: number; body: unknown }>

beforeEach(() => {
  current = view()
  receipts = RECEIPTS
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
    else if (url.startsWith('/api/harnesses/h_pi_one/door/receipts')) body = { receipts }
    else if (url.startsWith('/api/harnesses/h_pi_one/logs')) body = { logs: 'cell up and sealed', lines: 100, source: 'door' }
    else if (url === '/api/fleet/drift') body = { checkedAt: 0, agents: [] }
    else if (url === '/api/integrity') body = { harnesses: [] }
    else if (['/api/tools', '/api/keys', '/api/memory-scopes', '/api/surfaces', '/api/harnesses/retired'].includes(url)) body = []
    else if (method === 'GET') { status = 409; body = { error: 'not for a door agent' } }
    return { ok: status < 400, status, statusText: '', json: async () => body }
  }))
})
afterEach(() => vi.unstubAllGlobals())

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
    current = view({ status: { state: 'running', pid: 1, startedAt: '2026-11-16T12:00:00.000Z', cellSealed: true, sealCheckedAt: '2026-11-16T11:59:00.000Z', rulesInForce: true }, usage: { month: '2026-11', spentThisMonthUsd: 1.25, budgetMonthlyUsd: 5, costToday: null, invocations: null } })
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

  it('has a Tools card with every class off, and saves a class that is switched on with the rest of the rules', async () => {
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    const selects = within(card).getAllByRole('combobox') as HTMLSelectElement[]
    expect(selects.map((el) => [el.getAttribute('aria-label'), el.value, el.disabled])).toEqual([['Read files', 'never', false], ['Write files', 'never', false], ['Shell', 'never', false]])
    // Nothing asks yet, so there is no time to answer to set.
    expect(document.querySelector('input[name="tools.approvalSeconds"]')).toBeNull()
    fireEvent.change(within(card).getByRole('combobox', { name: 'Shell' }), { target: { value: 'ask' } })
    fireEvent.change(within(card).getByRole('combobox', { name: 'Read files' }), { target: { value: 'allow' } })
    fireEvent.change(document.querySelector('input[name="tools.approvalSeconds"]')!, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    expect((requests.find((r) => r.method === 'PUT')!.body as { rules: unknown }).rules).toEqual({
      ...RULES, tools: { enabled: ['file_read', 'shell'], mode: { shell: 'ask', file_read: 'allow' }, approvalSeconds: 90 },
    })
  })

  it('shows the tools a record has, and none as switchable for an agent that hears anyone in the channel', async () => {
    current = view()
    current.record.rules = { ...RULES, tools: { enabled: ['shell', 'file_write'], mode: { file_write: 'ask' }, approvalSeconds: 60 } } as typeof RULES
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    const values = () => (within(card).getAllByRole('combobox') as HTMLSelectElement[]).map((el) => [el.value, el.disabled])
    // Shell with no mode of its own asks: that is its default.
    expect(values()).toEqual([['never', false], ['ask', false], ['ask', false]])
    expect((document.querySelector('input[name="tools.approvalSeconds"]') as HTMLInputElement).value).toBe('60')
    fireEvent.click(screen.getByRole('switch', { name: 'Anyone in the channel' }))
    expect(values()).toEqual([['never', true], ['never', true], ['never', true]])
    expect(within(card).getByRole('note')).toHaveTextContent('hears anyone in the channel, so it gets no tools')
  })

  it('the Tools card reads a record the way the launcher does, and what it writes is a config the launcher takes', () => {
    const base = { agentId: 'pi-one', discord: RULES.discord, budget: RULES.budget, model: RULES.model }
    const cases = [undefined, { enabled: [], mode: {}, approvalSeconds: 120 }, { enabled: ['shell'], mode: {}, approvalSeconds: 120 },
      { enabled: ['shell', 'file_read', 'file_write'], mode: { shell: 'allow', file_read: 'never', file_write: 'ask' }, approvalSeconds: 30 },
      { enabled: [], mode: { shell: 'allow' }, approvalSeconds: 120 }]
    for (const tools of cases) {
      const config = parseConfig({ ...base, ...(tools ? { tools } : {}) }).config!
      for (const row of TOOL_ROWS) expect(modeOf(config.tools, row.key), JSON.stringify(tools)).toBe(toolModes(config)[row.key])
    }
    expect(TOOL_ROWS.map((r) => r.key).sort()).toEqual(Object.keys(toolModes(parseConfig(base).config!)).sort())
    // Every choice on the card, from every starting point, is a config the launcher accepts and reads back the same.
    for (const start of cases) for (const row of TOOL_ROWS) for (const mode of ['never', 'ask', 'allow'] as const) {
      const next = withMode(start as never, row.key, mode)
      const parsed = parseConfig({ ...base, tools: next })
      expect(parsed.errors).toEqual([])
      expect(toolModes(parsed.config!)[row.key]).toBe(mode)
    }
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

  it('shows approvals in the receipts: who asked, who answered, how it ended, and can show those alone', async () => {
    receipts = [
      { ts: '2026-11-16T10:00:09.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'tool', sender: '100000000000000003' }, verdict: 'allow', rule: 'priv.approval', why: 'An admin said yes, so the call runs.', note: 'tool=bash call=3fa9c1d2e4b6' },
      { ts: '2026-11-16T10:00:08.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'approval', sender: '100000000000000002' }, verdict: 'allow', rule: 'priv.approval', why: 'An admin answered.', note: 'answer=approve tool=bash call=3fa9c1d2e4b6' },
      { ts: '2026-11-16T10:00:07.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'approval', sender: '100000000000000003' }, verdict: 'deny', rule: 'priv.approval', why: 'Only an admin can answer a request to run a tool.', note: 'tool=bash call=3fa9c1d2e4b6' },
      { ts: '2026-11-16T10:00:06.000Z', agentId: 'pi-one', policyHash: 'h', event: { kind: 'tool', sender: '100000000000000003' }, verdict: 'ask', rule: 'priv.approval', why: 'shell tools need an admin\'s yes in the room.', note: 'tool=bash call=3fa9c1d2e4b6 request=555' },
      ...RECEIPTS,
    ]
    await openPage()
    await openTab('Receipts')
    await screen.findByText(/An admin said yes, so the call runs\./)
    const rows = () => screen.getAllByRole('row').slice(1)
    expect(rows()).toHaveLength(6)
    expect(rows()[1]).toHaveTextContent('approval · allow · answer from 100000000000000002')
    expect(rows()[2]).toHaveTextContent('approval · deny · answer from 100000000000000003')
    expect(rows()[3]).toHaveTextContent('tool · ask')
    expect(rows()[0]).toHaveTextContent('call=3fa9c1d2e4b6')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approvals only' }))
    expect(rows().map((r) => within(r).getAllByRole('cell')[2].textContent)).toEqual(Array(4).fill('priv.approval'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Approvals only' }))
    expect(rows()).toHaveLength(6)
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

  it('is left out of "Restart all running"', async () => {
    await rows()
    expect(screen.getByRole('button', { name: 'Restart all running (1)' })).toBeInTheDocument()
  })
})
