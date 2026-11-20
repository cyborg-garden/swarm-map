import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { installPackToDir } from '../pack-install'
import type { Harness } from '@/lib/types'

vi.mock('../docker')
vi.mock('../pack-install')

const row = {
  id: 'h_test', name: 'test', runtime: 'hermes', serviceName: 'hermes-test', status: 'running',
  health: { errors: 0 }, persona: '', tier: 'individual', platform: 'hermes', channel: ':8642',
  lastSeen: 0, models: [], costToday: 0, invocations: 0, cpu: 0, mem: 0, tools: [],
} as unknown as Harness

describe('HarnessService.installPack audit trail', () => {
  let tmp: string
  let service: HarnessService
  let audit: AuditService
  const what = () => vi.mocked(audit.append).mock.calls.map(([e]) => e.what)

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-install-pack-'))
    const storage = new Storage(tmp)
    storage.write('harnesses.json', [row])
    audit = new AuditService(storage)
    vi.spyOn(audit, 'append')
    service = new HarnessService(storage, new DockerService(), audit)
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    vi.resetAllMocks()
  })

  it('records a refused install before passing the error on', async () => {
    vi.mocked(installPackToDir).mockRejectedValue(new Error('Refused git-sourced skills/x'))
    await expect(service.installPack('h_test', 'p')).rejects.toThrow(/Refused/)
    expect(what()).toEqual(['pack:install:p:failed'])
  })

  it('records a restart that fails after the pack went in, and still reports the install', async () => {
    vi.mocked(installPackToDir).mockResolvedValue({
      pack: 'p', installed: true, pluginsEnabled: [], results: [{ type: 'plugins', name: 'x', installed: true }],
    })
    vi.spyOn(service, 'restart').mockImplementation(() => { throw new Error('no compose file configured') })
    const r = await service.installPack('h_test', 'p')
    expect(r).toMatchObject({ installed: true, restarted: false, restartError: 'no compose file configured' })
    expect(what()).toEqual(['pack:install:p', 'pack:install:p:restart-failed'])
  })

  it('does not restart when nothing changed', async () => {
    vi.mocked(installPackToDir).mockResolvedValue({
      pack: 'p', installed: true, pluginsEnabled: [], results: [{ type: 'plugins', name: 'x', installed: true, skipped: true }],
    })
    const restart = vi.spyOn(service, 'restart')
    expect(await service.installPack('h_test', 'p')).toMatchObject({ restarted: false })
    expect(restart).not.toHaveBeenCalled()
  })
})
