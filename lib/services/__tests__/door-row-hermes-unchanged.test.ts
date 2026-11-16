// @vitest-environment node
/**
 * HarnessService and a door agent's stored row.
 *
 * A door agent keeps one row in harnesses.json, tagged with its runtime. To
 * HarnessService that row is one it cannot drive: it is never listed, never
 * matched to a container and never changed. It is also not "retired": it is
 * managed, by DoorAgentService. A row of a runtime nobody knows still is.
 *
 * And the Hermes agents come out of list() exactly as they do when there is
 * no door agent at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService } from '../harness'
import { agentNameTaken } from '../door-agents'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

const HERMES_ROWS = [
  { id: 'h_iris', name: 'iris', runtime: 'hermes', tier: 'team' },
  { id: 'h_legacy', name: 'legacy' },
]
const DOOR_ROWS = [
  { id: 'h_pi_one', name: 'pi-one', runtime: 'pi' },
  { id: 'h_lc_one', name: 'lc-one', runtime: 'letta-code' },
]
const UNKNOWN_ROW = { id: 'h_odd', name: 'odd', runtime: 'some-other-runtime' }

let tmpDir: string
let storage: Storage
let service: HarnessService
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-door-row-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  storage = new Storage(tmpDir)
  const docker = new DockerService()
  service = new HarnessService(storage, docker, new AuditService(storage), new ConfigService(storage))
  const composeFile = path.join(tmpDir, 'docker-compose.yml')
  fs.writeFileSync(composeFile, 'services: {}\n')
  storage.write('settings.json', { hermesDir: tmpDir, dataDir: tmpDir, theme: 'light', composeFiles: [composeFile] })
  mock(docker.isAvailable).mockReturnValue(true)
  mock(docker.getAllContainerStats).mockReturnValue({})
  mock(docker.listContainers).mockReturnValue([])
  // Two live containers: a Hermes agent, and one whose name maps to the door agent's id.
  mock(docker.listComposeProjects).mockReturnValue([{ name: 'fleet', status: 'running', configFiles: [composeFile] }])
  mock(docker.inspectContainers).mockReturnValue([
    { name: 'hermes-iris', service: 'hermes-iris', state: 'running', status: 'Up', ports: [{ published: 8642, target: 8000 }], composeFile },
    { name: 'hermes-pi-one', service: 'hermes-pi-one', state: 'running', status: 'Up', ports: [], composeFile },
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('HarnessService beside door agents', () => {
  it('lists the Hermes agents exactly as it does with no door agent stored', () => {
    storage.write('harnesses.json', HERMES_ROWS)
    // With no door row, the stray container is an ordinary agent. Leave it out of the comparison.
    const alone = service.list().filter((h) => h.id !== 'h_pi_one')
    storage.write('harnesses.json', [...HERMES_ROWS, ...DOOR_ROWS])
    const beside = service.list()
    expect(beside).toEqual(alone)
    expect(beside.map((h) => h.id).sort()).toEqual(['h_iris', 'h_legacy'])
  })

  it('never lists, gets or projects a container onto a door agent', () => {
    storage.write('harnesses.json', [...HERMES_ROWS, ...DOOR_ROWS])
    expect(service.get('h_pi_one')).toBeUndefined()
    expect(service.get('h_lc_one')).toBeUndefined()
    expect(service.list().some((h) => h.runtime === 'pi' || h.runtime === 'letta-code')).toBe(false)
  })

  it('does not change a door agent\'s row', () => {
    storage.write('harnesses.json', [...HERMES_ROWS, ...DOOR_ROWS])
    expect(service.updateConfig('h_pi_one', { tier: 'public' })).toBeUndefined()
    expect(storage.read('harnesses.json', [])).toEqual([...HERMES_ROWS, ...DOOR_ROWS])
  })

  it('keeps the name a door agent has', () => {
    storage.write('harnesses.json', [...HERMES_ROWS, ...DOOR_ROWS])
    expect(service.nameTaken('pi-one')).toBe(true)
  })

  it('counts a running Hermes agent\'s name as taken even when it has no stored row', () => {
    // hermes-pi-one is live and listed, and nothing about it is in harnesses.json.
    // A door agent made under that name would take its id and hide it.
    storage.write('harnesses.json', HERMES_ROWS)
    expect(service.list().map((h) => h.id)).toContain('h_pi_one')
    expect(service.nameTaken('pi-one')).toBe(false)
    expect(agentNameTaken(service, 'pi-one')).toBe(true)
    expect(agentNameTaken(service, 'iris')).toBe(true)
    expect(agentNameTaken(service, 'nobody-yet')).toBe(false)
  })

  it('reports an unknown runtime as retired, and a door agent not', () => {
    storage.write('harnesses.json', [...HERMES_ROWS, ...DOOR_ROWS, UNKNOWN_ROW])
    expect(service.listRetired()).toEqual([expect.objectContaining({ id: 'h_odd', runtime: 'some-other-runtime', reason: 'unknown' })])
  })
})
