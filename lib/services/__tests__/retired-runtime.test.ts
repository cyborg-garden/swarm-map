// @vitest-environment node
/**
 * R4 — a stored row tagged with a retired or unknown runtime is never Hermes.
 *
 * `adapterForRuntime` used to fall back to the Hermes adapter for any runtime
 * it did not know. That was harmless while `'letta'` rows were filtered out by
 * hand in a dozen places. Once the old Letta path is deleted, the same
 * fallback would turn a leftover `runtime: 'letta'` row into a Hermes agent:
 * start/stop/delete would act on `hermes-<name>` and `~/.hermes-<name>`.
 *
 * The rule under test: such a row is kept out of list()/get() entirely (so no
 * route can reach a container verb through it), is reported by listRetired()
 * with a label, and the only thing that works on it is "forget the row".
 *
 * The row owns its id for as long as it is stored. That holds even when a
 * live container called `hermes-<name>` maps to the same id: the container is
 * not projected until the row is forgotten, and then it appears as a plain
 * Hermes agent with none of the row's fields.
 *
 * A row can also be retired by its id alone. The old integration never wrote
 * a `runtime` field to harnesses.json; the only rows it could leave there
 * have the ids it minted (`h_letta_agent-<uuid>`, `h_letta_server`) and no
 * tag at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService, adapterForRuntime, hermesAdapter } from '../harness'
import { UnsupportedRuntimeError } from '../runtime-adapter'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import type { Harness } from '@/lib/types'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

// A tag the type system does not know, exactly as an old harnesses.json holds it.
const asRuntime = (tag: string) => tag as unknown as Harness['runtime']

describe('adapterForRuntime no longer falls back to Hermes', () => {
  it('resolves hermes, and undefined (rows older than the runtime field)', () => {
    expect(adapterForRuntime('hermes')).toBe(hermesAdapter)
    expect(adapterForRuntime(undefined)).toBe(hermesAdapter)
  })

  it.each(['letta', 'letta-server'])('throws "retired" for %s', (tag) => {
    expect(() => adapterForRuntime(asRuntime(tag))).toThrow(UnsupportedRuntimeError)
    expect(() => adapterForRuntime(asRuntime(tag))).toThrow(/retired/i)
  })

  it('throws "unknown" for a tag nothing has registered', () => {
    expect(() => adapterForRuntime(asRuntime('pi-from-the-future'))).toThrow(UnsupportedRuntimeError)
    expect(() => adapterForRuntime(asRuntime('pi-from-the-future'))).toThrow(/unknown runtime/i)
  })

  it('throws for a typed runtime that has no adapter yet (custom)', () => {
    expect(() => adapterForRuntime('custom')).toThrow(UnsupportedRuntimeError)
  })
})

describe('a stored row with a retired runtime (R4)', () => {
  let tmpDir: string
  let storage: Storage
  let docker: DockerService
  let service: HarnessService
  let composeFile: string
  let decoyDataDir: string
  let decoyComposeDir: string

  const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-retired-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    docker = new DockerService()
    service = new HarnessService(storage, docker, new AuditService(storage), new ConfigService(storage))

    composeFile = path.join(tmpDir, 'docker-compose.yml')
    fs.writeFileSync(composeFile, 'services: {}\n')
    storage.write('settings.json', {
      hermesDir: tmpDir,
      dataDir: tmpDir,
      theme: 'light',
      composeFiles: [composeFile],
    })

    // What a Hermes agent called "old" would own. If the retired row is ever
    // treated as Hermes, "delete files" removes these.
    decoyDataDir = path.join(tmpDir, '.hermes-old')
    fs.mkdirSync(decoyDataDir)
    fs.writeFileSync(path.join(decoyDataDir, 'SOUL.md'), 'not yours to delete')
    decoyComposeDir = path.join(tmpDir, 'compose', 'old')
    fs.mkdirSync(decoyComposeDir, { recursive: true })
    const decoyCompose = path.join(decoyComposeDir, 'docker-compose.yml')
    fs.writeFileSync(decoyCompose, 'services: {}\n')

    storage.write('harnesses.json', [
      { id: 'h_iris', name: 'iris', runtime: 'hermes', tier: 'team' },
      {
        id: 'h_old',
        name: 'old',
        runtime: 'letta',
        composeFile: decoyCompose,
        serviceName: 'hermes-old',
      },
      { id: 'h_srv', name: 'srv', runtime: 'letta-server' },
      { id: 'h_odd', name: 'odd', runtime: 'pi-from-the-future' },
    ])

    mock(docker.isAvailable).mockReturnValue(true)
    mock(docker.listComposeProjects).mockReturnValue([])
    mock(docker.inspectContainers).mockReturnValue([])
    mock(docker.getAllContainerStats).mockReturnValue({})
    mock(docker.listContainers).mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const runIris = () => {
    mock(docker.listComposeProjects).mockReturnValue([
      { name: 'iris', status: 'running', configFiles: [composeFile] },
    ])
    mock(docker.inspectContainers).mockReturnValue([
      {
        name: 'hermes-iris',
        service: 'hermes-iris',
        state: 'running',
        status: 'Up',
        ports: [{ published: 8642, target: 8000 }],
        composeFile,
      },
    ])
  }

  it('is not in list() or get(), with Docker empty (stored fallback path)', () => {
    const ids = service.list().map((h) => h.id)
    expect(ids).toContain('h_iris')
    expect(ids).not.toContain('h_old')
    expect(ids).not.toContain('h_srv')
    expect(ids).not.toContain('h_odd')
    expect(service.get('h_old')).toBeUndefined()
  })

  it('is not in list() or get(), with a real Hermes agent running (merge path)', () => {
    runIris()
    const list = service.list()
    expect(list.find((h) => h.id === 'h_iris')?.status).toBe('running')
    expect(list.map((h) => h.id)).not.toContain('h_old')
    expect(service.get('h_srv')).toBeUndefined()
  })

  it('no row that list() returns is ever tagged hermes by default for a retired tag', () => {
    runIris()
    for (const h of service.list()) {
      expect(['h_old', 'h_srv', 'h_odd']).not.toContain(h.id)
    }
  })

  it('a live container that only the retired overlay claims is not projected as Hermes', () => {
    mock(docker.listComposeProjects).mockReturnValue([
      { name: 'old', status: 'running', configFiles: [composeFile] },
    ])
    mock(docker.inspectContainers).mockReturnValue([
      { name: 'old', service: 'old', state: 'running', status: 'Up', ports: [], composeFile },
    ])
    expect(() => service.list()).not.toThrow()
    expect(service.list().map((h) => h.id)).not.toContain('h_old')
  })

  describe('a live container named hermes-<name> shares the retired row\'s id', () => {
    const runHermesOld = () => {
      mock(docker.listComposeProjects).mockReturnValue([
        { name: 'old', status: 'running', configFiles: [composeFile] },
      ])
      mock(docker.inspectContainers).mockReturnValue([
        {
          name: 'hermes-old',
          service: 'hermes-old',
          state: 'running',
          status: 'Up',
          ports: [{ published: 8650, target: 8000 }],
          composeFile,
        },
      ])
    }

    beforeEach(() => {
      // Fields that would be rendered into a Hermes compose if the row's
      // overlay were ever merged onto the container.
      const rows = storage.read<Record<string, unknown>[]>('harnesses.json', [])
      storage.write(
        'harnesses.json',
        rows.map((r) =>
          r.id === 'h_old'
            ? {
                ...r,
                tier: 'public',
                extraMounts: [{ host: '/etc', container: '/host-etc' }],
                extraEnv: { LEFTOVER: '1' },
                pinnedImageRef: 'example.invalid/leftover:1',
              }
            : r,
        ),
      )
      runHermesOld()
    })

    it('the container is not projected: the id is in neither list() nor get()', () => {
      expect(service.list().map((h) => h.id)).not.toContain('h_old')
      expect(service.get('h_old')).toBeUndefined()
    })

    it('the id is reported once, by listRetired() only', () => {
      expect(service.listRetired().filter((r) => r.id === 'h_old')).toHaveLength(1)
      expect(service.list().filter((h) => h.id === 'h_old')).toHaveLength(0)
    })

    it('start, stop, restart and composeTarget never reach Docker', () => {
      expect(() => service.start('h_old')).toThrow()
      expect(() => service.stop('h_old')).toThrow()
      expect(() => service.restart('h_old', 'quick')).toThrow()
      expect(service.composeTarget('h_old')).toBeUndefined()
      expect(docker.start).not.toHaveBeenCalled()
      expect(docker.stop).not.toHaveBeenCalled()
      expect(docker.restart).not.toHaveBeenCalled()
    })

    it('forgetting the row touches no container, and the container then appears as plain Hermes', () => {
      const result = service.remove('h_old', true)
      expect(result).toEqual({ removed: true, stopped: false, filesDeleted: false, volumeRemoved: false })
      expect(docker.down).not.toHaveBeenCalled()
      expect(docker.stop).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(decoyDataDir, 'SOUL.md'))).toBe(true)

      const live = service.get('h_old')
      expect(live).toMatchObject({ id: 'h_old', runtime: 'hermes', status: 'running', tier: 'individual' })
      // Nothing from the forgotten row survives onto the Hermes agent.
      expect(live).not.toHaveProperty('extraMounts')
      expect(live).not.toHaveProperty('extraEnv')
      expect(live).not.toHaveProperty('pinnedImageRef')
      expect(service.listRetired().map((r) => r.id)).not.toContain('h_old')
      // And it is an ordinary, editable agent again.
      expect(service.updateConfig('h_old', { tier: 'team' })?.tier).toBe('team')
    })

    it('control: without the retired row the same container IS listed and stoppable', () => {
      // Proves the checks above can fail: this is what "treated as Hermes" looks like.
      storage.write('harnesses.json', [{ id: 'h_old', name: 'old', runtime: 'hermes' }])
      expect(service.get('h_old')).toMatchObject({ runtime: 'hermes', status: 'running' })
      service.stop('h_old')
      expect(docker.stop).toHaveBeenCalledTimes(1)
    })
  })

  describe('a row the old integration left behind: its id, and no runtime tag', () => {
    const AGENT_ID = 'h_letta_agent-0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9'
    const SERVER_ID = 'h_letta_server'
    let agentDecoy: string
    let serverDecoy: string

    beforeEach(() => {
      // Exactly what SurfaceAdminsService wrote for an id it had no row for:
      // `{ id, surfaceAdmins }` and nothing else.
      storage.write('harnesses.json', [
        { id: 'h_iris', name: 'iris', runtime: 'hermes', tier: 'team' },
        { id: AGENT_ID, surfaceAdmins: { discord: ['1'] } },
        { id: SERVER_ID, surfaceAdmins: { discord: ['1'] } },
      ])
      // What remove(id, true) would resolve these to if they were Hermes.
      agentDecoy = path.join(tmpDir, '.hermes-' + AGENT_ID.replace(/^h_/, '').replace(/_/g, '-'))
      serverDecoy = path.join(tmpDir, '.hermes-letta-server')
      for (const d of [agentDecoy, serverDecoy]) {
        fs.mkdirSync(d)
        fs.writeFileSync(path.join(d, 'SOUL.md'), 'not yours to delete')
      }
    })

    it('is not in list() or get(), on the stored path and on the merge path', () => {
      expect(service.list().map((h) => h.id)).toEqual(['h_iris'])
      runIris()
      expect(service.list().map((h) => h.id)).toEqual(['h_iris'])
      expect(service.get(AGENT_ID)).toBeUndefined()
      expect(service.get(SERVER_ID)).toBeUndefined()
    })

    it('listRetired() reports both as retired', () => {
      const retired = service.listRetired()
      expect(retired.map((r) => r.id).sort()).toEqual([AGENT_ID, SERVER_ID].sort())
      for (const r of retired) {
        expect(r.reason).toBe('retired')
        expect(r.note).toMatch(/retired/i)
      }
    })

    it('updateConfig, start and stop refuse', () => {
      const before = fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')
      expect(service.updateConfig(AGENT_ID, { tier: 'public' })).toBeUndefined()
      expect(fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')).toBe(before)
      expect(() => service.start(AGENT_ID)).toThrow()
      expect(() => service.stop(SERVER_ID)).toThrow()
      expect(docker.start).not.toHaveBeenCalled()
      expect(docker.stop).not.toHaveBeenCalled()
    })

    it.each([
      ['agent', () => AGENT_ID, () => agentDecoy],
      ['server', () => SERVER_ID, () => serverDecoy],
    ])('remove(%s row, deleteFiles) only forgets the row', (_label, id, decoy) => {
      const result = service.remove(id(), true)
      expect(result).toEqual({ removed: true, stopped: false, filesDeleted: false, volumeRemoved: false })
      expect(docker.down).not.toHaveBeenCalled()
      expect(docker.removeVolume).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(decoy(), 'SOUL.md'))).toBe(true)
      expect(service.listRetired().map((r) => r.id)).not.toContain(id())
    })

    it('a live hermes-letta-server container is not projected while the untagged row is stored', () => {
      mock(docker.listComposeProjects).mockReturnValue([
        { name: 'x', status: 'running', configFiles: [composeFile] },
      ])
      mock(docker.inspectContainers).mockReturnValue([
        { name: 'hermes-letta-server', service: 'hermes-letta-server', state: 'running', status: 'Up', ports: [], composeFile },
      ])
      expect(service.list().map((h) => h.id)).not.toContain(SERVER_ID)
      expect(() => service.stop(SERVER_ID)).toThrow()
      expect(docker.stop).not.toHaveBeenCalled()
    })

    it('control: Hermes agents whose names merely start with "letta" are untouched', () => {
      storage.write('harnesses.json', [
        // Untagged, name-derived id: underscores only, so not an old agent id.
        { id: 'h_letta_agent_smith', name: 'letta-agent-smith' },
        { id: 'h_letta_fan', name: 'letta-fan' },
        // The server id, but explicitly tagged Hermes: the tag wins.
        { id: SERVER_ID, name: 'letta-server', runtime: 'hermes' },
      ])
      expect(service.list().map((h) => h.id).sort()).toEqual(['h_letta_agent_smith', 'h_letta_fan', SERVER_ID])
      expect(service.listRetired()).toEqual([])
    })
  })

  it('listRetired() reports each one with its stored tag and a reason', () => {
    const retired = service.listRetired()
    expect(retired.map((r) => r.id).sort()).toEqual(['h_odd', 'h_old', 'h_srv'])
    const old = retired.find((r) => r.id === 'h_old')!
    expect(old).toMatchObject({ name: 'old', runtime: 'letta', reason: 'retired' })
    expect(old.note).toMatch(/retired/i)
    expect(retired.find((r) => r.id === 'h_odd')).toMatchObject({
      runtime: 'pi-from-the-future',
      reason: 'unknown',
    })
    // Hermes rows, and rows older than the runtime field, are never listed.
    storage.write('harnesses.json', [{ id: 'h_a', name: 'a' }, { id: 'h_b', name: 'b', runtime: 'hermes' }])
    expect(service.listRetired()).toEqual([])
  })

  it('start, stop and restart refuse and never reach Docker', () => {
    expect(() => service.start('h_old')).toThrow()
    expect(() => service.stop('h_old')).toThrow()
    expect(() => service.restart('h_old', 'quick')).toThrow()
    expect(service.composeTarget('h_old')).toBeUndefined()
    expect(docker.start).not.toHaveBeenCalled()
    expect(docker.stop).not.toHaveBeenCalled()
    expect(docker.restart).not.toHaveBeenCalled()
  })

  it('duplicate refuses and writes nothing', async () => {
    const before = fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')
    expect(await service.duplicateOverlay('h_old', 'copy')).toBeUndefined()
    expect(fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')).toBe(before)
    expect(fs.existsSync(path.join(tmpDir, '.hermes-copy'))).toBe(false)
  })

  it('updateConfig refuses and leaves the stored row untouched', () => {
    const before = fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')
    expect(service.updateConfig('h_old', { tier: 'public' })).toBeUndefined()
    expect(fs.readFileSync(path.join(tmpDir, 'harnesses.json'), 'utf-8')).toBe(before)
  })

  it('remove() only forgets the row: no Docker call, no file or volume removed, even with deleteFiles', () => {
    const result = service.remove('h_old', true)
    expect(result).toEqual({ removed: true, stopped: false, filesDeleted: false, volumeRemoved: false })
    expect(docker.down).not.toHaveBeenCalled()
    expect(docker.stop).not.toHaveBeenCalled()
    expect(docker.removeVolume).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(decoyDataDir, 'SOUL.md'))).toBe(true)
    expect(fs.existsSync(decoyComposeDir)).toBe(true)
    expect(service.listRetired().map((r) => r.id)).not.toContain('h_old')
    // The Hermes row beside it is untouched.
    expect(service.get('h_iris')).toBeDefined()
  })

  it('control: the same remove() on a real Hermes row DOES delete its files', () => {
    // Proves the decoy check above can fail: without the guard, these go.
    fs.mkdirSync(path.join(tmpDir, '.hermes-iris'))
    const result = service.remove('h_iris', true)
    expect(result.filesDeleted).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.hermes-iris'))).toBe(false)
  })
})
