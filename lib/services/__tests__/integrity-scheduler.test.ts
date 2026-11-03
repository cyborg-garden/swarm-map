// @vitest-environment node
// The GitHub credential log line. pm2's error log is the one surface that reaches
// someone who isn't looking at the harnesses page.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('@/lib/services', () => ({
  services: { harness: { list: () => [{ id: 'h_newbie', name: 'newbie', runtime: 'hermes' }] } },
}))
vi.mock('../integrity', () => ({
  runFleetIntegritySweep: vi.fn(async () => undefined),
  sweepTargetFor: (harnessId: string, name: string, runtime: string) => ({ harnessId, name, runtime, dataDir: h.dataDir }),
}))

import { runScheduledSweep } from '../integrity-scheduler'

describe('runScheduledSweep', () => {
  let root: string
  let prevHome: string | undefined
  let errors: ReturnType<typeof vi.spyOn>
  const logged = () => errors.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'))
    prevHome = process.env.HOME
    process.env.HOME = root
    h.dataDir = path.join(root, '.hermes-newbie')
    fs.mkdirSync(h.dataDir)
    fs.writeFileSync(path.join(h.dataDir, '.env'), 'GITHUB_TOKEN=not-a-real-value\n')
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    process.env.HOME = prevHome
    errors.mockRestore()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('logs a new agent holding a PAT on a broker host, by name and never by value', async () => {
    fs.mkdirSync(path.join(root, '.config/hermes/github-app'), { recursive: true })
    fs.writeFileSync(path.join(root, '.config/hermes/github-app/private-key.pem'), 'unused')
    await runScheduledSweep()
    expect(logged()).toMatch(/\[github-credentials\].*newbie/)
    expect(logged()).not.toContain('not-a-real-value')
  })

  it('logs nothing on a host with no broker', async () => {
    await runScheduledSweep()
    expect(logged()).not.toContain('[github-credentials]')
  })
})
