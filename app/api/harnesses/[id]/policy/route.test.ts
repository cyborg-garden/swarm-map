/**
 * Tests for the policy API endpoints.
 *
 * GET /api/harnesses/:id/policy?action=group-check&platform=signal&chatId=abc
 * POST /api/harnesses/:id/policy  body: { action: "group-register"|"group-deregister", platform, chatId }
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GET, POST } from './route'

// Mock the usage service
vi.mock('@/lib/services/usage', () => ({
  getCostMonth: vi.fn(() => 0),
}))

// Mock the services module (keys.list + harness.restart)
vi.mock('@/lib/services', () => ({
  services: {
    keys: {
      list: vi.fn(() => []),
    },
    harness: {
      restart: vi.fn(),
    },
  },
}))

import { getCostMonth } from '@/lib/services/usage'
import { services } from '@/lib/services'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// Spy on os/fs rather than full module mock
let homedirSpy: ReturnType<typeof vi.spyOn>
let existsSpy: ReturnType<typeof vi.spyOn>
let readSpy: ReturnType<typeof vi.spyOn>
let writeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/test')
  existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
  readSpy = vi.spyOn(fs, 'readFileSync')
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Policy API — group-check (GET)', () => {
  it('returns allowed:true when chatId is in the GROUP_ALLOWED var', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2,group3\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=signal&chatId=group2'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(true)
  })

  it('returns allowed:false when chatId is NOT in the GROUP_ALLOWED var', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=signal&chatId=unknown-group'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(false)
  })

  it('returns allowed:true when GROUP_ALLOWED var is * (wildcard)', async () => {
    readSpy.mockReturnValue('TELEGRAM_GROUP_ALLOWED_CHATS=*\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=telegram&chatId=-100999'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(true)
  })

  it('returns allowed:false when GROUP_ALLOWED var is empty', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=signal&chatId=group1'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(false)
  })

  it('returns allowed:false when GROUP_ALLOWED var is missing entirely', async () => {
    readSpy.mockReturnValue('SOME_OTHER_VAR=hello\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=signal&chatId=group1'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(false)
  })

  it('returns 404 when agent .env not found', async () => {
    existsSpy.mockReturnValue(false)

    const req = new Request(
      'http://localhost/api/harnesses/h_ghost/policy?action=group-check&platform=signal&chatId=group1'
    )
    const res = await GET(req, makeParams('h_ghost'))

    expect(res.status).toBe(404)
  })

  it('returns 400 when platform or chatId missing', async () => {
    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=signal'
    )
    const res = await GET(req, makeParams('h_seraph'))

    expect(res.status).toBe(400)
  })

  it('returns 400 for unsupported platform', async () => {
    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=whatsapp&chatId=123'
    )
    const res = await GET(req, makeParams('h_seraph'))

    expect(res.status).toBe(400)
  })

  it('resolves personal agent data dir correctly', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_personal/policy?action=group-check&platform=signal&chatId=group1'
    )
    await GET(req, makeParams('h_personal'))

    expect(existsSpy).toHaveBeenCalledWith(
      path.join('/home/test', '.hermes', '.env')
    )
  })

  it('works with mattermost platform', async () => {
    readSpy.mockReturnValue('MATTERMOST_ALLOWED_CHANNELS=chan1,chan2\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=mattermost&chatId=chan1'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(true)
  })

  it('works with discord platform (DISCORD_ALLOWED_CHANNELS)', async () => {
    readSpy.mockReturnValue('DISCORD_ALLOWED_CHANNELS=chan1,chan2\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=discord&chatId=chan1'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(true)
  })

  it('works with slack platform (SLACK_ALLOWED_CHANNELS)', async () => {
    readSpy.mockReturnValue('SLACK_ALLOWED_CHANNELS=C111,C222\n')

    const req = new Request(
      'http://localhost/api/harnesses/h_seraph/policy?action=group-check&platform=slack&chatId=C111'
    )
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.allowed).toBe(true)
  })
})

describe('Policy API — group-register (POST)', () => {
  it('appends chatId to existing GROUP_ALLOWED var', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'group3' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toContain('SIGNAL_GROUP_ALLOWED_USERS=group1,group2,group3')
  })

  it('creates GROUP_ALLOWED var if it does not exist', async () => {
    readSpy.mockReturnValue('SOME_OTHER_VAR=hello\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'telegram', chatId: '-100123' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toContain('TELEGRAM_GROUP_ALLOWED_CHATS=-100123')
  })

  it('does not duplicate if chatId already present', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'group1' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toContain('SIGNAL_GROUP_ALLOWED_USERS=group1,group2')
    // Ensure group1 only appears once in the value
    const match = writtenContent.match(/SIGNAL_GROUP_ALLOWED_USERS=(.*)/)
    expect(match![1].split(',').filter((g: string) => g === 'group1')).toHaveLength(1)
  })

  it('returns 404 when agent .env not found', async () => {
    existsSpy.mockReturnValue(false)

    const req = new Request('http://localhost/api/harnesses/h_ghost/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'group1' }),
    })
    const res = await POST(req, makeParams('h_ghost'))

    expect(res.status).toBe(404)
  })

  it('returns 400 when platform or chatId missing', async () => {
    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(400)
  })

  it('sets first chatId when var was empty', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'first-group' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toContain('SIGNAL_GROUP_ALLOWED_USERS=first-group')
  })
})

describe('Policy API — group-deregister (POST)', () => {
  it('Discord: removing the last channel denies rather than opening every channel', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue('DISCORD_ALLOWED_CHANNELS=100000000000000001\n' as never)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    const req = new Request('http://localhost/api/harnesses/h_test/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'discord', chatId: '100000000000000001' }),
    })
    await POST(req, makeParams('h_test'))
    expect(write.mock.calls[0][1]).toMatch(/^DISCORD_ALLOWED_CHANNELS=0$/m)
  })

  it('removes chatId from GROUP_ALLOWED var', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2,group3\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'signal', chatId: 'group2' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toContain('SIGNAL_GROUP_ALLOWED_USERS=group1,group3')
    expect(writtenContent).not.toContain('group2')
  })

  it('handles removing the only chatId (leaves empty)', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=only-group\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'signal', chatId: 'only-group' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
    const writtenContent = writeSpy.mock.calls[0][1] as string
    expect(writtenContent).toMatch(/SIGNAL_GROUP_ALLOWED_USERS=\n/)
  })

  it('returns 200 even if chatId was not in the list (idempotent)', async () => {
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1\n')

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'signal', chatId: 'nonexistent' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(200)
  })

  it('recreates the harness when a new group is registered (cached allow-list reloads)', async () => {
    vi.mocked(services.harness.restart).mockClear()
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1\n')
    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'group2' }),
    })
    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(200)
    expect(services.harness.restart).toHaveBeenCalledWith('h_seraph', 'recreate')
  })

  it('does NOT recreate when registering an already-present group (loop-safe)', async () => {
    vi.mocked(services.harness.restart).mockClear()
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1\n')
    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-register', platform: 'signal', chatId: 'group1' }),
    })
    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(200)
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('recreates on deregister only when a group was actually removed', async () => {
    vi.mocked(services.harness.restart).mockClear()
    readSpy.mockReturnValue('SIGNAL_GROUP_ALLOWED_USERS=group1,group2\n')
    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'signal', chatId: 'group2' }),
    })
    const res = await POST(req, makeParams('h_seraph'))
    expect(res.status).toBe(200)
    expect(services.harness.restart).toHaveBeenCalledWith('h_seraph', 'recreate')
  })

  it('returns 404 when agent .env not found', async () => {
    existsSpy.mockReturnValue(false)

    const req = new Request('http://localhost/api/harnesses/h_ghost/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'group-deregister', platform: 'signal', chatId: 'group1' }),
    })
    const res = await POST(req, makeParams('h_ghost'))

    expect(res.status).toBe(404)
  })

  it('returns 400 for unknown action', async () => {
    const req = new Request('http://localhost/api/harnesses/h_seraph/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unknown-action', platform: 'signal', chatId: 'group1' }),
    })
    const res = await POST(req, makeParams('h_seraph'))

    expect(res.status).toBe(400)
  })
})

describe('Policy API — budget-check (GET)', () => {
  const mockedGetCostMonth = getCostMonth as ReturnType<typeof vi.fn>
  const mockedKeysList = services.keys.list as ReturnType<typeof vi.fn>

  it('returns exceeded:true when costMonth >= totalBudget', async () => {
    mockedGetCostMonth.mockReturnValue(50)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_seraph'], budgetUsd: 40, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.exceeded).toBe(true)
    expect(body.budget).toBe(40)
    expect(body.costMonth).toBe(50)
    expect(body.remaining).toBe(-10)
  })

  it('returns exceeded:false when costMonth < totalBudget', async () => {
    mockedGetCostMonth.mockReturnValue(15)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_seraph'], budgetUsd: 50, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.exceeded).toBe(false)
    expect(body.budget).toBe(50)
    expect(body.costMonth).toBe(15)
    expect(body.remaining).toBe(35)
  })

  it('returns budget:null when no keys are assigned (no budget configured)', async () => {
    mockedGetCostMonth.mockReturnValue(10)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'openai', maskedValue: 'sk-***', assignedTo: ['h_other'], budgetUsd: 100, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.budget).toBeNull()
    expect(body.exceeded).toBe(false)
  })

  it('returns budget:null when assigned keys have no budgetUsd', async () => {
    mockedGetCostMonth.mockReturnValue(5)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_seraph'], health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.budget).toBeNull()
    expect(body.exceeded).toBe(false)
  })

  it('sums budgets from multiple assigned keys', async () => {
    mockedGetCostMonth.mockReturnValue(60)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_seraph'], budgetUsd: 30, health: 'ok' },
      { id: 'k2', provider: 'openai', maskedValue: 'sk-***', assignedTo: ['h_seraph'], budgetUsd: 50, health: 'ok' },
      { id: 'k3', provider: 'google', maskedValue: 'ai-***', assignedTo: ['h_other'], budgetUsd: 100, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.budget).toBe(80)
    expect(body.costMonth).toBe(60)
    expect(body.exceeded).toBe(false)
    expect(body.remaining).toBe(20)
  })

  it('excludes keys assigned to other harnesses', async () => {
    mockedGetCostMonth.mockReturnValue(5)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_other'], budgetUsd: 200, health: 'ok' },
      { id: 'k2', provider: 'openai', maskedValue: 'sk-***', assignedTo: ['h_another'], budgetUsd: 100, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.budget).toBeNull()
    expect(body.exceeded).toBe(false)
  })

  it('returns exceeded:true when costMonth exactly equals budget (edge case)', async () => {
    mockedGetCostMonth.mockReturnValue(100)
    mockedKeysList.mockReturnValue([
      { id: 'k1', provider: 'anthropic', maskedValue: 'sk-***', assignedTo: ['h_seraph'], budgetUsd: 100, health: 'ok' },
    ])

    const req = new Request('http://localhost/api/harnesses/h_seraph/policy?action=budget-check')
    const res = await GET(req, makeParams('h_seraph'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.exceeded).toBe(true)
    expect(body.budget).toBe(100)
    expect(body.costMonth).toBe(100)
    expect(body.remaining).toBe(0)
  })
})
