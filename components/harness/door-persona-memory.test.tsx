/**
 * The persona box and the Memory card on the Rules tab, and the Memory tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { DoorMemoryCard, DoorPersonaCard } from './door-persona-card'
import { DoorMemoryTab } from './door-memory-tab'
import { defaultPersona, PERSONA_DOC_MAX_BYTES, PERSONA_GUIDE } from '@/lib/lab/pi-discord/persona'
import type { LabConfig } from '@/lib/lab/pi-discord/config'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const RULES = {
  agentId: 'fern', persona: { name: 'Fern', description: 'Keeps the garden.', document: defaultPersona('Fern') },
  discord: { guildId: '1', channelId: '2', adminUserIds: ['3'], allowedUserIds: [], allowedRoleIds: [], anyoneInChannel: false, mentionRequired: true, bots: 'none', allowedBotIds: [], botLoopLimit: 4, readAllMessages: false },
  budget: { monthlyUsd: 5 }, model: { baseUrl: 'https://m/v1', id: 'm', usdPerMTokIn: 0, usdPerMTokOut: 0 },
} as unknown as LabConfig

function Persona({ saved = 'You are Fern.\n\nWhat you can do: read the messages you are sent, and answer in text.', spy }: { saved?: string | null; spy: (p: LabConfig['persona']) => void }) {
  const [rules, setRules] = useState(RULES)
  return <DoorPersonaCard rules={rules} savedPrompt={saved} onChange={(persona) => { spy(persona); setRules({ ...rules, persona }) }} />
}

describe('the persona box', () => {
  it('[U:persona-ui] edits the document, previews it as the agent reads it, counts bytes, and shows the guide', () => {
    const spy = vi.fn()
    render(<Persona spy={spy} />)
    const box = screen.getByRole('textbox', { name: 'Persona' }) as HTMLTextAreaElement
    expect(box.value).toBe(defaultPersona('Fern'))
    fireEvent.change(box, { target: { value: '## Who you are\nWarm.' } })
    expect(spy).toHaveBeenLastCalledWith({ name: 'Fern', description: 'Keeps the garden.', document: '## Who you are\nWarm.' })
    expect(screen.getByText(`20 of ${PERSONA_DOC_MAX_BYTES} bytes`)).toBeInTheDocument()
    for (const line of PERSONA_GUIDE) expect(screen.getByText(line)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByTestId('persona-preview')).toHaveTextContent('## Who you are Warm.')
    expect(screen.queryByRole('textbox', { name: 'Persona' })).toBeNull()
    // What the agent is told now, persona and the launcher's part after it, from the saved rules.
    expect(screen.getByTestId('saved-prompt')).toHaveTextContent('What you can do: read the messages you are sent')
  })

  it('[U:persona-ui] over the limit, the count says so; before the rules are filled in, the saved text says why there is none', () => {
    render(<Persona spy={vi.fn()} saved={null} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Persona' }), { target: { value: 'x'.repeat(PERSONA_DOC_MAX_BYTES + 1) } })
    expect(screen.getByText(`${PERSONA_DOC_MAX_BYTES + 1} of ${PERSONA_DOC_MAX_BYTES} bytes`).className).toContain('text-red-600')
    expect(screen.queryByTestId('saved-prompt')).toBeNull()
    expect(screen.getByText(/Fill in the rules first/)).toBeInTheDocument()
  })
})

describe('the Memory card', () => {
  it('[U:memory-ui] switches notes on and off, and keeps the scratch folder only when something writes there', () => {
    const spy = vi.fn()
    const { rerender } = render(<DoorMemoryCard rules={RULES} harnessLabel="Pi" writes={false} onChange={spy} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Keep notes for each room' }))
    expect(spy).toHaveBeenLastCalledWith({ memory: { notes: true } })
    expect(screen.getByRole('switch', { name: 'Keep the scratch folder after a stop' })).toBeDisabled()
    const tools = { enabled: ['shell'], mode: {}, approvalSeconds: 120 }
    rerender(<DoorMemoryCard rules={{ ...RULES, memory: { notes: true }, tools } as LabConfig} harnessLabel="Pi" writes onChange={spy} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Keep notes for each room' }))
    expect(spy).toHaveBeenLastCalledWith({ memory: undefined })
    fireEvent.click(screen.getByRole('switch', { name: 'Keep the scratch folder after a stop' }))
    expect(spy).toHaveBeenLastCalledWith({ tools: { ...tools, keepScratch: true } })
    rerender(<DoorMemoryCard rules={RULES} harnessLabel="Letta Code" writes={false} onChange={spy} />)
    expect(screen.getByText(/Letta Code cannot change them; you can, on the Memory tab/)).toBeInTheDocument()
  })
})

describe('the Memory tab', () => {
  let view: Record<string, unknown>
  let requests: Array<{ url: string; method: string; body?: unknown }>
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
    requests = []
    view = {
      notes: true, limits: { noteChars: 280, fileBytes: 4096 }, running: false,
      rooms: [{ key: 'discord:2', bytes: 30, files: { room: '- beds on Friday\n', people: '', threads: '- [redacted:github-token] was here\n' } }],
      scratch: { kept: true, bytes: 2048, savedAt: '2026-11-17T00:00:00.000Z' },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return { ok: true, status: 200, statusText: '', json: async () => view }
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  const open = async () => {
    await act(async () => { render(<DoorMemoryTab id="h_fern" name="fern" />) })
    await screen.findByRole('region', { name: 'Notes for discord:2' })
  }

  it('[U:mem-tab-ui] shows each room\'s notes as the server sends them, and saves one room\'s edit', async () => {
    await open()
    const room = screen.getByRole('region', { name: 'Notes for discord:2' })
    expect((within(room).getByRole('textbox', { name: 'About this room, discord:2' }) as HTMLTextAreaElement).value).toBe('- beds on Friday\n')
    expect((within(room).getByRole('textbox', { name: 'Ongoing threads, discord:2' }) as HTMLTextAreaElement).value).toContain('[redacted:github-token]')
    fireEvent.change(within(room).getByRole('textbox', { name: 'About this room, discord:2' }), { target: { value: '- beds on Saturday' } })
    await act(async () => { fireEvent.click(within(room).getByRole('button', { name: 'Save' })) })
    expect(requests.find((r) => r.method === 'PUT')).toEqual({
      url: '/api/harnesses/h_fern/door/memory', method: 'PUT',
      body: { room: 'discord:2', files: { room: '- beds on Saturday', people: '', threads: '- [redacted:github-token] was here\n' } },
    })
    expect(screen.getByRole('link', { name: 'Download notes' })).toHaveAttribute('href', '/api/harnesses/h_fern/door/memory/download')
  })

  it('[U:mem-tab-ui] each wipe asks first, then says exactly what to wipe', async () => {
    await open()
    const confirm = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Wipe', hidden: true })) }) }
    fireEvent.click(screen.getByRole('button', { name: 'Wipe room' }))
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([])
    await confirm()
    fireEvent.click(screen.getByRole('button', { name: 'Wipe all notes' }))
    await confirm()
    fireEvent.click(screen.getByRole('button', { name: 'Wipe scratch folder' }))
    await confirm()
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual([
      '/api/harnesses/h_fern/door/memory?room=discord%3A2',
      '/api/harnesses/h_fern/door/memory?all=notes',
      '/api/harnesses/h_fern/door/memory?all=scratch',
    ])
  })

  it('[U:mem-tab-ui] while the agent runs, the kept folder cannot be wiped, and says why', async () => {
    view.running = true
    await open()
    expect(screen.getByRole('button', { name: 'Wipe scratch folder' })).toBeDisabled()
    expect(screen.getByText(/Stop the agent first/)).toBeInTheDocument()
  })
})
