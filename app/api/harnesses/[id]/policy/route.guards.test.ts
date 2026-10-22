// @vitest-environment node
/**
 * The policy route is agent-callable without the operator cookie (GET), so
 * the harness id comes straight from the URL. These tests pin two guards:
 * a traversal id never reads another directory's .env, and a chatId cannot
 * add a line to (or splice text into) the agent .env on POST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ restart: vi.fn() }))
vi.mock('@/lib/services', () => ({
  services: { harness: { restart: h.restart }, keys: { list: () => [] } },
}))
vi.mock('@/lib/services/usage', () => ({ getCostMonth: () => 0 }))

import { GET, POST } from './route'

let home: string
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const envOf = (name: string) => path.join(home, `.hermes-${name}`, '.env')

function writeEnv(name: string, content: string) {
  fs.mkdirSync(path.dirname(envOf(name)), { recursive: true })
  fs.writeFileSync(envOf(name), content)
}
function post(id: string, body: unknown) {
  return POST(new Request(`http://x/api/harnesses/${id}/policy`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }), ctx(id))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-home-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  h.restart.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('GET /api/harnesses/:id/policy', () => {
  it('rejects a traversal id with 400 instead of reading the other .env', async () => {
    writeEnv('cryptids', 'TELEGRAM_GROUP_ALLOWED_CHATS=*\n')
    fs.mkdirSync(path.join(home, '.hermes-x'), { recursive: true })
    const id = 'x/../.hermes-cryptids'
    const res = await GET(new Request(`http://x/api/harnesses/x/policy?platform=telegram&chatId=1`), ctx(id))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid harness id' })
  })
  it('still answers for a real id and a bare slug', async () => {
    writeEnv('seraph-doer', 'TELEGRAM_GROUP_ALLOWED_CHATS=-100,-200\n')
    for (const id of ['h_seraph_doer', 'seraph-doer']) {
      const res = await GET(new Request('http://x/p?platform=telegram&chatId=-200'), ctx(id))
      expect(await res.json()).toEqual({ allowed: true })
    }
  })
})

describe('POST /api/harnesses/:id/policy', () => {
  it('rejects a traversal id before touching the filesystem', async () => {
    writeEnv('cryptids', 'TELEGRAM_GROUP_ALLOWED_CHATS=-1\n')
    const res = await post('x/../.hermes-cryptids', { action: 'group-register', platform: 'telegram', chatId: '-2' })
    expect(res.status).toBe(400)
    expect(fs.readFileSync(envOf('cryptids'), 'utf-8')).toBe('TELEGRAM_GROUP_ALLOWED_CHATS=-1\n')
  })
  it('rejects a chatId carrying a newline (no new .env line)', async () => {
    const before = 'TELEGRAM_GROUP_ALLOWED_CHATS=-1\nOTHER=keep\n'
    writeEnv('seraph', before)
    const res = await post('h_seraph', {
      action: 'group-register', platform: 'telegram', chatId: '-2\nTELEGRAM_ALLOWED_USERS=*',
    })
    expect(res.status).toBe(400)
    expect(fs.readFileSync(envOf('seraph'), 'utf-8')).toBe(before)
    expect(h.restart).not.toHaveBeenCalled()
  })
  it('rejects a "$&" chatId (replacement-pattern splice)', async () => {
    writeEnv('seraph', 'TELEGRAM_GROUP_ALLOWED_CHATS=-1\n')
    const res = await post('h_seraph', { action: 'group-register', platform: 'telegram', chatId: '$&' })
    expect(res.status).toBe(400)
  })
  it('registers and deregisters a valid chatId literally', async () => {
    writeEnv('seraph', 'A=1\nTELEGRAM_GROUP_ALLOWED_CHATS=-1\nB=2\n')
    expect((await post('h_seraph', { action: 'group-register', platform: 'telegram', chatId: '-2' })).status).toBe(200)
    expect(fs.readFileSync(envOf('seraph'), 'utf-8')).toBe('A=1\nTELEGRAM_GROUP_ALLOWED_CHATS=-1,-2\nB=2\n')
    expect(h.restart).toHaveBeenCalledWith('h_seraph', 'recreate')
    expect((await post('h_seraph', { action: 'group-deregister', platform: 'telegram', chatId: '-1' })).status).toBe(200)
    expect(fs.readFileSync(envOf('seraph'), 'utf-8')).toBe('A=1\nTELEGRAM_GROUP_ALLOWED_CHATS=-2\nB=2\n')
  })
  it('keeps the missing-field 400', async () => {
    writeEnv('seraph', 'TELEGRAM_GROUP_ALLOWED_CHATS=-1\n')
    const res = await post('h_seraph', { action: 'group-register', platform: 'telegram' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing platform or chatId' })
  })
})
