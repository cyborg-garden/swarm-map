/**
 * Move one agent onto the broker: back up, strip, enrol, recreate, check, and put
 * everything back if the check fails. Dry run unless apply is set.
 *
 * Output is names and outcomes only. The script reads .env files to edit them but
 * nothing it logs or returns ever contains a value.
 *
 * It recreates with --no-build on purpose. A hand-run compose build leaves the
 * image with no SHA stamp and blinds HSM's drift check, so if the image lacks the
 * broker code this refuses and points at HSM's rebuild.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { AGENT_CONFIG_FILE, DEFAULT_PORT, audit, enrollAgent, unenrollAgent } from './lib.mjs'

export const MARKER = '.hsm-github-broker'
export const CREDENTIAL_VARS = [
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID',
]
const LINE_RE = /^[ \t#]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/
// A GitHub token is recognisable under any name. A private key isn't: Google and SSH
// keys look the same, so a key counts only under a name that says GitHub. Keep this in
// step with lib/services/github-credential-check.ts. The check tells her to run
// `ghkey roll`, so everything flagged here has to be something the strip removes.
// "LS0tLS1CRUdJTi" is a base64 PEM header.
const TOKEN_RE = /^["']?(?:gh[pousr]_|github_pat_)/
const PEM_RE = /^["']?(?:-----BEGIN|LS0tLS1CRUdJTi)/
const GITHUB_NAME_RE = /GITHUB|(?:^|_)GH(?:_|$)/i

function credentialName(line) {
  const m = LINE_RE.exec(line.replace(/\r$/, ''))
  if (!m) return null
  const value = m[2].trim()
  const hit = CREDENTIAL_VARS.includes(m[1]) || TOKEN_RE.test(value) || (PEM_RE.test(value) && GITHUB_NAME_RE.test(m[1]))
  return hit ? m[1] : null
}

/** Names of credential variables in a .env body. Names only, by construction. */
export function scanEnvText(text) {
  return [...new Set(text.split('\n').map(credentialName).filter(Boolean))]
}

export function stripGithubCredentials(text) {
  return text.split('\n').filter((line) => !credentialName(line)).join('\n')
}

function homeFor(root, agent) {
  return agent === 'personal' ? path.join(root, '.hermes') : path.join(root, `.hermes-${agent}`)
}

function agentHomes(root) {
  const names = fs.readdirSync(root).filter((n) => n === '.hermes' || n.startsWith('.hermes-'))
  return names
    .map((n) => ({ agent: n === '.hermes' ? 'personal' : n.slice('.hermes-'.length), home: path.join(root, n) }))
    .filter((a) => fs.existsSync(path.join(a.home, '.env')))
}

/** Agents whose .env still has the App key, so the old key can't be deleted yet. */
export function agentsHoldingAppKey(root) {
  return agentHomes(root)
    .filter((a) => envFiles(a.home).some((f) => /^GITHUB_APP_PRIVATE_KEY_B64=/m.test(fs.readFileSync(f, 'utf-8'))))
    .map((a) => a.agent)
}

function profileDirs(home) {
  const profiles = path.join(home, 'profiles')
  if (!fs.existsSync(profiles)) return []
  return fs.readdirSync(profiles, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profiles, e.name))
}

function envFiles(home) {
  return [home, ...profileDirs(home)].map((d) => path.join(d, '.env')).filter((f) => fs.existsSync(f))
}

// Copies like .env.bak or .env-old hold the same secrets, along with lines that may
// exist nowhere else. So they get the same strip as .env and are never deleted. Same
// names as the health check.
function strayEnvCopies(home) {
  return [home, ...profileDirs(home)]
    .flatMap((d) => fs.readdirSync(d).filter((n) => n.startsWith('.env') && n !== '.env' && n !== '.env.example').map((n) => path.join(d, n)))
    .filter((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() && scanEnvText(fs.readFileSync(f, 'utf-8')).length > 0)
}

function writeLikeOriginal(file, content) {
  const tmp = `${file}.broker.tmp`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

function backupRoot(dir) {
  return path.join(dir, 'env-backups')
}

function makeBackup({ dir, agent, home }) {
  const where = path.join(backupRoot(dir), `${agent}--${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(where, { recursive: true, mode: 0o700 })
  fs.chmodSync(backupRoot(dir), 0o700)
  try {
    for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
      const to = path.join(where, path.relative(home, f))
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      fs.copyFileSync(f, to)
      fs.chmodSync(to, 0o600)
    }
  } catch (err) {
    // A partial copy must not become the newest backup that undo trusts.
    fs.rmSync(where, { recursive: true, force: true })
    throw err
  }
  return where
}

/**
 * Put a backup's GitHub lines back into a file that may have moved on. HSM can rotate
 * a key or add a surface after a roll, so the rest of the file wins and only the lines
 * the strip took come back. A GitHub line set since also wins. With nothing changed
 * since the roll, the backup comes back byte for byte.
 */
export function restoreCredentialLines(current, backup) {
  if (stripGithubCredentials(backup) === current) return backup
  const live = (line) => (/^[ \t]*#/.test(line) ? null : credentialName(line))
  const held = new Set(current.split('\n').map(live).filter(Boolean))
  const missing = backup.split('\n').filter((line) => credentialName(line) && !held.has(credentialName(line)))
  if (!missing.length) return current
  const gap = current === '' || current.endsWith('\n') ? '' : '\n'
  return `${current}${gap}${missing.join('\n')}\n`
}

function restoreBackup(where, home) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(where)) {
    const target = path.join(home, path.relative(where, f))
    const saved = fs.readFileSync(f, 'utf-8')
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      writeLikeOriginal(target, saved)
      continue
    }
    const current = fs.readFileSync(target, 'utf-8')
    const merged = restoreCredentialLines(current, saved)
    if (merged !== current) writeLikeOriginal(target, merged)
  }
}

// Newest first, so where two backups hold the same name the later value wins. A roll
// only backs up what is in .env at that moment, so a re-roll's backup can hold just a
// line that came back, and the original credentials are in an older one.
function unusedBackups(dir, agent) {
  if (!fs.existsSync(backupRoot(dir))) return []
  return fs.readdirSync(backupRoot(dir)).filter((n) => n.startsWith(`${agent}--`)).sort().reverse()
    .map((n) => path.join(backupRoot(dir), n))
}

// Kept until purge for by-hand recovery. It leaves the undo list, or a later undo would
// bring back a line she removed after this one.
function retireBackup(dir, where) {
  const used = path.join(backupRoot(dir), 'used')
  fs.mkdirSync(used, { recursive: true, mode: 0o700 })
  fs.renameSync(where, path.join(used, path.basename(where)))
}

function brokerConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
}

function brokerHealthy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

const LABELS = ['project', 'project.config_files', 'service']
  .map((l) => `{{index .Config.Labels "com.docker.compose.${l}"}}`).join('|')

function dockerClient({ docker = 'docker', dockerEnv = {} }) {
  return (args) => {
    const r = spawnSync(docker, args, { encoding: 'utf-8', timeout: 300_000, env: { ...process.env, ...dockerEnv } })
    return { rc: r.status ?? 1, out: (r.stdout ?? '').trim() }
  }
}

function locate(run, root, agent) {
  const container = `hermes-${agent}`
  const { rc, out } = run(['inspect', '--format', `${LABELS}|{{.State.Running}}`, container])
  const [project, file, service, running] = rc === 0 ? out.split('|') : []
  return {
    container,
    running: running === 'true',
    project: project || agent,
    file: (file || path.join(root, '.hermes-swarm-map', 'compose', agent, 'docker-compose.yml')).split(',')[0],
    service: service || container,
  }
}

const recreate = (run, c) =>
  run(['compose', '-p', c.project, '-f', c.file, 'up', '-d', '--no-deps', '--no-build', '--force-recreate', c.service]).rc === 0

// Prints a one-word reason only. gh output is the repo name, used then dropped.
// A public repo answers ls-remote with no auth at all, so it picks a private one.
const VERIFY_SH = `
[ -z "\${GITHUB_TOKEN:-}\${GH_TOKEN:-}\${GITHUB_PERSONAL_ACCESS_TOKEN:-}\${GITHUB_APP_PRIVATE_KEY_B64:-}" ] || { echo env-still-has-credential; exit 11; }
printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | grep -q '^password=ghs_' || { echo git-no-token; exit 12; }
repo=$(gh api 'installation/repositories?per_page=100' --jq '([.repositories[]|select(.private)][0] // .repositories[0]).full_name' 2>/dev/null) || { echo gh-failed; exit 13; }
[ -n "$repo" ] || { echo gh-no-repos; exit 13; }
git ls-remote "https://github.com/$repo" HEAD >/dev/null 2>&1 || { echo git-ls-remote-failed; exit 14; }
echo ok
`

// A PAT can reach repos outside the App's org; the broker can't. Show which owners
// this agent has checked out so a repo about to go dark gets seen first. The sed
// keeps only the part after github.com, so a token embedded in a URL can't print.
export const OWNERS_SH = `find /opt/data -maxdepth 4 -path '*/.git/config' 2>/dev/null | xargs sed -n 's#.*url = .*github\\.com[:/]\\([A-Za-z0-9_.-]*\\)/.*#\\1#p' 2>/dev/null | sort -u`

function checkoutOwners(run, c) {
  const { out } = run(['exec', c.container, 'sh', '-c', OWNERS_SH])
  return out.split('\n').filter((o) => /^[A-Za-z0-9_.-]+$/.test(o))
}

async function verify(run, c, { verifyDeadlineMs, pollMs }) {
  const args = ['exec', '-u', 'hermes', '-e', 'HOME=/opt/data/home', '-e', 'GIT_TERMINAL_PROMPT=0', c.container, 'sh', '-c', VERIFY_SH]
  const deadline = Date.now() + verifyDeadlineMs
  let last = 'no-answer'
  for (;;) {
    const r = run(args)
    if (r.rc === 0 && r.out.endsWith('ok')) return { ok: true }
    last = /^[a-z-]+$/.test(r.out) ? r.out : 'container-not-ready'
    if (Date.now() >= deadline) return { ok: false, reason: last }
    await new Promise((res) => setTimeout(res, pollMs))
  }
}

// The code only: a message can quote the file it failed on.
const errorName = (err) => err.code ?? err.name

const AGENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REBUILD_HINT = 'its image lacks the broker code. Rebuild through HSM first (mode "rebuild"), not by hand, so the drift check keeps working'

async function preflight({ dir, root, agent, home, run, acceptLoss }) {
  const problems = []
  const warnings = []
  if (!fs.existsSync(path.join(home, '.env'))) problems.push(`no .env at ${home}`)
  if (!fs.existsSync(path.join(dir, 'private-key.pem'))) problems.push('no App key on this host yet. Run ghkey first')
  let port = DEFAULT_PORT
  try {
    port = brokerConfig(dir).port ?? DEFAULT_PORT
  } catch {
    problems.push('no broker config. Run ghkey setup first')
  }
  if (!(await brokerHealthy(port))) problems.push(`the broker is not answering on port ${port}`)
  const c = locate(run, root, agent)
  if (!c.running) problems.push(`${c.container} is not running`)
  else if (run(['exec', c.container, '/opt/hermes/.venv/bin/python', '-c', 'from hermes_cli.github_app_token import read_broker_config']).rc !== 0) {
    problems.push(`${c.container}: ${REBUILD_HINT}`)
  }
  let config = ''
  try { config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf-8') } catch { /* no config is fine */ }
  const lossy = []
  if (config.includes('GITHUB_PERSONAL_ACCESS_TOKEN')) lossy.push('an MCP server in config.yaml reads GITHUB_PERSONAL_ACCESS_TOKEN')
  if (/copilot/i.test(config)) lossy.push('config.yaml mentions copilot, which can auth with GITHUB_TOKEN')
  for (const l of lossy) (acceptLoss ? warnings : problems).push(`${l}${acceptLoss ? '; continuing as asked' : '. It would stop working; pass --accept-loss to go ahead anyway'}`)
  return { problems, warnings, port, c }
}

export async function rollout({
  agent, homeRoot, dir, apply = false, acceptLoss = false, docker, dockerEnv, verifyDeadlineMs = 180_000, pollMs = 5000,
}) {
  const lines = []
  if (!AGENT_RE.test(agent ?? '')) return { ok: false, applied: false, lines: ['bad agent name'] }
  const run = dockerClient({ docker, dockerEnv })
  const home = homeFor(homeRoot, agent)
  if (!fs.existsSync(home)) return { ok: false, applied: false, lines: [`no home at ${home}`] }

  const { problems, warnings, port, c } = await preflight({ dir, root: homeRoot, agent, home, run, acceptLoss })
  try {
    for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
      const names = scanEnvText(fs.readFileSync(f, 'utf-8'))
      lines.push(`${path.relative(home, f)}: ${names.length ? names.join(', ') : 'clean'}`)
    }
  } catch (err) {
    problems.push(`could not read its .env files (${errorName(err)})`)
  }
  if (c.running) {
    const owners = checkoutOwners(run, c)
    if (owners.length) lines.push(`Repo owners in its checkouts: ${owners.join(', ')}. The broker only reaches the App's own org.`)
  }
  for (const w of warnings) lines.push(`warning: ${w}`)
  for (const p of problems) lines.push(`BLOCKED: ${p}`)
  if (problems.length) return { ok: false, applied: false, lines }
  if (!apply) {
    lines.push(`DRY RUN: nothing changed. Add --apply to switch ${agent}.`)
    return { ok: true, applied: false, lines }
  }

  const wasEnrolled = fs.existsSync(path.join(home, AGENT_CONFIG_FILE))
  const note = (event, fields) => {
    try { audit(dir, event, fields) } catch { /* the log must not undo the work */ }
  }
  let backup = null
  let result = null
  try {
    const hasCreds = [...envFiles(home), ...strayEnvCopies(home)]
      .some((f) => scanEnvText(fs.readFileSync(f, 'utf-8')).length > 0)
    // A re-run on a clean agent has nothing to save.
    if (hasCreds) backup = makeBackup({ dir, agent, home })

    fs.writeFileSync(path.join(home, MARKER), '')
    if (!wasEnrolled) enrollAgent({ dir, agent, home, url: `http://host.docker.internal:${port}` })
    for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
      const text = fs.readFileSync(f, 'utf-8')
      const stripped = stripGithubCredentials(text)
      if (stripped !== text) writeLikeOriginal(f, stripped)
    }
  } catch (err) {
    result = { ok: false, reason: `could not change its files (${errorName(err)})`, untouched: true }
  }

  if (!result) {
    const started = recreate(run, c)
    result = started ? await verify(run, c, { verifyDeadlineMs, pollMs }) : { ok: false, reason: 'recreate-failed' }
  }
  if (result.ok) {
    note('rolled-out', { agent })
    lines.push(`OK: ${agent} now gets git and gh from the broker.`)
    return { ok: true, applied: true, lines }
  }

  lines.push(`FAILED: ${result.reason}`)
  note('rollout-failed', { agent, reason: result.reason })
  try {
    if (backup) restoreBackup(backup, home)
    // An agent already on the broker before this run stays enrolled and marked.
    if (!wasEnrolled) {
      try {
        unenrollAgent({ dir, agent, home })
      } catch {
        // A registry it can't update: deleting the secret is what ends this identity.
        fs.rmSync(path.join(home, AGENT_CONFIG_FILE), { force: true })
      }
      fs.rmSync(path.join(home, MARKER), { force: true })
    }
  } catch (err) {
    lines.push(backup
      ? `Could not put ${agent} back (${errorName(err)}). Its old lines are safe in the backup. Fix that, then run: ghkey undo ${agent}`
      : `Could not put ${agent} back (${errorName(err)}). Fix that, then delete ${MARKER} and ${AGENT_CONFIG_FILE} from its home.`)
    return { ok: false, applied: false, lines }
  }
  if (backup) fs.rmSync(backup, { recursive: true, force: true })
  // The container was never recreated, so it is still running as it was.
  if (result.untouched) lines.push(`Restored ${agent} to how it was.`)
  else {
    lines.push(recreate(run, c)
      ? `Restored ${agent} to how it was.`
      : `Restored ${agent}'s files, but ${c.container} would not start and may be down.`)
  }
  return { ok: false, applied: false, lines }
}

export async function undo({ agent, homeRoot, dir, docker, dockerEnv }) {
  if (!AGENT_RE.test(agent ?? '')) return { ok: false, lines: ['bad agent name'] }
  const home = homeFor(homeRoot, agent)
  const backups = unusedBackups(dir, agent)
  if (!backups.length) return { ok: false, lines: [`no backup for ${agent}`] }
  const run = dockerClient({ docker, dockerEnv })
  try {
    // Marker last: HSM must not write keys into a half-restored .env.
    for (const backup of backups) restoreBackup(backup, home)
    unenrollAgent({ dir, agent, home })
    fs.rmSync(path.join(home, MARKER), { force: true })
    for (const backup of backups) retireBackup(dir, backup)
    audit(dir, 'rollout-undone', { agent })
  } catch (err) {
    return { ok: false, lines: [`Could not finish undoing ${agent} (${errorName(err)}). Its backup is safe. Fix that, then run: ghkey undo ${agent}`] }
  }
  const started = recreate(run, locate(run, homeRoot, agent))
  return {
    ok: started,
    lines: [started ? `Undone: ${agent} has its GitHub lines back. Any other change to its .env since the move is kept.` : `Restored ${agent}'s files, but the container would not start and may be down.`],
  }
}

/** Backups hold the old PATs and key. Drop them once the fleet is settled. */
export function purgeBackups({ dir }) {
  fs.rmSync(backupRoot(dir), { recursive: true, force: true })
  audit(dir, 'backups-purged')
}
