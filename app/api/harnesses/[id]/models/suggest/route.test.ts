// @vitest-environment node
/**
 * GET /api/harnesses/:id/models/suggest feeds "Suggest from connected keys".
 * A model the catalog flags retired is kept for display only — it must never
 * be offered as a suggestion (#136: the picker flags it, it does not offer it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let dataDir = ''

vi.mock('@/lib/services', () => ({
  services: { harness: { get: vi.fn(() => ({ id: 'h_test', name: 'test', serviceName: 'hermes-test' })) } },
}))
vi.mock('@/lib/services/harness', () => ({ guessDataDir: vi.fn(() => dataDir) }))

import { GET } from './route'
import { MODEL_CATALOG } from '@/lib/model-catalog'

async function suggest() {
  const res = await GET(new Request('http://localhost/api/harnesses/h_test/models/suggest'), {
    params: Promise.resolve({ id: 'h_test' }),
  })
  return (await res.json()) as { providers: string[]; suggested: Array<{ provider: string; model: string }> }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-suggest-'))
  fs.writeFileSync(path.join(dataDir, '.env'), 'ANTHROPIC_API_KEY=present\nOPENROUTER_API_KEY=present\n')
})
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }) })

describe('GET /models/suggest', () => {
  it('never suggests Sonnet 4.5', async () => {
    const { suggested } = await suggest()
    const ids = suggested.map((s) => s.model)
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids.filter((id) => /sonnet-4[-.]5/.test(id))).toEqual([])
  })

  it('suggests every live catalog row for the detected providers and no retired one', async () => {
    const { providers, suggested } = await suggest()
    expect(providers.sort()).toEqual(['anthropic', 'openrouter'])
    const want = providers.flatMap((p) => MODEL_CATALOG[p].filter((m) => !m.retired).map((m) => `${p}/${m.id}`)).sort()
    expect(suggested.map((s) => `${s.provider}/${s.model}`).sort()).toEqual(want)
    expect(suggested.map((s) => s.model)).not.toContain('deepseek/deepseek-v3.2')
  })
})
