// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DockerService } from '../docker'

// DockerService is shell-free: it invokes execFileSync/spawn with an argv array
// (see docker-injection.test.ts for the security property). These tests mock
// that surface and assert the argv, and that behavior (fail-loud rebuild sync,
// fire-and-forget restarts, the RestartCount regression) is preserved.
const mockExecFileSync = vi.hoisted(() => vi.fn())
const mockSpawn = vi.hoisted(() => vi.fn())
// Async execFile surface (execInContainer). The real child_process.execFile
// carries util.promisify.custom returning Promise<{stdout, stderr}> — mirror
// that so promisify() in docker.ts wraps the mock the same way.
const mockExecFileAsync = vi.hoisted(() => vi.fn())
const mockExecFile = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { [key: symbol]: unknown }
  fn[Symbol.for('nodejs.util.promisify.custom')] = mockExecFileAsync
  return fn
})

vi.mock('child_process', () => ({
  default: { execFileSync: mockExecFileSync, spawn: mockSpawn, execFile: mockExecFile },
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
  execFile: mockExecFile,
}))

// Join a [cmd, args] call into a single string for substring assertions.
const joined = (call: unknown[]) => [call[0], ...((call[1] as string[]) ?? [])].join(' ')

describe('DockerService', () => {
  let docker: DockerService

  beforeEach(() => {
    vi.clearAllMocks()
    // Each spawn returns its OWN fake child — restart modes chain steps
    // (stop→up, build→stop→up) on per-child exit events.
    mockSpawn.mockImplementation(() => ({ unref: vi.fn(), on: vi.fn() }))
    docker = new DockerService()
  })

  /** Fire the exit handler registered by the Nth spawned child (chain step). */
  const fireExit = (spawnIndex: number, code: number) => {
    const on = mockSpawn.mock.results[spawnIndex].value.on
    const handler = on.mock.calls.find((c: unknown[]) => c[0] === 'exit')?.[1]
    expect(handler).toBeDefined()
    handler(code)
  }

  it('checks if docker is available', () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from('Docker version 24.0.0'))
    expect(docker.isAvailable()).toBe(true)
  })

  it('returns false when docker is not available', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('not found') })
    expect(docker.isAvailable()).toBe(false)
  })

  it('lists containers from compose file', () => {
    const jsonOutput = JSON.stringify([
      { Name: 'hermes-audrey-1', Service: 'audrey', State: 'running' },
      { Name: 'hermes-cryptid-1', Service: 'cryptid', State: 'exited' },
    ])
    mockExecFileSync.mockReturnValueOnce(Buffer.from(jsonOutput))

    const containers = docker.listContainers('/path/to/docker-compose.yml')
    expect(containers).toHaveLength(2)
    expect(containers[0]).toEqual({
      name: 'hermes-audrey-1',
      service: 'audrey',
      state: 'running',
    })
    // composeFile is passed as its own argv element — never spliced into a string
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', '-f', '/path/to/docker-compose.yml', 'ps', '--format', 'json']),
      expect.any(Object),
    )
  })

  it('returns empty array when compose ps fails', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('no compose') })
    const containers = docker.listContainers('/bad/path.yml')
    expect(containers).toEqual([])
  })

  it('inspectState reads RestartCount from the top-level field, not .State', () => {
    // Regression: in `docker inspect`, RestartCount is a TOP-LEVEL field, not under
    // .State. A `{{.State.RestartCount}}` template errors out ("map has no entry for
    // key RestartCount"), so inspectState would catch the throw and return null —
    // making /api/harnesses/:id/health report EVERY agent "unhealthy/running:false".
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(' ').includes('.State.RestartCount')) {
        throw new Error('template: :1:45: map has no entry for key "RestartCount"')
      }
      return Buffer.from('true|running|3|2026-06-18T23:10:59Z')
    })

    const state = docker.inspectState('hermes-nimbleco')
    expect(state).not.toBeNull()
    expect(state).toEqual({
      running: true,
      status: 'running',
      restartCount: 3,
      startedAt: '2026-06-18T23:10:59Z',
    })
  })

  it('restarts a service in quick mode (fire-and-forget via spawn)', () => {
    docker.restart('/path/compose.yml', 'audrey', 'quick')
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['-f', '/path/compose.yml', 'restart', 'audrey']),
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    )
    expect(mockSpawn.mock.results[0].value.unref).toHaveBeenCalled()
  })

  it('rebuild: builds first (agent stays up), then stop, then up — chained on clean exits', () => {
    docker.restart('/path/compose.yml', 'audrey', 'rebuild')
    expect(mockExecFileSync).not.toHaveBeenCalled()
    // Step 1: cached build — the agent keeps running during it.
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const buildArgs = mockSpawn.mock.calls[0][1] as string[]
    expect(buildArgs).toEqual(expect.arrayContaining(['-f', '/path/compose.yml', 'build', 'audrey']))
    expect(buildArgs).not.toContain('--no-cache')
    fireExit(0, 0)
    // Step 2: stop — quiesces the DB writer BEFORE up runs state-init (#204).
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(mockSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['-f', '/path/compose.yml', 'stop', 'audrey']),
    )
    fireExit(1, 0)
    // Step 3: up --force-recreate (no --build — already built).
    expect(mockSpawn).toHaveBeenCalledTimes(3)
    const upArgs = mockSpawn.mock.calls[2][1] as string[]
    expect(upArgs).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate', 'audrey']))
    expect(upArgs).not.toContain('--build')
    expect(mockSpawn.mock.results[0].value.unref).toHaveBeenCalled()
  })

  it('recreate: STOPS the service before up --force-recreate (state-init must never copy under a live writer, #204)', () => {
    docker.restart('/path/compose.yml', 'audrey', 'recreate')
    expect(mockExecFileSync).not.toHaveBeenCalled()
    // Step 1 is the stop — `up -d --force-recreate` converges dependencies
    // first, so without the stop the state-init migration copy would run while
    // the OLD container is still writing state.db (torn-copy corruption).
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-f', '/path/compose.yml', 'stop', 'audrey']),
    )
    fireExit(0, 0)
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    const upArgs = mockSpawn.mock.calls[1][1] as string[]
    expect(upArgs).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate', 'audrey']))
    // recreate must NOT rebuild the image — it only reloads env_file / config
    expect(upArgs).not.toContain('--build')
    expect(mockSpawn.mock.results[0].value.unref).toHaveBeenCalled()
    expect(mockSpawn.mock.results[1].value.unref).toHaveBeenCalled()
  })

  it('recreate: does NOT run up when the stop step fails (fail-stop beats fail-race)', () => {
    docker.restart('/path/compose.yml', 'audrey', 'recreate')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    fireExit(0, 1) // stop failed
    expect(mockSpawn).toHaveBeenCalledTimes(1) // no up spawned
  })

  it('purge: build --no-cache, then stop, then up — all docker argv (no shell)', () => {
    docker.restart('/path/compose.yml', 'audrey', 'purge')
    expect(mockExecFileSync).not.toHaveBeenCalled()
    // No `sh -c` — every step is a direct docker argv call.
    expect(mockSpawn).not.toHaveBeenCalledWith('sh', expect.anything(), expect.anything())
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['-f', '/path/compose.yml', 'build', '--no-cache', 'audrey']),
    )
    fireExit(0, 0)
    expect(mockSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['-f', '/path/compose.yml', 'stop', 'audrey']),
    )
    fireExit(1, 0)
    expect(mockSpawn.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['up', '-d', '--force-recreate', 'audrey']),
    )
    expect(mockSpawn.mock.results[0].value.unref).toHaveBeenCalled()
  })

  describe('rebuild syncs the build source before building', () => {
    // Stub a clean, fast-forwardable git checkout. Each git call returns the
    // right value based on the subcommand (matched against the joined argv).
    function stubCleanGit(opts?: { dirty?: string; branch?: string; noUpstream?: boolean; nonFf?: boolean }) {
      const branch = opts?.branch ?? 'main'
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        const a = args.join(' ')
        if (a.includes('rev-parse --is-inside-work-tree')) return Buffer.from('true')
        if (a.includes('status --porcelain')) return Buffer.from(opts?.dirty ?? '')
        if (a.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from(branch)
        if (a.includes('symbolic-full-name @{u}')) {
          if (opts?.noUpstream) throw new Error('no upstream')
          return Buffer.from(`origin/${branch}`)
        }
        if (a.includes('fetch')) return Buffer.from('')
        if (a.includes('merge --ff-only')) {
          if (opts?.nonFf) throw new Error('not possible to fast-forward')
          return Buffer.from('Updating')
        }
        if (a.includes('rev-parse --short HEAD')) return Buffer.from('abc1234')
        if (a.includes('rev-parse HEAD')) return Buffer.from('a'.repeat(40))
        return Buffer.from('')
      })
    }

    it('fetches and fast-forwards the source, then builds', () => {
      stubCleanGit()
      docker.restart('/path/compose.yml', 'audrey', 'rebuild', undefined, '/src/hermes')
      const calls = mockExecFileSync.mock.calls.map(joined)
      expect(calls.some((c) => c.includes('git -C /src/hermes fetch'))).toBe(true)
      expect(calls.some((c) => c.includes('git -C /src/hermes merge --ff-only origin/main'))).toBe(true)
      // build still fires (first chain step)
      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['build', 'audrey']),
        expect.any(Object),
      )
    })

    it('FAILS LOUD and does NOT build when the source is dirty', () => {
      stubCleanGit({ dirty: ' M lib/foo.ts' })
      expect(() => docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')).toThrow(/uncommitted changes/)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('FAILS LOUD and does NOT build when the source cannot fast-forward', () => {
      stubCleanGit({ nonFf: true })
      expect(() => docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')).toThrow(/cannot fast-forward|diverged/)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('FAILS LOUD when the source has no upstream tracking branch', () => {
      stubCleanGit({ noUpstream: true })
      expect(() => docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')).toThrow(/no upstream/)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('FAILS LOUD when the source is in detached HEAD', () => {
      stubCleanGit({ branch: 'HEAD' })
      expect(() => docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')).toThrow(/detached HEAD/)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('does NOT sync for non-build modes (quick/recreate)', () => {
      docker.restart('/c.yml', 'audrey', 'quick', undefined, '/src/hermes')
      const calls = mockExecFileSync.mock.calls.map(joined)
      expect(calls.some((c) => c.includes('git -C'))).toBe(false)
    })

    it('does NOT sync when no build source is provided (image-only harness)', () => {
      docker.restart('/c.yml', 'audrey', 'rebuild')
      const calls = mockExecFileSync.mock.calls.map(joined)
      expect(calls.some((c) => c.includes('git -C'))).toBe(false)
      expect(mockSpawn).toHaveBeenCalled()
    })
  })

  describe('rebuild stamps build provenance into the image (HERMES_GIT_SHA)', () => {
    // Without this arg the Dockerfile's `ARG HERMES_GIT_SHA` stays empty and
    // /opt/hermes/.hermes_build_sha is never written — which is why, on
    // 2026-08-10, no running container could say what code it was built from
    // and 11 agents ran four-day-old buggy code invisibly.
    const FULL = 'a'.repeat(40)

    function stubGit() {
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        const a = args.join(' ')
        if (a.includes('rev-parse --is-inside-work-tree')) return Buffer.from('true')
        if (a.includes('status --porcelain')) return Buffer.from('')
        if (a.includes('rev-parse --abbrev-ref HEAD')) return Buffer.from('main')
        if (a.includes('symbolic-full-name @{u}')) return Buffer.from('origin/main')
        if (a.includes('rev-parse --short HEAD')) return Buffer.from(FULL.slice(0, 7))
        if (a.includes('rev-parse HEAD')) return Buffer.from(FULL)
        return Buffer.from('')
      })
    }

    /** Extract `--build-arg <value>` pairs from a spawned argv. */
    const buildArgOf = (argv: string[], key: string): string | undefined => {
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === '--build-arg' && argv[i + 1].startsWith(key + '=')) {
          return argv[i + 1].slice(key.length + 1)
        }
      }
      return undefined
    }

    it('passes the FULL sha (not the abbreviation) on the rebuild build step', () => {
      stubGit()
      docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')
      const argv = mockSpawn.mock.calls[0][1] as string[]
      expect(buildArgOf(argv, 'HERMES_GIT_SHA')).toBe(FULL)
      // A short sha can become ambiguous as the repo grows, and drift.ts
      // compares it against `git rev-parse HEAD`.
      expect(buildArgOf(argv, 'HERMES_GIT_SHA')).toHaveLength(40)
    })

    it('passes it on the purge build step too, alongside --no-cache', () => {
      stubGit()
      docker.restart('/c.yml', 'audrey', 'purge', undefined, '/src/hermes')
      const argv = mockSpawn.mock.calls[0][1] as string[]
      expect(argv).toContain('--no-cache')
      expect(buildArgOf(argv, 'HERMES_GIT_SHA')).toBe(FULL)
    })

    it('keeps the build-arg before the service name so compose parses it as a flag', () => {
      stubGit()
      docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')
      const argv = mockSpawn.mock.calls[0][1] as string[]
      expect(argv.indexOf('--build-arg')).toBeLessThan(argv.lastIndexOf('audrey'))
      expect(argv[argv.length - 1]).toBe('audrey')
    })

    it('omits the build-arg entirely when there is no build source to read a sha from', () => {
      // Better no provenance than a fabricated/empty sha baked into the image.
      docker.restart('/c.yml', 'audrey', 'rebuild')
      const argv = mockSpawn.mock.calls[0][1] as string[]
      expect(argv).not.toContain('--build-arg')
    })

    it('does not put a build-arg on the stop/up steps', () => {
      stubGit()
      docker.restart('/c.yml', 'audrey', 'rebuild', undefined, '/src/hermes')
      fireExit(0, 0)
      fireExit(1, 0)
      expect(mockSpawn.mock.calls[1][1]).not.toContain('--build-arg')
      expect(mockSpawn.mock.calls[2][1]).not.toContain('--build-arg')
    })
  })

  describe('diffContainer', () => {
    it('returns docker diff lines via an argv array (no shell)', async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: 'C /opt\nA /opt/iris\nC /opt/hermes/agent/tools.py\n',
        stderr: '',
      })
      const lines = await docker.diffContainer('hermes-iris')
      expect(lines).toEqual(['C /opt', 'A /opt/iris', 'C /opt/hermes/agent/tools.py'])
      const [file, argv] = mockExecFileAsync.mock.calls[0]
      expect(file).toBe('docker')
      expect(argv).toEqual(['diff', 'hermes-iris'])
    })

    it('returns [] when docker fails rather than throwing into the sweep', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('no such container'))
      await expect(docker.diffContainer('gone')).resolves.toEqual([])
    })
  })

  describe('start() — project + --env-file (Letta server bring-up)', () => {
    it('inserts --env-file as a top-level compose option before the subcommand', () => {
      docker.start('/repo/docker/letta-compose.yml', 'letta', 'letta', '/data/letta/.env')
      const argv = mockExecFileSync.mock.calls[0][1] as string[]
      // Order matters: `docker compose -p letta --env-file X -f Y up -d letta`.
      // --env-file must precede `up`, and -f must precede the service.
      const envIdx = argv.indexOf('--env-file')
      const upIdx = argv.indexOf('up')
      expect(argv[0]).toBe('compose')
      expect(argv.slice(0, envIdx)).toContain('letta') // -p letta present before --env-file
      expect(envIdx).toBeGreaterThan(-1)
      expect(argv[envIdx + 1]).toBe('/data/letta/.env')
      expect(envIdx).toBeLessThan(upIdx)
      expect(argv.slice(-3)).toEqual(['up', '-d', 'letta'])
    })

    it('omits --env-file entirely when none is passed', () => {
      docker.start('/c.yml', 'svc')
      const argv = mockExecFileSync.mock.calls[0][1] as string[]
      expect(argv).not.toContain('--env-file')
    })
  })

  describe('execInContainer', () => {
    it('runs docker exec with an argv array (no shell) and returns stdout', async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: 'ok\n', stderr: '' })
      const out = await docker.execInContainer('hermes-x', ['python3', '-c', 'print("ok")'])
      expect(out).toBe('ok\n')
      const [file, argv, opts] = mockExecFileAsync.mock.calls[0]
      expect(file).toBe('docker')
      // argv array, exec first, container next, then the command verbatim —
      // no /bin/sh, no string concatenation (F1–F5 security property).
      expect(argv).toEqual(['exec', 'hermes-x', 'python3', '-c', 'print("ok")'])
      expect((opts as { timeout: number }).timeout).toBe(60000)
    })

    it('propagates a custom timeout and rejects on failure', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('container hermes-x is not running'))
      await expect(docker.execInContainer('hermes-x', ['true'], 5000)).rejects.toThrow('is not running')
      expect((mockExecFileAsync.mock.calls[0][2] as { timeout: number }).timeout).toBe(5000)
    })
  })
})
