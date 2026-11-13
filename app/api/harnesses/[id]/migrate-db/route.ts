/**
 * POST /api/harnesses/:id/migrate-db (#204 PR2)
 *
 * Migrate one harness's SQLite DBs off the VirtioFS bind mount onto a named
 * Docker volume, via the symlink pattern:
 *
 *   1. surgically transform the EXISTING compose (never regenerate — the
 *      standalone generator would strip deploy-born/VPN extras): add the
 *      state-init service, the named volume, the /state mount, and the
 *      depends_on gate. Refuses (409) if the file can't be transformed.
 *   2. validate the transformed compose with `docker compose config`,
 *   3. stop the agent (quiesce the DB writer),
 *   4. write the compose and `up -d --force-recreate` — compose runs
 *      state-init to completion (service_completed_successfully) before the
 *      agent starts, so the DBs move while no writer exists,
 *   5. poll-verify: init container exited 0, host state.db is now a symlink,
 *      agent container is running.
 *
 * One harness at a time by design (canary discipline) — there is deliberately
 * no fleet-wide endpoint. Roll back per docs/runbooks/db-named-volume-migration.md.
 */
import { NextResponse } from 'next/server'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { services } from '@/lib/services'
import { agentDataDirForName } from '@/lib/services/harness'
import { addStateMigrationToCompose, stateVolumeName } from '@/lib/services/harness-compose'
import { isStateDbMigrated } from '@/lib/services/db-path'
import { requireHarness } from '@/lib/harness-ref'

type Step = { step: string; ok: boolean; detail?: string }

const VERIFY_TIMEOUT_MS = 90_000
const VERIFY_POLL_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** {status, exitCode} of a container, or null if it doesn't exist (yet). */
function inspectInit(container: string): { status: string; exitCode: number } | null {
  try {
    const out = execFileSync(
      'docker',
      ['inspect', container, '--format', '{{.State.Status}}|{{.State.ExitCode}}'],
      { stdio: 'pipe', timeout: 5000 },
    ).toString().trim()
    const [status, code] = out.split('|')
    // Unparseable exit code must read as FAILURE, not success — `|| 0` would
    // report "init exited 0" from garbage during exactly the incident where
    // accurate steps matter.
    const parsed = parseInt(code, 10)
    return { status: status || 'unknown', exitCode: Number.isFinite(parsed) ? parsed : -1 }
  } catch {
    return null
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { harness, refusal } = requireHarness(id)
  if (refusal) return refusal
  const steps: Step[] = []
  const fail = (status: number, error: string) =>
    NextResponse.json({ ok: false, error, steps }, { status })

  if (harness.runtime === 'letta' || harness.runtime === 'letta-server') {
    return fail(400, 'Letta rows have no agent state.db to migrate')
  }

  const target = services.harness.composeTarget(id)
  if (!target || !fs.existsSync(target.composeFile)) {
    return fail(409, `Harness ${id} has no compose file to transform`)
  }
  const dataDir = agentDataDirForName(harness.name)

  // --- 1. transform (or detect already-done) --------------------------------
  const compose = fs.readFileSync(target.composeFile, 'utf-8')
  let transformed: string
  try {
    transformed = addStateMigrationToCompose(compose, harness.name, dataDir)
  } catch (err) {
    // REFUSE — never fall back to a generator (it would strip deploy-born /
    // VPN / hand-edited extras from this compose).
    const msg = err instanceof Error ? err.message : String(err)
    steps.push({ step: 'transform-compose', ok: false, detail: msg })
    return fail(409, `${msg} (file: ${target.composeFile})`)
  }
  const composeChanged = transformed !== compose
  steps.push({
    step: 'transform-compose',
    ok: true,
    detail: composeChanged ? 'migration wiring added' : 'compose already has migration wiring',
  })

  if (!composeChanged && isStateDbMigrated(dataDir)) {
    return NextResponse.json({ ok: true, alreadyMigrated: true, steps })
  }

  // --- 2. validate before touching the real file ----------------------------
  if (composeChanged) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-migrate-')), 'docker-compose.yml')
    try {
      fs.writeFileSync(tmp, transformed)
      // --project-directory: relative paths (env_file, build context) must
      // resolve exactly as they will from the real location.
      execFileSync(
        'docker',
        ['compose', '--project-directory', path.dirname(target.composeFile), '-f', tmp, 'config', '-q'],
        { stdio: 'pipe', timeout: 30000 },
      )
      steps.push({ step: 'validate-compose', ok: true })
    } catch (err) {
      const stderr = String((err as { stderr?: unknown })?.stderr ?? '')
      const detail = (stderr.trim() || (err instanceof Error ? err.message : String(err))).slice(0, 500)
      steps.push({ step: 'validate-compose', ok: false, detail })
      return fail(500, `transformed compose failed validation: ${detail}`)
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    }
  }

  // --- 3. stop the writer ----------------------------------------------------
  try {
    services.harness.stop(id)
    steps.push({ step: 'stop-agent', ok: true })
  } catch (err) {
    steps.push({ step: 'stop-agent', ok: false, detail: err instanceof Error ? err.message : String(err) })
    return fail(500, 'failed to stop the agent — compose NOT modified')
  }

  // --- 4. write + recreate (runs state-init before the agent) ---------------
  if (composeChanged) {
    fs.writeFileSync(target.composeFile, transformed, 'utf-8')
    steps.push({ step: 'write-compose', ok: true })
  }
  try {
    services.harness.restart(id, 'recreate')
    steps.push({ step: 'recreate', ok: true })
  } catch (err) {
    steps.push({ step: 'recreate', ok: false, detail: err instanceof Error ? err.message : String(err) })
    return fail(500, 'recreate failed — see runbook for manual recovery')
  }

  // --- 5. verify -------------------------------------------------------------
  const initContainer = `state-init-${harness.name}`
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  let initOk = false
  let symlinkOk = false
  let agentRunning = false
  let initDetail = 'init container not seen'
  while (Date.now() < deadline) {
    const init = inspectInit(initContainer)
    if (init && init.status === 'exited') {
      initOk = init.exitCode === 0
      initDetail = `exit code ${init.exitCode}`
      if (!initOk) break
    }
    try {
      symlinkOk = fs.lstatSync(path.join(dataDir, 'state.db')).isSymbolicLink()
    } catch {
      symlinkOk = false
    }
    agentRunning = services.harness.agentHealth(id).running
    if (initOk && symlinkOk && agentRunning) break
    await sleep(VERIFY_POLL_MS)
  }
  steps.push({ step: 'verify-init', ok: initOk, detail: initDetail })
  steps.push({
    step: 'verify-symlink',
    ok: symlinkOk,
    detail: symlinkOk ? 'host state.db is a symlink' : 'host state.db is NOT a symlink',
  })
  steps.push({ step: 'verify-agent-running', ok: agentRunning })

  const ok = initOk && symlinkOk && agentRunning
  return NextResponse.json(
    {
      ok,
      volume: stateVolumeName(harness.name),
      snapshotNote: ok
        ? 'usage/cost will read state.db.snapshot once the exporter runs (≤ ~5 min); until then they report unknown, not 0'
        : undefined,
      steps,
    },
    { status: ok ? 200 : 500 },
  )
}
