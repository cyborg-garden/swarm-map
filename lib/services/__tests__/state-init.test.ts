import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  STATE_INIT_SCRIPT,
  MIGRATED_DB_FILES,
  stateInitService,
  stateVolumeName,
  generateStandaloneCompose,
  setComposeImage,
} from '@/lib/services/harness-compose'
import { generateAgentCompose } from '@/lib/services/agent-deploy-templates'

let root: string
let dataDir: string
let stateDir: string
let binDir: string
let chownLog: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-state-init-'))
  dataDir = path.join(root, 'data')
  stateDir = path.join(root, 'state')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(stateDir)
  // Shims first on PATH: tests run unprivileged, so a real chown to the agent
  // uid would fail. The chown shim records its args plus what the target dir
  // held at that moment; the id shim stands in for the image's hermes user.
  binDir = path.join(root, 'bin')
  chownLog = path.join(root, 'chown.log')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'chown'), [
    '#!/bin/sh',
    'for last; do :; done',
    'echo "$*" >> "$CHOWN_LOG"',
    'ls -A "$last" | tr "\\n" " " >> "$CHOWN_LOG"; echo >> "$CHOWN_LOG"',
    '[ -z "${FAKE_CHOWN_FAIL:-}" ]',
    '',
  ].join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'id'), [
    '#!/bin/sh',
    '[ -n "${FAKE_HERMES_ID:-}" ] && [ "$2" = hermes ] && { echo "$FAKE_HERMES_ID"; exit 0; }',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Run the REAL init script (the one embedded in every compose) via /bin/sh. */
function runInitScript(env: Record<string, string> = {}): string {
  // Strip any uid-remap vars from the developer's own shell so they can't leak in.
  const base = { ...process.env }
  for (const k of ['HERMES_UID', 'HERMES_GID', 'PUID', 'PGID']) delete base[k]
  return execFileSync('/bin/sh', ['-c', STATE_INIT_SCRIPT], {
    env: {
      ...base,
      PATH: `${binDir}:${process.env.PATH}`,
      CHOWN_LOG: chownLog,
      STATE_INIT_DATA: dataDir,
      STATE_INIT_STATE: stateDir,
      ...env,
    },
    stdio: 'pipe',
  }).toString()
}

/** Each chown call as [args, contents of the target dir at call time]. */
function chownCalls(): Array<[string, string]> {
  if (!fs.existsSync(chownLog)) return []
  const lines = fs.readFileSync(chownLog, 'utf-8').split('\n')
  const calls: Array<[string, string]> = []
  for (let i = 0; i + 1 < lines.length; i += 2) calls.push([lines[i], lines[i + 1].trim()])
  return calls
}

/** Create a WAL-mode DB (leaves -wal/-shm siblings on disk while open). */
function createWalDb(dbPath: string, marker: string): void {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run(marker)
  // Close WITHOUT checkpoint-truncate is not controllable via better-sqlite3;
  // write the wal siblings explicitly to model the mid-flight layout instead.
  db.close()
  fs.writeFileSync(`${dbPath}-wal`, 'wal-bytes')
  fs.writeFileSync(`${dbPath}-shm`, 'shm-bytes')
}

function readMarker(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    // The fake -wal/-shm siblings written by createWalDb are not valid WAL
    // content; a readonly open ignores them only if we read the main file, so
    // remove them first where the caller hasn't already.
    return (db.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }).v
  } finally {
    db.close()
  }
}

describe('STATE_INIT_SCRIPT (real script under sh)', { timeout: 30_000 }, () => {
  it('migrates regular DB files (with -wal/-shm) to the volume and symlinks back', () => {
    createWalDb(path.join(dataDir, 'state.db'), 'original')
    const out = runInitScript()
    expect(out).toContain('state-init: migration/symlinks OK')

    // Bind-mount path is now a symlink to the volume path.
    const link = path.join(dataDir, 'state.db')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(link)).toBe(path.join(stateDir, 'state.db'))
    // Real file (and siblings) live on the volume; no stragglers on the bind mount.
    expect(fs.statSync(path.join(stateDir, 'state.db')).isFile()).toBe(true)
    expect(fs.existsSync(path.join(stateDir, 'state.db-wal'))).toBe(true)
    expect(fs.existsSync(path.join(stateDir, 'state.db-shm'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'state.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'state.db-shm'))).toBe(false)
    // No leftover tmp files.
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('handles all three DBs', () => {
    for (const db of MIGRATED_DB_FILES) createWalDb(path.join(dataDir, db), db)
    runInitScript()
    for (const db of MIGRATED_DB_FILES) {
      expect(fs.lstatSync(path.join(dataDir, db)).isSymbolicLink()).toBe(true)
      expect(fs.statSync(path.join(stateDir, db)).isFile()).toBe(true)
    }
  })

  it('is idempotent — a second run leaves data intact', () => {
    createWalDb(path.join(dataDir, 'state.db'), 'original')
    runInitScript()
    // Clear the fake siblings so the DB is readable, then run again.
    fs.rmSync(path.join(stateDir, 'state.db-wal'))
    fs.rmSync(path.join(stateDir, 'state.db-shm'))
    runInitScript()
    expect(fs.lstatSync(path.join(dataDir, 'state.db')).isSymbolicLink()).toBe(true)
    expect(readMarker(path.join(stateDir, 'state.db'))).toBe('original')
  })

  it('creates a DANGLING symlink for a fresh harness (no empty file pre-created)', () => {
    runInitScript()
    const link = path.join(dataDir, 'state.db')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(link)).toBe(false) // dangling — target not created
    expect(fs.existsSync(path.join(stateDir, 'state.db'))).toBe(false)

    // SQLite O_CREAT follows the link: creating the DB "at" the bind path
    // lands the real file on the volume.
    const db = new Database(link)
    db.exec('CREATE TABLE t (v TEXT)')
    db.close()
    expect(fs.statSync(path.join(stateDir, 'state.db')).isFile()).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it('regular file WINS: a hermes import that replaced the symlink re-migrates over the volume copy', () => {
    // Migrated state: old data on the volume, symlink on the bind mount.
    createWalDb(path.join(dataDir, 'state.db'), 'old')
    runInitScript()
    fs.rmSync(path.join(stateDir, 'state.db-wal'))
    fs.rmSync(path.join(stateDir, 'state.db-shm'))

    // `hermes import` replaces the symlink with a regular file (newer data).
    fs.rmSync(path.join(dataDir, 'state.db'))
    const imported = new Database(path.join(dataDir, 'state.db'))
    imported.exec('CREATE TABLE t (v TEXT)')
    imported.prepare('INSERT INTO t (v) VALUES (?)').run('imported')
    imported.close()

    runInitScript()
    expect(fs.lstatSync(path.join(dataDir, 'state.db')).isSymbolicLink()).toBe(true)
    expect(readMarker(path.join(stateDir, 'state.db'))).toBe('imported')
  })

  it('removes EMPTY orphan -wal and any -shm siblings left on the bind mount', () => {
    createWalDb(path.join(dataDir, 'state.db'), 'x')
    runInitScript()
    // Empty -wal carries no transactions; -shm is a shared-memory index, never
    // authoritative data — both are safe to sweep.
    fs.writeFileSync(path.join(dataDir, 'state.db-wal'), '')
    fs.writeFileSync(path.join(dataDir, 'state.db-shm'), 'shm-bytes')
    runInitScript()
    expect(fs.existsSync(path.join(dataDir, 'state.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'state.db-shm'))).toBe(false)
  })

  it('REFUSES (exit 1) to delete a NON-EMPTY orphan -wal beside a migrated db', () => {
    // Regression (#204 PR2 review): a non-empty regular -wal next to a
    // symlinked db can hold committed-not-checkpointed transactions (SQLite
    // symlink-derivation assumption violated, or a partial restore). Deleting
    // it would be silent data loss — the script must fail loudly instead so
    // the depends_on gate keeps the agent down for a human.
    createWalDb(path.join(dataDir, 'state.db'), 'x')
    runInitScript()
    fs.writeFileSync(path.join(dataDir, 'state.db-wal'), 'committed-frames')
    let failure: (Error & { status?: number; stderr?: Buffer }) | null = null
    try {
      runInitScript()
    } catch (err) {
      failure = err as Error & { status?: number; stderr?: Buffer }
    }
    expect(failure).not.toBeNull()
    expect(failure!.status).toBe(1)
    expect(String(failure!.stderr)).toContain('REFUSING')
    // The suspect WAL must survive for manual recovery.
    expect(fs.readFileSync(path.join(dataDir, 'state.db-wal'), 'utf-8')).toBe('committed-frames')
  })

  it('recovers from an interrupted run (volume tmp files present, source intact)', () => {
    createWalDb(path.join(dataDir, 'state.db'), 'source')
    // A previous run died after writing tmp copies but before the rename.
    fs.writeFileSync(path.join(stateDir, 'state.db.tmp'), 'torn partial copy')
    runInitScript()
    expect(fs.lstatSync(path.join(dataDir, 'state.db')).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    fs.rmSync(path.join(stateDir, 'state.db-wal'))
    fs.rmSync(path.join(stateDir, 'state.db-shm'))
    expect(readMarker(path.join(stateDir, 'state.db'))).toBe('source')
  })
})

describe('STATE_INIT_SCRIPT /state ownership (resolved like the image\'s stage2)', () => {
  it('chowns /state recursively to 10000:10000 when the image has no hermes user to ask', () => {
    const out = runInitScript()
    expect(chownCalls().map(([args]) => args)).toEqual([`-R 10000:10000 ${stateDir}`])
    expect(out).toContain(`(${stateDir} owned by 10000:10000)`)
  })

  it("uses the image's hermes uid/gid when present", () => {
    runInitScript({ FAKE_HERMES_ID: '4242' })
    expect(chownCalls().map(([args]) => args)).toEqual([`-R 4242:4242 ${stateDir}`])
  })

  it('never derives the owner from the data dir (unreliable on macOS VirtioFS)', () => {
    expect(STATE_INIT_SCRIPT).not.toMatch(/\bstat\b/)
  })

  it('chowns AFTER migration, so migrated DBs and their -wal/-shm are covered', () => {
    createWalDb(path.join(dataDir, 'state.db'), 'x')
    runInitScript()
    const [[, contents]] = chownCalls()
    expect(contents.split(' ').sort()).toEqual(['state.db', 'state.db-shm', 'state.db-wal'])
  })

  it.each([
    ['HERMES_UID/HERMES_GID', { HERMES_UID: '1000', HERMES_GID: '1001' }, '1000:1001'],
    ['PUID/PGID aliases', { PUID: '99', PGID: '100' }, '99:100'],
    ['HERMES_UID over PUID', { HERMES_UID: '1000', PUID: '99' }, '1000:10000'],
    ['non-numeric ids are ignored', { HERMES_UID: 'abc', HERMES_GID: '1x' }, '10000:10000'],
    ['root is never a remap target', { HERMES_UID: '0', HERMES_GID: '0' }, '10000:10000'],
  ])('honours the remap env: %s', (_label, env, owner) => {
    runInitScript(env)
    expect(chownCalls().map(([args]) => args)).toEqual([`-R ${owner} ${stateDir}`])
  })

  it("reads the remap vars from the agent .env (export/quotes/comments), compose env winning", () => {
    fs.writeFileSync(path.join(dataDir, '.env'), [
      'OPENROUTER_API_KEY=sk-not-a-uid',
      'export HERMES_UID="1000"  # host user',
      "PGID='100'",
      'HERMES_GID=5',
      'HERMES_GID=1001\r',
      '',
    ].join('\n'))
    runInitScript()
    expect(chownCalls().map(([args]) => args)).toEqual([`-R 1000:1001 ${stateDir}`])

    fs.rmSync(chownLog)
    runInitScript({ HERMES_UID: '2000' })
    expect(chownCalls().map(([args]) => args)).toEqual([`-R 2000:1001 ${stateDir}`])
  })

  it('a failed chown warns but does not keep the agent down', () => {
    const res = spawnSync('/bin/sh', ['-c', STATE_INIT_SCRIPT], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CHOWN_LOG: chownLog,
        FAKE_CHOWN_FAIL: '1',
        STATE_INIT_DATA: dataDir,
        STATE_INIT_STATE: stateDir,
      },
    })
    expect(res.status).toBe(0)
    expect(String(res.stdout)).toContain('state-init: migration/symlinks OK')
    expect(String(res.stderr)).toContain(`WARNING: could not chown ${stateDir}`)
  })
})

describe('compose generators emit the migration wiring', () => {
  const cases: Array<[string, string]> = [
    ['plain standalone', generateStandaloneCompose('sci', 8642, '/home/u/.hermes-sci', {})],
    ['vpn standalone', generateStandaloneCompose('sci', 8642, '/home/u/.hermes-sci', { vpnEnabled: true })],
    ['deploy-born', generateAgentCompose('sci', 8642, '/home/u/.hermes-sci', { image: 'ghcr.io/x:latest' })],
  ]

  it.each(cases)('%s: init service + named volume + depends_on gate', (_label, c) => {
    expect(c).toContain('  state-init-sci:')
    expect(c).toContain('container_name: state-init-sci')
    expect(c).toContain('restart: "no"')
    // hermes gated on init completion
    expect(c).toMatch(/state-init-sci:\s*\n\s*condition: service_completed_successfully/)
    // volume mounted into both services
    expect(c.split('- hermes-state-sci:/state').length).toBe(3)
    // top-level volume with pinned name (project-prefix-proof)
    expect(c).toMatch(/^volumes:\n  hermes-state-sci:\n    name: hermes-state-sci$/m)
    // compose interpolation escape: shell vars appear as $$, never bare $VAR
    expect(c).toContain('$$DATA')
    expect(c).not.toMatch(/[^$]\$[A-Za-z{(]/)
  })

  it('vpn variant keeps wireguard in map form alongside the init gate', () => {
    const c = generateStandaloneCompose('sci', 8642, '/home/u/.hermes-sci', { vpnEnabled: true, bundledOllama: true })
    expect(c).toMatch(/wireguard:\s*\n\s*condition: service_started/)
    expect(c).toMatch(/ollama-sci:\s*\n\s*condition: service_healthy/)
    // The hermes service itself must not mix list-form deps with the map-form
    // init gate (camofox, a separate service, legitimately keeps list form).
    const hermesBlock = c.slice(c.indexOf('  hermes-sci:'))
    expect(hermesBlock).not.toMatch(/depends_on:\s*\n\s*- wireguard/)
  })

  it('stateInitService reuses the hermes source block', () => {
    const svc = stateInitService('sci', '/d', '    image: ghcr.io/x:1')
    expect(svc).toContain('    image: ghcr.io/x:1')
    expect(stateVolumeName('sci')).toBe('hermes-state-sci')
  })

  it('escapes the owner resolution for compose ($$, resolved at run time)', () => {
    const c = generateStandaloneCompose('sci', 8642, '/d', {})
    expect(c).toContain('uid="$${HERMES_UID:-$$(envf HERMES_UID)}"')
    expect(c).toContain('chown -R "$$uid:$$gid" "$$STATE"')
  })

  it.each([
    ['plain', {}],
    ['vpn', { vpnEnabled: true }],
  ])('%s: passes ONLY the uid-remap extraEnv entries to the init service', (_label, opts) => {
    const c = generateStandaloneCompose('sci', 8642, '/d', {
      ...opts,
      extraEnv: { PUID: '1000', PGID: '100', FOO: 'bar' },
    })
    const init = c.slice(c.indexOf('  state-init-sci:'), c.indexOf('    entrypoint:'))
    expect(init).toContain('    environment:\n      - PUID=1000\n      - PGID=100\n')
    expect(init).not.toContain('FOO')
  })

  it('emits no environment block on the init service without remap vars', () => {
    const svc = stateInitService('sci', '/d', '    image: ghcr.io/x:1', '      - FOO=bar\n')
    expect(svc).not.toMatch(/^ {4}environment:$/m)
  })

  it('setComposeImage rewrites BOTH the hermes and init source blocks', () => {
    const c = generateStandaloneCompose('sci', 8642, '/d', { imageOrBuild: { build: '/src/hermes' } })
    const out = setComposeImage(c, 'ghcr.io/pinned:1')
    expect(out).not.toContain('build:')
    expect(out.split('image: ghcr.io/pinned:1').length).toBe(3) // hermes + init
  })
})
