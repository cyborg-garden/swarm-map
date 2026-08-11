import { execFile, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import type { RestartMode } from '@/lib/types'

const execFileAsync = promisify(execFile)

// SECURITY: every subprocess in this file is invoked via execFileSync/spawn with
// an argv ARRAY and no shell. Never reintroduce a string command run through
// /bin/sh (execSync, `sh -c`, exec) — settings-derived values (composeFile,
// image, hermesDir, service) reach these calls and a shell would make any
// metacharacter in them an injection point (findings F1–F5, 2026-07 review).

type ContainerInfo = {
  name: string
  service: string
  state: string
}

export type ComposeProject = {
  name: string
  status: string
  configFiles: string[]
}

export type ContainerDetails = {
  name: string
  service: string
  state: string
  status: string
  ports: Array<{ published: number; target: number }>
  startedAt?: string
  composeFile?: string
  project?: string
}

export type ContainerStats = {
  cpu: number
  memMiB: number
}

export class DockerService {
  isAvailable(): boolean {
    try {
      execFileSync('docker', ['version'], { stdio: 'pipe', timeout: 5000 })
      return true
    } catch {
      return false
    }
  }

  listContainers(composeFile: string): ContainerInfo[] {
    try {
      const output = execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'ps', '--format', 'json'],
        { stdio: 'pipe', timeout: 10000 }
      ).toString()

      const parsed = JSON.parse(output)
      const items = Array.isArray(parsed) ? parsed : [parsed]

      return items.map((c: Record<string, string>) => ({
        name: c.Name,
        service: c.Service,
        state: c.State,
      }))
    } catch {
      return []
    }
  }

  listComposeProjects(): ComposeProject[] {
    try {
      const output = execFileSync('docker', ['compose', 'ls', '--format', 'json'], {
        stdio: 'pipe',
        timeout: 10000,
      }).toString()
      const parsed = JSON.parse(output)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      return items.map((p: Record<string, string>) => ({
        name: p.Name,
        status: p.Status,
        configFiles: p.ConfigFiles ? p.ConfigFiles.split(',').map((f) => f.trim()) : [],
      }))
    } catch {
      return []
    }
  }

  inspectContainers(projectName: string): ContainerDetails[] {
    try {
      const output = execFileSync(
        'docker',
        ['compose', '-p', projectName, 'ps', '--format', 'json'],
        { stdio: 'pipe', timeout: 10000 }
      ).toString()

      // docker compose ps outputs one JSON object per line (not a JSON array)
      const lines = output.trim().split('\n').filter((l) => l.trim())
      const items = lines.map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)

      return items.map((c: Record<string, unknown>) => {
        const publishers = (c.Publishers as Array<Record<string, number>> | null) ?? []
        const ports = publishers
          .filter((p) => p.PublishedPort > 0)
          .map((p) => ({ published: p.PublishedPort, target: p.TargetPort }))

        // Extract config files from Labels if available
        const labels = c.Labels as string | null
        let composeFile: string | undefined
        let project: string | undefined
        if (labels) {
          const cfMatch = labels.match(/com\.docker\.compose\.project\.config_files=([^,]+)/)
          if (cfMatch) composeFile = cfMatch[1]
          const projMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/)
          if (projMatch) project = projMatch[1]
        }

        return {
          name: c.Name as string,
          service: c.Service as string,
          state: c.State as string,
          status: c.Status as string,
          ports,
          composeFile,
          project,
        }
      })
    } catch {
      return []
    }
  }

  // Get stats for ALL containers in one call (avoids per-container 10s penalty)
  getAllContainerStats(): Record<string, ContainerStats> {
    try {
      const output = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{json .}}'],
        { stdio: 'pipe', timeout: 15000 }
      ).toString().trim()

      const result: Record<string, ContainerStats> = {}
      for (const line of output.split('\n').filter((l) => l.trim())) {
        try {
          const parsed = JSON.parse(line)
          const name: string = parsed.Name ?? ''
          const cpuStr: string = parsed.CPUPerc ?? '0%'
          const memStr: string = parsed.MemUsage ?? '0MiB / 0GiB'

          const cpu = parseFloat(cpuStr.replace('%', '')) || 0
          const memMatch = memStr.match(/^([\d.]+)(\w+)/)
          let memMiB = 0
          if (memMatch) {
            const val = parseFloat(memMatch[1])
            const unit = memMatch[2].toUpperCase()
            if (unit === 'GIB') memMiB = val * 1024
            else if (unit === 'MIB') memMiB = val
            else if (unit === 'KIB') memMiB = val / 1024
            else memMiB = val
          }

          result[name] = { cpu, memMiB: Math.round(memMiB) }
        } catch {
          // skip unparseable lines
        }
      }
      return result
    } catch {
      return {}
    }
  }

  getContainerDetails(containerName: string): { startedAt?: string } {
    try {
      const output = execFileSync(
        'docker',
        ['inspect', containerName, '--format', '{{json .State}}'],
        { stdio: 'pipe', timeout: 10000 }
      ).toString().trim()
      const state = JSON.parse(output)
      return { startedAt: state.StartedAt }
    } catch {
      return {}
    }
  }

  /**
   * Bring a local build-source checkout up to the code it's SUPPOSED to build
   * before a `--build` reads it. Without this, a rebuild silently ships
   * whatever happens to be checked out — which already burned us once when a
   * checkout sat 1 commit behind main and a rebuild shipped stale code.
   *
   * Behavior (fail loud over ship stale):
   *   - not a git repo            → throw
   *   - dirty working tree        → throw (don't stash/discard someone's WIP)
   *   - no upstream tracking ref  → throw
   *   - can't fast-forward        → throw (diverged / detached — needs a human)
   *   - otherwise                 → fetch + `merge --ff-only @{u}`
   *
   * Returns the ref it synced to and the commit it will build from, for logging.
   *
   * `commit` is the short sha (human-facing, used in log lines). `commitFull`
   * is the same commit unabbreviated — it is stamped into the image via the
   * HERMES_GIT_SHA build-arg (see restart()) so a RUNNING container can be
   * asked what code it was built from. A short sha is not enough there:
   * provenance is compared against `git rev-parse HEAD` in the build source and
   * counted with `rev-list`, and an abbreviation can become ambiguous as the
   * repo grows.
   */
  syncBuildSource(sourceDir: string): { branch: string; commit: string; commitFull: string; upstream: string } {
    const git = (args: string[]) =>
      execFileSync('git', ['-C', sourceDir, ...args], { stdio: 'pipe', timeout: 120000 })
        .toString()
        .trim()

    // Must be a git work tree.
    try {
      if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
        throw new Error('not a git work tree')
      }
    } catch (err) {
      throw new Error(
        `rebuild: build source ${sourceDir} is not a git repo — refusing to build (would ship un-synced code). ${err instanceof Error ? err.message : ''}`,
      )
    }

    // Refuse to build over uncommitted local changes — could ship un-pushed
    // edits, and a stash here could silently drop someone's WIP.
    const dirty = git(['status', '--porcelain'])
    if (dirty) {
      throw new Error(
        `rebuild: build source ${sourceDir} has uncommitted changes — refusing to build (would ship un-synced code). Commit/stash/clean it, then rebuild.`,
      )
    }

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch === 'HEAD') {
      throw new Error(
        `rebuild: build source ${sourceDir} is in detached HEAD — refusing to build. Check out the intended branch, then rebuild.`,
      )
    }

    // Resolve the configured upstream tracking ref (e.g. origin/main).
    let upstream: string
    try {
      upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    } catch {
      throw new Error(
        `rebuild: build source ${sourceDir} (branch ${branch}) has no upstream tracking branch — refusing to build. Set one with \`git branch --set-upstream-to\`, then rebuild.`,
      )
    }

    // Fetch then fast-forward only. A non-ff (diverged history) fails loud.
    git(['fetch'])
    try {
      git(['merge', '--ff-only', upstream])
    } catch {
      throw new Error(
        `rebuild: build source ${sourceDir} (branch ${branch}) cannot fast-forward to ${upstream} — local history has diverged. Refusing to build. Reconcile manually, then rebuild.`,
      )
    }

    const commitFull = git(['rev-parse', 'HEAD'])
    const commit = git(['rev-parse', '--short', 'HEAD'])
    return { branch, commit, commitFull, upstream }
  }

  restart(composeFile: string, service: string, mode: RestartMode, projectName?: string, buildSource?: string | null): void {
    const projArgs = projectName ? ['-p', projectName] : []

    // For modes that run `--build`, sync the local source to the code it's
    // supposed to build FIRST. Throws (fail loud) rather than shipping stale.
    //
    // PROVENANCE (drift visibility): the resolved commit is also passed through
    // to the build as HERMES_GIT_SHA. hermes-agent-mt's Dockerfile already
    // declares `ARG HERMES_GIT_SHA` and writes it to /opt/hermes/.hermes_build_sha,
    // but nothing here ever supplied the arg — so the file did not exist in ANY
    // running container and no running agent could say what code it was built
    // from. That is why 11 agents ran four-day-old code carrying the
    // tool-result-deletion bug for days with nothing anywhere saying "behind".
    // Without this arg lib/services/drift.ts can only ever report
    // `unknown-no-provenance`.
    const buildArgs: string[] = []
    if ((mode === 'rebuild' || mode === 'purge') && buildSource) {
      const synced = this.syncBuildSource(buildSource)
      buildArgs.push('--build-arg', `HERMES_GIT_SHA=${synced.commitFull}`)
      // eslint-disable-next-line no-console
      console.log(
        `[rebuild] ${service}: building ${buildSource} @ ${synced.branch} ${synced.commit} (synced to ${synced.upstream})`,
      )
    }

    const detach = (args: string[]) => {
      const child = spawn('docker', args, { stdio: 'ignore', detached: true })
      child.unref()
      return child
    }

    // Fire-and-forget SEQUENCE: each step spawns only after the previous one
    // exits 0 (chained on the exit event — no shell, argv arrays throughout).
    // A failed step stops the chain: fail-stop beats fail-race.
    const chainDetached = (steps: string[][]) => {
      const runFrom = (i: number) => {
        const child = spawn('docker', steps[i], { stdio: 'ignore', detached: true })
        if (i + 1 < steps.length) {
          child.on('exit', (code) => {
            if (code === 0) runFrom(i + 1)
          })
        }
        child.unref()
      }
      runFrom(0)
    }

    // DATA SAFETY (#204 PR2): every mode that recreates MUST stop the service
    // synchronously-in-sequence BEFORE `up`. `up -d --force-recreate <svc>`
    // converges dependencies first: the one-shot state-init service (DB
    // migration / post-import self-heal) runs to completion while the OLD
    // container is still running — copying live WAL-mode SQLite files under an
    // active writer, then deleting the originals: the exact torn-copy
    // corruption class #204 exists to eliminate. Stopping first changes
    // nothing semantically (recreate destroys the container anyway) and makes
    // the init copy race-free. Do NOT "optimize" the stop away.
    const stopArgs = ['compose', ...projArgs, '-f', composeFile, 'stop', service]
    const upArgs = ['compose', ...projArgs, '-f', composeFile, 'up', '-d', '--force-recreate', service]

    switch (mode) {
      case 'quick': {
        // Plain restart: never (re)creates containers, so state-init does not
        // run — no stop needed.
        detach(['compose', ...projArgs, '-f', composeFile, 'restart', service])
        break
      }
      case 'recreate': {
        // Recreate the container WITHOUT rebuilding the image — the correct
        // primitive for env_file changes (e.g. rotated API keys), which a plain
        // `restart` would not reload. Fast; no image build. Stop-first: see
        // the data-safety note above.
        chainDetached([stopArgs, upArgs])
        break
      }
      case 'rebuild': {
        // Build FIRST (cached), stop only after the build succeeds — the agent
        // keeps running during the build and the stop→up window stays small.
        // Fire-and-forget: Docker builds can exceed any reasonable timeout.
        chainDetached([
          ['compose', ...projArgs, '-f', composeFile, 'build', ...buildArgs, service],
          stopArgs,
          upArgs,
        ])
        break
      }
      case 'purge': {
        // Same as rebuild but --no-cache. Build → stop → up, each chained on
        // the previous step's clean exit.
        chainDetached([
          ['compose', ...projArgs, '-f', composeFile, 'build', '--no-cache', ...buildArgs, service],
          stopArgs,
          upArgs,
        ])
        break
      }
    }
  }

  start(composeFile: string, service: string, projectName?: string, envFile?: string): void {
    const projArgs = projectName ? ['-p', projectName] : []
    // `--env-file` is a top-level compose option (before the subcommand). Used by
    // the Letta server bring-up to inject server-wide provider keys from a
    // 0600 .env without mutating this process's environment.
    const envArgs = envFile ? ['--env-file', envFile] : []
    execFileSync('docker', ['compose', ...projArgs, ...envArgs, '-f', composeFile, 'up', '-d', service], {
      stdio: 'pipe',
      timeout: 60000,
    })
  }

  stop(composeFile: string, service: string, projectName?: string): void {
    const projArgs = projectName ? ['-p', projectName] : []
    execFileSync('docker', ['compose', ...projArgs, '-f', composeFile, 'stop', service], {
      stdio: 'pipe',
      timeout: 30000,
    })
  }

  /**
   * Stop AND REMOVE a project's containers (networks too; volumes are NOT
   * touched — never pass -v here). Used by harness delete: `docker volume rm`
   * refuses while any container (even an exited one, e.g. state-init-<name>)
   * still references the volume, so delete must `down` rather than `stop`.
   */
  down(composeFile: string, projectName?: string): void {
    const projArgs = projectName ? ['-p', projectName] : []
    execFileSync('docker', ['compose', ...projArgs, '-f', composeFile, 'down'], {
      stdio: 'pipe',
      timeout: 60000,
    })
  }

  /** Remove a named volume. Throws on failure (incl. "no such volume"). */
  removeVolume(name: string): void {
    execFileSync('docker', ['volume', 'rm', name], { stdio: 'pipe', timeout: 30000 })
  }

  /**
   * Run a one-shot throwaway container (docker run --rm) with the given
   * mounts, executing a /bin/sh script. Used by duplicate to cold-copy DB
   * files out of a STOPPED source's state volume (no writer → plain cp is
   * consistent). Synchronous; argv array, no host shell.
   */
  runOneShot(image: string, mounts: string[], shellScript: string, timeoutMs = 120000): void {
    const volArgs = mounts.flatMap((m) => ['-v', m])
    execFileSync(
      'docker',
      ['run', '--rm', ...volArgs, '--entrypoint', '/bin/sh', image, '-c', shellScript],
      { stdio: 'pipe', timeout: timeoutMs },
    )
  }

  pullImage(image: string): { ok: boolean; error?: string } {
    try {
      execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: 300000 })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Pull failed' }
    }
  }

  healthCheck(url: string, timeoutMs: number = 30000): boolean {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        execFileSync('curl', ['-sf', url], { stdio: 'pipe', timeout: 5000 })
        return true
      } catch {
        execFileSync('sleep', ['2'], { stdio: 'pipe' })
      }
    }
    return false
  }

  /**
   * Low-level container state for canary checks after a recreate. Returns null
   * if the container doesn't exist (e.g. mid-recreate or never started).
   */
  inspectState(service: string): { running: boolean; status: string; restartCount: number; startedAt: string } | null {
    try {
      // NOTE: RestartCount is a TOP-LEVEL field in `docker inspect`, not under .State.
      // `{{.State.RestartCount}}` errors the whole template → execFileSync throws → this
      // returns null → /api/harnesses/:id/health reports every agent unhealthy.
      const out = execFileSync(
        'docker',
        ['inspect', service, '--format', '{{.State.Running}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}'],
        { stdio: 'pipe', timeout: 5000 },
      ).toString().trim()
      const [running, status, rc, startedAt] = out.split('|')
      return { running: running === 'true', status: status || 'unknown', restartCount: parseInt(rc, 10) || 0, startedAt: startedAt || '' }
    } catch {
      return null
    }
  }

  /**
   * Run a command inside a running container (docker exec) and return stdout.
   *
   * ASYNC on purpose: the callers are the DB snapshot exporter and the
   * integrity transport for volume-migrated DBs — a multi-hundred-MB SQLite
   * backup/quick_check must not block the single pm2 fork's event loop the way
   * synchronous better-sqlite3 access did (issue #204: matilde's 287MB DB
   * blocked ~3.2s per check).
   *
   * argv array + no shell, per the security header at the top of this file.
   */
  async execInContainer(container: string, argv: string[], timeoutMs = 60000): Promise<string> {
    const { stdout } = await execFileAsync('docker', ['exec', container, ...argv], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout.toString()
  }

  /**
   * Filesystem changes made to a running container's writable layer since its
   * image was built (`docker diff`), as raw `<A|C|D> <path>` lines.
   *
   * Used by drift detection to spot a HOT-PATCHED container: someone
   * `docker cp`-ing a fixed file into a running agent makes it behave correctly
   * right up until the next `--force-recreate`, which silently reverts it. This
   * really happened here. A container with modified code under /opt/hermes has
   * no trustworthy provenance — the baked-in build SHA no longer describes what
   * it is actually running.
   *
   * ASYNC for the same reason as execInContainer: `docker diff` walks the
   * container's layer and must not block the single pm2 fork's event loop when
   * the whole fleet is swept. Returns [] on any failure (container gone,
   * daemon down) — callers treat "can't tell" as unknown, never as clean.
   */
  async diffContainer(container: string, timeoutMs = 15000): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('docker', ['diff', container], {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      })
      return stdout.toString().split('\n').filter((l) => l.trim() !== '')
    } catch {
      return []
    }
  }

  getLogs(composeFile: string, service: string, lines: number = 50): string {
    try {
      return execFileSync(
        'docker',
        ['compose', '-f', composeFile, 'logs', `--tail=${lines}`, service],
        { stdio: 'pipe', timeout: 10000 }
      ).toString()
    } catch {
      return ''
    }
  }
}
