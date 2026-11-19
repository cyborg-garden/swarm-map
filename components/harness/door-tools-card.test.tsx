// The Tools card's web part: the allowlist, the suggested sites as one-click chips, and the mode.
// What the choices mean is the launcher's: every change the card makes is put through its parser.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SUGGESTED_WEB } from '@/lib/core/tools/web'
import { parseConfig, policyFor, type LabConfig, type ToolsConfig } from '@/lib/lab/pi-discord/config'
import { DoorToolsCard, withWeb } from './door-tools-card'

const RULES = parseConfig({
  agentId: 'pi-one',
  discord: { guildId: '700000000000000001', channelId: '710000000000000001', adminUserIds: ['800000000000000001'] },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 5 },
}).config as LabConfig

function renderCard(rules: LabConfig = RULES, builtFor?: string) {
  const onChange = vi.fn<(tools: ToolsConfig) => void>()
  render(<DoorToolsCard rules={rules} builtFor={builtFor} onChange={onChange} />)
  return { onChange, web: screen.getByTestId('door-web') }
}

describe('Tools card: web pages', () => {
  it('is off by default, with the suggested sites offered as chips and none switched on', () => {
    const { web } = renderCard()
    expect(within(web).queryByRole('list', { name: 'Allowed sites' })).toBeNull()
    expect((document.querySelector('select[name="tools.web.mode"]') as HTMLSelectElement).value).toBe('off')
    expect(document.querySelector('select[name="tools.web.approval"]')).toBeNull()
    expect((document.querySelector('input[name="tools.web.search"]') as HTMLInputElement).checked).toBe(false)
    const chips = within(web).getAllByRole('button', { name: /^\+ / })
    expect(chips.map((c) => c.textContent)).toEqual(SUGGESTED_WEB.map((s) => `+ ${s.label}`))
  })

  it('a chip adds its sites, and the launcher takes what the card wrote', () => {
    const { web, onChange } = renderCard()
    fireEvent.click(within(web).getByRole('button', { name: '+ Wikipedia (English)' }))
    const tools = onChange.mock.calls[0][0]
    expect(tools.web).toEqual({ allow: ['en.wikipedia.org'] })
    const parsed = parseConfig({ ...RULES, tools })
    expect(parsed.errors).toEqual([])
    expect(policyFor(parsed.config!).tools.allow).toEqual(['network'])
  })

  it('every chip, all at once, is a list the launcher takes', () => {
    const tools = withWeb(undefined, { allow: SUGGESTED_WEB.flatMap((s) => s.entries), approval: 'ask' })
    expect(parseConfig({ ...RULES, tools }).errors).toEqual([])
  })

  it('a typed site is added as the door will read it, and one it will not take is not added', () => {
    const { web, onChange } = renderCard()
    const input = within(web).getByRole('textbox', { name: 'Add a site' })
    fireEvent.change(input, { target: { value: '*.example.org' } })
    expect(within(web).getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(web).toHaveTextContent('That is not a site the door takes')
    fireEvent.change(input, { target: { value: 'https://Docs.Example.org/Guide/' } })
    fireEvent.click(within(web).getByRole('button', { name: 'Add' }))
    expect(onChange.mock.calls[0][0].web).toEqual({ allow: ['docs.example.org/Guide'] })
  })

  it('a listed site can be removed, and with none left the web is off again', () => {
    const rules = { ...RULES, tools: withWeb(undefined, { allow: ['en.wikipedia.org'], approval: 'ask' }) }
    const { web, onChange } = renderCard(rules)
    expect((document.querySelector('select[name="tools.web.approval"]') as HTMLSelectElement).value).toBe('ask')
    expect(document.querySelector('input[name="tools.approvalSeconds"]')).not.toBeNull()
    fireEvent.click(within(web).getByRole('button', { name: 'Remove en.wikipedia.org' }))
    expect(onChange.mock.calls[0][0].web).toBeUndefined()
  })

  it('an agent that hears anyone can still be given web pages; a harness with no tools cannot', () => {
    renderCard({ ...RULES, discord: { ...RULES.discord, anyoneInChannel: true } })
    expect(screen.getByRole('button', { name: '+ Stack Overflow' })).toBeEnabled()
    document.body.innerHTML = ''
    renderCard(RULES, 'Pi')
    expect(screen.queryByRole('button', { name: '+ Stack Overflow' })).toBeNull()
  })

  it('the public web and search are chosen here, and the launcher takes what the card wrote', () => {
    const { onChange } = renderCard()
    fireEvent.change(document.querySelector('select[name="tools.web.mode"]')!, { target: { value: 'public' } })
    const tools = onChange.mock.calls[0][0]
    expect(tools.web).toEqual({ allow: [], mode: 'public' })
    expect(policyFor(parseConfig({ ...RULES, tools }).config!).egress.default).toBe('public')
  })

  it('public rooms ask for each address by default; "Open web" writes anyoneRooms and the launcher opens the web there', () => {
    const anyone = { ...RULES, discord: { ...RULES.discord, anyoneInChannel: true } }
    // Listed sites: there is nothing to choose.
    renderCard({ ...anyone, tools: withWeb(undefined, { allow: ['en.wikipedia.org'] }) })
    expect(document.querySelector('select[name="tools.web.anyoneRooms"]')).toBeNull()
    document.body.innerHTML = ''
    const { onChange } = renderCard({ ...anyone, tools: withWeb(undefined, { mode: 'public', approval: 'ask' }) })
    const select = document.querySelector('select[name="tools.web.anyoneRooms"]') as HTMLSelectElement
    expect(select.value).toBe('ask')
    fireEvent.change(select, { target: { value: 'open' } })
    const tools = { ...onChange.mock.calls[0][0], web: { ...onChange.mock.calls[0][0].web!, approval: 'allow' as const } }
    expect(tools.web.anyoneRooms).toBe('open')
    const { config, errors } = parseConfig({ ...anyone, tools })
    expect(errors).toEqual([])
    expect(policyFor(config!).egress.openToAnyone).toBe(true)
    // Back to ask: the field is left out, as it always was.
    expect(withWeb(tools, { anyoneRooms: 'ask' }).web).not.toHaveProperty('anyoneRooms')
  })

  it('search asks for its key file, which goes to the record\'s secrets, not the rules', () => {
    const onSearchKeyFile = vi.fn()
    const onChange = vi.fn<(tools: ToolsConfig) => void>()
    const rules = { ...RULES, tools: withWeb(undefined, { allow: ['en.wikipedia.org'], search: true }) }
    render(<DoorToolsCard rules={rules} onChange={onChange} searchKeyFile="" onSearchKeyFile={onSearchKeyFile} />)
    fireEvent.change(document.querySelector('input[name="secrets.searchKeyFile"]')!, { target: { value: '/keys/search' } })
    expect(onSearchKeyFile).toHaveBeenCalledWith('/keys/search')
    expect(JSON.stringify(rules.tools)).not.toContain('/keys')
    fireEvent.click(document.querySelector('input[name="tools.web.search"]')!)
    expect(onChange.mock.calls[0][0].web).toEqual({ allow: ['en.wikipedia.org'] })
  })
})
