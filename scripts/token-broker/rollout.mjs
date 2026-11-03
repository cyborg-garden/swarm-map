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
const LINE_RE = /^[ \t]*#?[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
// A GitHub token is recognisable under any name. A private key isn't: Google and SSH
// keys look the same, so a key counts only under a name that says GitHub. Keep this in
// step with lib/services/github-credential-check.ts. The check tells her to run
// `ghkey roll`, so everything flagged here has to be something the strip removes.
// "LS0tLS1CRUdJTi" is a base64 PEM header.
const TOKEN_RE = /^["']?(?:gh[pousr]_|github_pat_)/
const PEM_RE = /^["']?(?:-----BEGIN|LS0tLS1CRUdJTi)/
const GITHUB_NAME_RE = /GITHUB|(?:^|_)GH(?:_|$)/i

function credentialName(line) {
  const m = LINE_RE.exec(line)
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

function envFiles(home) {
  const profiles = path.join(home, 'profiles')
  const nested = fs.existsSync(profiles)
    ? fs.readdirSync(profiles).map((p) => path.join(profiles, p, '.env')).filter((f) => fs.existsSync(f))
    : []
  return [path.join(home, '.env'), ...nested].filter((f) => fs.existsSync(f))
}

// Copies like .env.bak hold the same secrets. They are moved rather than stripped,
// since their only use is as a record.
function strayEnvCopies(home) {
  return fs.readdirSync(home)
    .filter((n) => n.startsWith('.env.') && n !== '.env.example')
    .map((n) => path.join(home, n))
    .filter((f) => fs.statSync(f).isFile() && scanEnvText(fs.readFileSync(f, 'utf-8')).length > 0)
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
  for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
    const to = path.join(where, path.relative(home, f))
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
    fs.copyFileSync(f, to)
    fs.chmodSync(to, 0o600)
  }
  return where
}

function restoreBackup(where, home) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(where)) writeLikeOriginal(path.join(home, path.relative(where, f)), fs.readFileSync(f))
}

function newestBackup(dir, agent) {
  if (!fs.existsSync(backupRoot(dir))) return null
  const all = fs.readdirSync(backupRoot(dir)).filter((n) => n.startsWith(`${agent}--`)).sort()
  return all.length ? path.join(backupRoot(dir), all.at(-1)) : null
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
  for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
    const names = scanEnvText(fs.readFileSync(f, 'utf-8'))
    lines.push(`${path.relative(home, f)}: ${names.length ? names.join(', ') : 'clean'}`)
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

  const hasCreds = [...envFiles(home), ...strayEnvCopies(home)]
    .some((f) => scanEnvText(fs.readFileSync(f, 'utf-8')).length > 0)
  const wasEnrolled = fs.existsSync(path.join(home, AGENT_CONFIG_FILE))
  // A re-run on a clean agent has nothing to save, and a clean copy would become
  // the newest backup and take undo away from the real original.
  const backup = hasCreds ? makeBackup({ dir, agent, home }) : null

  fs.writeFileSync(path.join(home, MARKER), '')
  if (!wasEnrolled) enrollAgent({ dir, agent, home, url: `http://host.docker.internal:${port}` })
  for (const f of envFiles(home)) {
    const text = fs.readFileSync(f, 'utf-8')
    const stripped = stripGithubCredentials(text)
    if (stripped !== text) writeLikeOriginal(f, stripped)
  }
  for (const f of strayEnvCopies(home)) fs.rmSync(f)

  const started = recreate(run, c)
  const result = started ? await verify(run, c, { verifyDeadlineMs, pollMs }) : { ok: false, reason: 'recreate-failed' }
  if (result.ok) {
    audit(dir, 'rolled-out', { agent })
    lines.push(`OK: ${agent} now gets git and gh from the broker.`)
    return { ok: true, applied: true, lines }
  }

  lines.push(`FAILED: ${result.reason}`)
  if (backup) {
    restoreBackup(backup, home)
    fs.rmSync(backup, { recursive: true, force: true })
  }
  // An agent already on the broker before this run stays enrolled and marked.
  if (!wasEnrolled) {
    unenrollAgent({ dir, agent, home })
    fs.rmSync(path.join(home, MARKER), { force: true })
  }
  audit(dir, 'rollout-failed', { agent, reason: result.reason })
  lines.push(recreate(run, c)
    ? `Restored ${agent} to how it was.`
    : `Restored ${agent}'s files, but ${c.container} would not start and may be down.`)
  return { ok: false, applied: false, lines }
}

export async function undo({ agent, homeRoot, dir, docker, dockerEnv }) {
  if (!AGENT_RE.test(agent ?? '')) return { ok: false, lines: ['bad agent name'] }
  const home = homeFor(homeRoot, agent)
  const backup = newestBackup(dir, agent)
  if (!backup) return { ok: false, lines: [`no backup for ${agent}`] }
  const run = dockerClient({ docker, dockerEnv })
  // Marker last: HSM must not write keys into a half-restored .env.
  restoreBackup(backup, home)
  unenrollAgent({ dir, agent, home })
  fs.rmSync(path.join(home, MARKER), { force: true })
  audit(dir, 'rollout-undone', { agent })
  const started = recreate(run, locate(run, homeRoot, agent))
  return {
    ok: started,
    lines: [started ? `Undone: ${agent} is back on its old setup.` : `Restored ${agent}'s files, but the container would not start and may be down.`],
  }
}

/** Backups hold the old PATs and key. Drop them once the fleet is settled. */
export function purgeBackups({ dir }) {
  fs.rmSync(backupRoot(dir), { recursive: true, force: true })
  audit(dir, 'backups-purged')
}
