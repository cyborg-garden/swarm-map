// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const mockHarness = vi.hoisted(() => ({
  get: vi.fn(),
  composeTarget: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  agentHealth: vi.fn(() => ({ running: false })),
}))

vi.mock('@/lib/services', () => ({ services: { harness: mockHarness } }))

const mockDataDir = vi.hoisted(() => ({ value: '/nonexistent' }))
vi.mock('@/lib/services/harness', () => ({
  agentDataDirForName: vi.fn(() => mockDataDir.value),
}))

import { POST } from './route'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

let root: string

beforeEach(() => {
  vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-migrate-route-'))
  mockDataDir.value = path.join(root, 'data')
  fs.mkdirSync(mockDataDir.value)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writeCompose(text: string): string {
  const p = path.join(root, 'docker-compose.yml')
  fs.writeFileSync(p, text)
  return p
}

describe('POST /api/harnesses/[id]/migrate-db', () => {
  it('404s for an unknown harness', async () => {
    mockHarness.get.mockReturnValue(undefined)
    const res = await POST({} as Request, makeParams('h_nope'))
    expect(res.status).toBe(404)
  })

  it('409s when there is no compose file', async () => {
    mockHarness.get.mockReturnValue({ id: 'h_x', name: 'x', runtime: 'hermes' })
    mockHarness.composeTarget.mockReturnValue(undefined)
    const res = await POST({} as Request, makeParams('h_x'))
    expect(res.status).toBe(409)
  })

  it('REFUSES (409) an untransformable compose and touches nothing', async () => {
    // Hand-edited file whose hermes service anchor is missing entirely.
    const composeFile = writeCompose('services:\n  something-else:\n    image: x\n')
    mockHarness.get.mockReturnValue({ id: 'h_sci', name: 'sci', runtime: 'hermes' })
    mockHarness.composeTarget.mockReturnValue({ composeFile, serviceName: 'hermes-sci' })

    const res = await POST({} as Request, makeParams('h_sci'))
    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.error).toMatch(/refusing to regenerate/)
    expect(data.error).toContain(composeFile)
    // Nothing stopped, nothing rewritten, nothing restarted.
    expect(mockHarness.stop).not.toHaveBeenCalled()
    expect(mockHarness.restart).not.toHaveBeenCalled()
    expect(fs.readFileSync(composeFile, 'utf-8')).toBe('services:\n  something-else:\n    image: x\n')
  })

  it('short-circuits (ok, alreadyMigrated) when compose is wired AND host DB is a symlink', async () => {
    const composeFile = writeCompose(
      'services:\n  hermes-sci:\n    image: x\n    volumes:\n      - /d:/opt/data\n      - hermes-state-sci:/state\n',
    )
    fs.symlinkSync('/state/state.db', path.join(mockDataDir.value, 'state.db'))
    mockHarness.get.mockReturnValue({ id: 'h_sci', name: 'sci', runtime: 'hermes' })
    mockHarness.composeTarget.mockReturnValue({ composeFile, serviceName: 'hermes-sci' })

    const res = await POST({} as Request, makeParams('h_sci'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.alreadyMigrated).toBe(true)
    expect(mockHarness.stop).not.toHaveBeenCalled()
    expect(mockHarness.restart).not.toHaveBeenCalled()
  })
})
