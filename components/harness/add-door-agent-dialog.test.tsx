/**
 * Adding a door agent from the fleet page: a form in a dialog, in place of
 * the browser's own pop-up. The name is checked while it is typed, by the
 * same rule the server uses. Nothing is sent until the form is submitted,
 * and a new agent's page opens on its Rules tab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import HarnessesPage from '@/app/(dashboard)/harnesses/page'
import { LETTA_CODE_VERSION } from '@/lib/runtimes/letta-code/caps'
import { PI_VERSION } from '@/lib/runtimes/pi/caps'

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }))
vi.mock('@/components/fleet/retired-rows', () => ({ RetiredRows: () => null }))

const ROW = { status: 'running', tier: 'team', platform: 'discord', channel: 'general', models: ['m1'], costToday: 0, invocations: 0, health: { errors: 0 } }
const FLEET = [
  { ...ROW, id: 'h_alpha', name: 'alpha', runtime: 'hermes' },
  { ...ROW, id: 'h_pi_one', name: 'pi-one', runtime: 'pi', status: 'stopped', costToday: null, invocations: null },
]

let sent: Array<{ url: string; method: string; body: unknown }>
let answer: { status: number; body: unknown }
const native = { prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() }

beforeEach(() => {
  sent = []
  answer = { status: 201, body: { id: 'h_pi_two', name: 'pi-two', runtime: 'pi' } }
  nav.push.mockReset()
  for (const [name, spy] of Object.entries(native)) { spy.mockReset(); vi.stubGlobal(name, spy) }
  HTMLDialogElement.prototype.showModal = vi.fn()
  HTMLDialogElement.prototype.close = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method !== 'GET') sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'POST' && url === '/api/harnesses/door') return { ok: answer.status < 400, status: answer.status, statusText: '', json: async () => answer.body }
    return { ok: true, status: 200, statusText: 'OK', json: async () => (url === '/api/harnesses' ? FLEET : {}) }
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const spy of Object.values(native)) expect(spy).not.toHaveBeenCalled()
})

async function openDialog(): Promise<HTMLElement> {
  render(<HarnessesPage />)
  await screen.findByText('alpha')
  fireEvent.click(screen.getByRole('button', { name: 'Add door agent' }))
  return document.querySelector('dialog[data-door-agent-form]') as HTMLElement
}
const nameField = (dialog: HTMLElement) => within(dialog).getByRole('textbox', { name: 'Name', hidden: true })
const type = (dialog: HTMLElement, value: string) => fireEvent.change(nameField(dialog), { target: { value } })
const submit = (dialog: HTMLElement) => fireEvent.submit(dialog.querySelector('form')!)
/** The text of every element the name field says describes it. */
const described = (dialog: HTMLElement): string =>
  (nameField(dialog).getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' | ')

describe('the "Add door agent" form', () => {
  it('opens as a dialog named by its title, with the name field ready to type in, and no browser pop-up', async () => {
    const dialog = await openDialog()
    expect(dialog).not.toBeNull()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)).toHaveTextContent('Add a door agent')
    expect(document.activeElement).toBe(nameField(dialog))
    expect(sent).toEqual([])
  })

  it('is not in the page at all until it is asked for', async () => {
    render(<HarnessesPage />)
    await screen.findByText('alpha')
    expect(screen.queryByRole('textbox', { name: 'Name', hidden: true })).toBeNull()
    expect(screen.queryByText('Add a door agent')).toBeNull()
  })

  it('says what a door agent is and what is done by hand, with the runbook', async () => {
    const dialog = await openDialog()
    expect(dialog).toHaveTextContent(/sealed cell/)
    expect(dialog).toHaveTextContent(/Discord application/)
    expect(dialog).toHaveTextContent(/two secret files/)
    expect(within(dialog).getByRole('link', { name: /runbook/i, hidden: true })).toHaveAttribute('href', expect.stringContaining('docs/lab/pi-discord.md'))
    // And never asks for a secret.
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(0)
    expect([...dialog.querySelectorAll('input')].map((i) => i.name)).toEqual(['name', 'runtime', 'runtime', 'description'])
  })

  it('checks the name as it is typed, by the server\'s rule, and ties the reason to the field', async () => {
    const dialog = await openDialog()
    // Nothing is called wrong before anything is typed.
    expect(nameField(dialog)).not.toHaveAttribute('aria-invalid', 'true')
    type(dialog, 'x')
    expect(nameField(dialog)).toHaveAttribute('aria-invalid', 'true')
    expect(described(dialog)).toMatch(/Name: letters, digits, spaces and dashes, 2 to 31 characters/)
    type(dialog, '../up')
    expect(described(dialog)).toMatch(/Name: letters, digits, spaces and dashes/)
    type(dialog, 'Pi Two')
    expect(nameField(dialog)).not.toHaveAttribute('aria-invalid', 'true')
    expect(described(dialog)).not.toMatch(/Name: letters/)
    expect(described(dialog)).toMatch(/It will be called pi-two/)
  })

  it('says so at once when a Hermes agent, or another door agent, has the name', async () => {
    const dialog = await openDialog()
    type(dialog, 'alpha')
    expect(nameField(dialog)).toHaveAttribute('aria-invalid', 'true')
    expect(described(dialog)).toMatch(/An agent named "alpha" already exists/)
    type(dialog, 'Pi One')
    expect(described(dialog)).toMatch(/An agent named "pi-one" already exists/)
  })

  it('offers Pi and Letta Code, each with its pinned version, and says plainly that Letta Code has one room only', async () => {
    const dialog = await openDialog()
    const group = within(dialog).getByRole('radiogroup', { name: 'Harness', hidden: true })
    const [pi, letta] = within(group).getAllByRole('radio', { hidden: true })
    expect(pi).toBeChecked()
    expect(pi.closest('label')).toHaveTextContent(`Pi ${PI_VERSION}`)
    expect(letta.closest('label')).toHaveTextContent(`Letta Code ${LETTA_CODE_VERSION}`)
    const limits = (radio: HTMLElement) => document.getElementById(radio.getAttribute('aria-describedby')!)!
    expect(limits(letta)).toHaveTextContent(/One room only\. It keeps one memory for the whole agent/)
    expect(limits(pi)).not.toHaveTextContent(/One room only/)
    fireEvent.click(letta)
    expect(letta).toBeChecked()
    expect(pi).not.toBeChecked()
  })

  it('sends the name, the harness and the description once, and opens the new agent on its Rules tab', async () => {
    answer = { status: 201, body: { id: 'h_garden_helper', name: 'garden-helper', runtime: 'letta-code' } }
    const dialog = await openDialog()
    type(dialog, ' Garden Helper ')
    fireEvent.click(within(dialog).getByRole('radio', { name: /Letta Code/, hidden: true }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Description/, hidden: true }), { target: { value: 'Answers questions about the garden.' } })
    submit(dialog)
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/harnesses/h_garden_helper?tab=rules'))
    expect(sent).toEqual([{ url: '/api/harnesses/door', method: 'POST', body: { name: 'Garden Helper', runtime: 'letta-code', description: 'Answers questions about the garden.' } }])
  })

  it('sends nothing for a name that is refused, and puts the reader back on the field', async () => {
    const dialog = await openDialog()
    submit(dialog)
    expect(described(dialog)).toMatch(/Name: letters, digits, spaces and dashes/)
    type(dialog, 'alpha')
    within(dialog).getByRole('radio', { name: /Letta Code/, hidden: true }).focus()
    submit(dialog)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
    expect(nav.push).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(nameField(dialog))
  })

  it('shows the server\'s refusal in the form, and stays open', async () => {
    answer = { status: 409, body: { error: 'An agent named "pi-two" already exists' } }
    const dialog = await openDialog()
    type(dialog, 'pi-two')
    submit(dialog)
    const alert = await within(dialog).findByRole('alert', { hidden: true })
    expect(alert).toHaveTextContent('An agent named "pi-two" already exists')
    expect(nav.push).not.toHaveBeenCalled()
    expect(nameField(dialog)).toHaveValue('pi-two')
    // Typing again clears what the server said about the old name.
    type(dialog, 'pi-three')
    expect(within(dialog).queryByRole('alert', { hidden: true })).toBeNull()
  })

  it('a second submit while the first is on its way sends nothing more', async () => {
    const dialog = await openDialog()
    type(dialog, 'pi-two')
    submit(dialog)
    submit(dialog)
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1))
    expect(sent).toHaveLength(1)
  })

  it('Cancel and Escape close it without sending anything, and it opens empty the next time', async () => {
    const dialog = await openDialog()
    type(dialog, 'pi-two')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }))
    expect(screen.queryByRole('textbox', { name: 'Name', hidden: true })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add door agent' }))
    expect(nameField(dialog)).toHaveValue('')
    // Escape closes a modal <dialog>, which fires its close event.
    fireEvent(dialog, new Event('close'))
    expect(screen.queryByRole('textbox', { name: 'Name', hidden: true })).toBeNull()
    expect(sent).toEqual([])
  })
})

describe('no browser pop-up in the door agent pages', () => {
  it.each(['components/harness/add-door-agent-dialog.tsx', 'components/harness/door-agent-page.tsx'])('%s calls no prompt, alert or confirm', (file) => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8')
    expect(source).not.toMatch(/\b(prompt|alert|confirm)\s*\(/)
  })

  it('the fleet page asks about a door agent only through the app\'s own dialogs', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'app/(dashboard)/harnesses/page.tsx'), 'utf8')
    const body = source.slice(source.indexOf('function removeDoorAgent(')).split('\n  }\n')[0]
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(/\b(prompt|alert|confirm)\s*\(/)
    // And no pop-up left on the page, which Hermes agents still use, speaks of a door agent or its door.
    const calls = [...source.matchAll(/window\.(prompt|alert|confirm)\(/g)].map((m) => source.slice(m.index, m.index! + 200))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).not.toMatch(/door/i)
  })
})
