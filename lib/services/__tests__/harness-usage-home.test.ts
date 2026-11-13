// @vitest-environment node
/**
 * HarnessService reads each discovered agent's usage out of that agent's
 * home. It knows the home exactly (the adapter derives it from the
 * container), so it must hand the usage readers THAT directory and not one
 * rebuilt from the id: an id cannot be turned back into a name that held an
 * underscore (`hermes-_x` and `hermes--x` both get `h__x`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../docker')
vi.mock('../usage', () => ({ getCostToday: vi.fn(() => 0), getInvocationsToday: vi.fn(() => 0) }))

import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import { getCostToday, getInvocationsToday } from '../usage'

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>
let tmp: string
let service: HarnessService

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-home-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  const storage = new Storage(tmp)
  const docker = new DockerService()
  service = new HarnessService(storage, docker, new AuditService(storage), new ConfigService(storage))
  const composeFile = path.join(tmp, 'docker-compose.yml')
  fs.writeFileSync(composeFile, 'services: {}\n')
  storage.write('settings.json', { hermesDir: tmp, dataDir: tmp, theme: 'light', composeFiles: [composeFile] })
  mock(docker.isAvailable).mockReturnValue(true)
  mock(docker.getAllContainerStats).mockReturnValue({})
  mock(docker.listContainers).mockReturnValue([])
  mock(docker.listComposeProjects).mockReturnValue([{ name: 'x', status: 'running', configFiles: [composeFile] }])
  mock(docker.inspectContainers).mockReturnValue(
    ['hermes-_x', 'hermes-seraph-doer', 'hermes-personal'].map((name) => ({
      name, service: name, state: 'running', status: 'Up', ports: [], composeFile,
    })),
  )
  mock(getCostToday).mockClear()
  mock(getInvocationsToday).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('usage is read from the home the adapter found', () => {
  it.each([
    ['getCostToday', getCostToday],
    ['getInvocationsToday', getInvocationsToday],
  ])('%s gets each agent\'s real home', (_name, reader) => {
    const ids = service.list().map((h) => h.id).sort()
    expect(ids).toEqual(['h__x', 'h_personal', 'h_seraph_doer'])
    const homes = Object.fromEntries(
      mock(reader).mock.calls.map(([id, homeOf]) => [id as string, (homeOf as (i: string) => string)(id as string)]),
    )
    expect(homes).toEqual({
      h__x: path.join(tmp, '.hermes-_x'),
      h_seraph_doer: path.join(tmp, '.hermes-seraph-doer'),
      h_personal: path.join(tmp, '.hermes'),
    })
  })
})
