/**
 * The page of a door agent, and its row in the fleet table.
 *
 * It shows the four tabs that apply to it and none of the Hermes ones, asks
 * for nothing Hermes-specific once it knows what it is, shows a dash where
 * a figure is not known, and saves the rules with one button.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Suspense } from 'react'
import { cleanup, render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import HarnessDetailPage from '@/app/(dashboard)/harnesses/[id]/page'
import HarnessesPage from '@/app/(dashboard)/harnesses/page'
import { usd } from './door-agent-page'
import { commandsOf, mayChoose, modeOf, namesIn, TOOL_ROWS, withMode } from './door-tools-card'
import { DEFAULT_COMMANDS } from '@/lib/core/tools/command-policy'
import { parseConfig, statusOf, toolModes } from '@/lib/lab/pi-discord/config'
import { toast } from 'sonner'

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
let receipts: unknown[]
let requests: Array<{ url: string; method: string; body?: unknown }>
let fail: Record<string, { status: number; body: unknown }>
let answers: Record<string, unknown>

const native = { prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() }
const RUNNING = { state: 'running', pid: 1, startedAt: '2026-11-16T12:00:00.000Z', cellSealed: true, sealCheckedAt: '2026-11-16T11:59:00.000Z', rulesInForce: true, startedBy: 'page' }
const LETTA = { runtime: 'letta-code', label: 'Letta Code', version: '0.34.60', oneRoomOnly: true, limits: ['One room only. It keeps one memory for the whole agent, so it is given its one channel and no other for as long as its door runs.', 'No tools: it reads the messages it is sent and answers in text.', 'No direct messages.'] }

beforeEach(() => {
  nav.push.mockReset()
  window.history.replaceState({}, '', '/harnesses/h_pi_one')
  for (const [name, spy] of Object.entries(native)) { spy.mockReset(); vi.stubGlobal(name, spy) }
  current = view()
  receipts = RECEIPTS
  requests = []
  fail = {}
  answers = {}
  vi.mocked(toast.success).mockClear()
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    let status = 200
    let body: unknown = {}
    if (fail[`${method} ${url}`]) ({ status, body } = fail[`${method} ${url}`])
    else if (answers[`${method} ${url}`]) body = answers[`${method} ${url}`]
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
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Rules', 'Memory', 'Receipts', 'Logs'])
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

  it('says how many cells hold the agent: one, or two with the second for the channels with fewer tools', async () => {
    await openPage()
    expect(screen.getByText('Cells').parentElement).toHaveTextContent(/^Cellsone$/)
    cleanup()
    current = view({ status: { ...RUNNING, secondCell: { channels: 2 } } })
    await openPage()
    expect(screen.getByText('Cells').parentElement).toHaveTextContent('two: the agent\'s own, and a second with no shell or file tools for the 2 channels with fewer tools')
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

  it('adds a channel beside its own, open to anyone with the web only, and saves what the launcher takes', async () => {
    await openPage()
    await openTab('Rules')
    await screen.findByRole('button', { name: 'Save' })
    expect(screen.queryAllByTestId('other-channel')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Add a channel' }))
    fireEvent.change(document.querySelector('input[name="discord.channelIds.1"]')!, { target: { value: '100000000000000009' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Anyone in this channel' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Tools in this channel' }), { target: { value: 'web-only' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    const rules = (requests.find((r) => r.method === 'PUT')!.body as { rules: typeof RULES }).rules
    expect(rules.discord).toEqual({
      ...RULES.discord, channelIds: ['100000000000000001', '100000000000000009'],
      perChannel: { '100000000000000009': { anyoneInChannel: true, tools: 'web-only' } },
    })
    expect(parseConfig({ ...rules, agentId: 'pi-one' }).errors).toEqual([])
  })

  it('removing the last other channel saves the record as it was, with one channel', async () => {
    current = view()
    current.record.rules = { ...RULES, discord: { ...RULES.discord, channelIds: ['100000000000000001', '100000000000000009'] } } as typeof RULES
    await openPage()
    await openTab('Rules')
    await screen.findByRole('button', { name: 'Save' })
    expect(screen.getAllByTestId('other-channel')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove channel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    expect((requests.find((r) => r.method === 'PUT')!.body as { rules: unknown }).rules).toEqual(RULES)
  })

  it('shows status reactions and typing on for a record that never named them, and saves one switched off', async () => {
    await openPage()
    await openTab('Rules')
    const reactions = await screen.findByRole('switch', { name: 'Status reactions' })
    const typing = screen.getByRole('switch', { name: 'Typing indicator' })
    expect([reactions.getAttribute('aria-checked'), typing.getAttribute('aria-checked')]).toEqual(['true', 'true'])
    fireEvent.click(typing)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    const rules = (requests.find((r) => r.method === 'PUT')!.body as { rules: typeof RULES }).rules
    expect(rules).toEqual({ ...RULES, discord: { ...RULES.discord, typing: false } })
    // What the page saves is a config the launcher takes, and it reads as typing off, reactions on.
    expect(parseConfig({ ...rules, agentId: 'pi-one' }).config?.discord).toMatchObject({ typing: false })
    expect(statusOf(parseConfig({ ...rules, agentId: 'pi-one' }).config!)).toEqual({ reactions: true, typing: false })
  })

  it('has a Tools card with every class off, and saves a class that is switched on with the rest of the rules', async () => {
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    const selects = (within(card).getAllByRole('combobox') as HTMLSelectElement[]).filter((el) => !el.name.startsWith('tools.web.'))
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
    const values = () => ((within(card).getAllByRole('combobox') as HTMLSelectElement[]).filter((el) => !el.name.startsWith('tools.web.'))).map((el) => [el.value, el.disabled])
    // Shell with no mode of its own asks: that is its default.
    expect(values()).toEqual([['never', false], ['ask', false], ['ask', false]])
    // While the shell asks, file writing cannot be set to allow: an admin would approve a script's name, not what is in it.
    const allowWrite = within(within(card).getByRole('combobox', { name: 'Write files' })).getByRole('option', { name: 'Allow' }) as HTMLOptionElement
    expect(allowWrite.disabled).toBe(true)
    expect(card).toHaveTextContent('While the shell asks, writing files asks too')
    expect(card).toHaveTextContent('A yes to a shell command is a yes to whatever it leaves behind in the cell')
    expect((document.querySelector('input[name="tools.approvalSeconds"]') as HTMLInputElement).value).toBe('60')
    fireEvent.click(screen.getByRole('switch', { name: 'Anyone in the channel' }))
    expect(values()).toEqual([['never', true], ['never', true], ['never', true]])
    expect(within(card).getByRole('note')).toHaveTextContent('hears anyone in the channel, so it gets no tools')
  })

  it('shows the shell\'s command lists, shipped by default, and saves an edited list with the rest of the rules', async () => {
    current = view()
    current.record.rules = { ...RULES, tools: { enabled: ['shell'], mode: {}, approvalSeconds: 60 } } as typeof RULES
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    const lists = within(card).getByTestId('door-command-lists')
    const allow = lists.querySelector('textarea[name="tools.commands.allow"]') as HTMLTextAreaElement
    const block = lists.querySelector('textarea[name="tools.commands.block"]') as HTMLTextAreaElement
    expect(allow.value).toBe(DEFAULT_COMMANDS.allow.join(' '))
    expect(block.value).toBe(DEFAULT_COMMANDS.block.join(' '))
    expect(lists).toHaveTextContent('Ask an admin: every other command')
    fireEvent.change(allow, { target: { value: 'ls, cat  grep' } })
    fireEvent.blur(allow)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true))
    expect((requests.find((r) => r.method === 'PUT')!.body as { rules: { tools: unknown } }).rules.tools).toEqual({
      enabled: ['shell'], mode: {}, approvalSeconds: 60, commands: { allow: ['ls', 'cat', 'grep'], block: DEFAULT_COMMANDS.block },
    })
  })

  it('has no command lists while the shell is off', async () => {
    current = view()
    current.record.rules = { ...RULES, tools: { enabled: ['file_read'], mode: {}, approvalSeconds: 60 } } as typeof RULES
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    expect(within(card).queryByTestId('door-command-lists')).toBeNull()
  })

  it('the card\'s shipped lists are the launcher\'s, and an edited list is a config the launcher takes', () => {
    expect(commandsOf(undefined)).toEqual(DEFAULT_COMMANDS)
    expect(namesIn(' ls,cat\n grep ')).toEqual(['ls', 'cat', 'grep'])
    const base = { agentId: 'pi-one', discord: RULES.discord, budget: RULES.budget, model: RULES.model }
    const edited = { enabled: ['shell'], mode: {}, approvalSeconds: 60, commands: { allow: namesIn('ls cat'), block: namesIn('dd') } }
    expect(parseConfig({ ...base, tools: edited }).errors).toEqual([])
    expect(parseConfig({ ...base, tools: { ...edited, commands: { allow: ['sh'], block: [] } } }).errors.join()).toMatch(/sh runs other commands/)
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
      // The one choice the card does not offer: file writing allowed while the shell asks. The launcher refuses it too.
      if (!mayChoose(start as never, row.key, mode)) {
        expect(parseConfig({ ...base, tools: { ...withMode(start as never, row.key, mode), mode: { ...withMode(start as never, row.key, mode).mode, file_write: 'allow' } } }).errors[0]).toMatch(/^tools\.mode\.file_write: with shell set to ask/)
        continue
      }
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

describe('what the page says a start or a save did, when pm2 runs the door', () => {
  it('a start handed to pm2 says pm2 is running it, and names the app', async () => {
    answers['POST /api/harnesses/h_pi_one/start'] = { ok: true, by: 'supervisor', supervisor: 'door-pi-one' }
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('The cell was checked, and pm2 started the door (door-pi-one)'))
  })

  it('a start by the page says so as before', async () => {
    answers['POST /api/harnesses/h_pi_one/start'] = { ok: true, by: 'page' }
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('The cell was checked and the door is starting'))
  })

  it('a save that pm2 applied says pm2 restarted the door, and names the app', async () => {
    answers['PUT /api/harnesses/h_pi_one/door/rules'] = { applied: 'restarted', by: 'supervisor', supervisor: 'door-pi-one', record: current.record }
    await openPage()
    await openTab('Rules')
    fireEvent.change(document.querySelector('input[name="discord.botLoopLimit"]')!, { target: { value: '2' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved. pm2 restarted the door (door-pi-one) on the new rules'))
  })

  it('says on the Overview that Start and Save go through pm2 once it runs the door', async () => {
    await openPage()
    expect(screen.getByText(/Start and Save on this page then go through pm2/)).toBeInTheDocument()
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
    // It is what Swarm Map knows, and no more: a door it started before it kept such a note is shown this way too.
    ['elsewhere', /Swarm Map has no note that it started this door, and saw no supervisor\. Whatever started it decides whether it is started again/],
  ])('says who started a running door: %s', async (startedBy, says) => {
    current = view({ status: { ...RUNNING, startedBy } })
    await openPage()
    expect(row('Started by')).toHaveTextContent(says)
    // It never says a flat "not this page": that is more than it knows.
    expect(row('Started by')).not.toHaveTextContent('not this page')
    for (const [other, text] of [['page', 'this page, as'], ['supervisor', 'a supervisor.']] as const) {
      if (other !== startedBy) expect(row('Started by')).not.toHaveTextContent(text)
    }
  })
})

describe('a Letta Code agent behind a door', () => {
  beforeEach(() => { current = view({ harness: LETTA, record: { ...view().record, runtime: 'letta-code' } }) })

  it('has its Tools card switched off, and says tools are built for the other harness', async () => {
    await openPage()
    await openTab('Rules')
    const card = await screen.findByTestId('door-tools-card')
    expect(((within(card).getAllByRole('combobox') as HTMLSelectElement[]).filter((el) => !el.name.startsWith('tools.web.'))).map((el) => [el.value, el.disabled])).toEqual([['never', true], ['never', true], ['never', true]])
    expect(within(card).getByRole('note')).toHaveTextContent('Tools are built for Pi only')
  })

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
    // And it is offered no other channel.
    expect(screen.queryByRole('button', { name: 'Add a channel' })).toBeNull()
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
