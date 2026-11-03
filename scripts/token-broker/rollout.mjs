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
import { AGENT_CONFIG_FILE, DEFAULT_PORT, agentEnrolled, agentRegistered, audit, enrollAgent, unenrollAgent } from './lib.mjs'

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

function isCredential(name, value) {
  return CREDENTIAL_VARS.includes(name) || TOKEN_RE.test(value) || (PEM_RE.test(value) && GITHUB_NAME_RE.test(name))
}

function closesQuote(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return true
  }
  return false
}

// A key pasted with its line breaks spreads over several lines, and leaving the body
// behind would leave the secret with nothing to flag it. It ends at the closing quote,
// or at the PEM footer if it has no quotes. Another NAME=value line means the quote was
// never closed, so that line is someone else's and the value is just its first line.
function lastLineOfValue(lines, start, value) {
  const quote = /^["']/.test(value) ? value[0] : null
  if (quote && closesQuote(value.slice(1), quote)) return start
  const unquotedPem = !quote && value.startsWith('-----BEGIN') && !value.includes('-----END')
  if (!quote && !unquotedPem) return start
  for (let i = start + 1; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i].replace(/\r$/, ''))
    if (m && !/^=*$/.test(m[2].trim())) return start
    if (quote ? closesQuote(lines[i], quote) : lines[i].includes('-----END')) return i
  }
  return start
}

/** A .env body as entries: each credential whole, every other line on its own. */
function envEntries(text) {
  const lines = text.split('\n')
  const entries = []
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i].replace(/\r$/, ''))
    const value = m ? m[2].trim() : ''
    // Only the opening quote on this line: the value starts on the next one.
    const seen = /^["']$/.test(value) ? `${value}${lines[i + 1] ?? ''}` : value
    if (!m || !isCredential(m[1], seen)) {
      entries.push({ name: null, comment: false, lines: [lines[i]] })
      continue
    }
    const comment = /^[ \t]*#/.test(lines[i])
    const last = comment ? i : lastLineOfValue(lines, i, value)
    entries.push({ name: m[1], comment, lines: lines.slice(i, last + 1) })
    i = last
  }
  return entries
}

/** Names of credential variables in a .env body. Names only, by construction. */
export function scanEnvText(text) {
  return [...new Set(envEntries(text).map((e) => e.name).filter(Boolean))]
}

export function stripGithubCredentials(text) {
  return envEntries(text).filter((e) => !e.name).flatMap((e) => e.lines).join('\n')
}

// Every byte of a file maps to one character and back, so a byte that isn't valid UTF-8
// survives an edit and undo stays exact. All the patterns here only look at ASCII.
const readBytes = (file) => fs.readFileSync(file, 'latin1')

// Git and gh keep their logins outside .env. A short-lived ghs_ token is what the broker
// itself hands out, so only anything else counts. Keep these in step with
// lib/services/github-credential-check.ts.
const GIT_LOGIN_RE = /^\s*https?:\/\/([^\s/]*)@(?:[^\s/@]*\.)?github\.com(?::\d+)?(?:\/\S*)?\s*$/i
const GH_BLOCK_RE = /^["']?github\.com["']?\s*:/
const GH_TOKEN_RE = /^\s+oauth_token:\s*["']?([^\s"']+)/

function gitLoginIsLongLived(line) {
  const m = GIT_LOGIN_RE.exec(line)
  if (!m) return false
  const secret = m[1].slice(m[1].indexOf(':') + 1)
  return !!secret && !secret.startsWith('ghs_')
}

export function gitCredentialsHoldToken(text) {
  return text.split('\n').some(gitLoginIsLongLived)
}

function stripGitCredentials(text) {
  return text.split('\n').filter((line) => !gitLoginIsLongLived(line)).join('\n')
}

/** Which lines of a hosts.yml belong to the top-level github.com block. */
function ghBlockFlags(lines) {
  let inside = false
  return lines.map((line) => {
    if (/^[^\s#]/.test(line)) inside = GH_BLOCK_RE.test(line)
    return inside
  })
}

export function ghHostsHoldToken(text) {
  const lines = text.split('\n')
  const flags = ghBlockFlags(lines)
  return lines.some((line, i) => {
    const m = flags[i] && GH_TOKEN_RE.exec(line)
    return !!m && !m[1].startsWith('ghs_')
  })
}

export function stripGhHosts(text) {
  const lines = text.split('\n')
  const flags = ghBlockFlags(lines)
  return lines.filter((_, i) => !flags[i]).join('\n')
}

// The newer line of a kind wins, as with .env, so a login made since the roll stays.
const LOGIN_FILES = {
  '.git-credentials': {
    holds: gitCredentialsHoldToken,
    strip: stripGitCredentials,
    restore(current, saved) {
      if (stripGitCredentials(saved) === current) return saved
      const held = new Set(current.split('\n'))
      const missing = saved.split('\n').filter((line) => line && !held.has(line))
      if (!missing.length) return current
      const gap = current === '' || current.endsWith('\n') ? '' : '\n'
      return `${current}${gap}${missing.join('\n')}\n`
    },
  },
  'hosts.yml': {
    holds: ghHostsHoldToken,
    strip: stripGhHosts,
    // Boot writes a broker-era file here, so this replaces it rather than merging.
    restore: (current, saved) => (ghHostsHoldToken(current) ? current : saved),
  },
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
    .filter((a) => envFiles(a.home).some((f) => /^GITHUB_APP_PRIVATE_KEY_B64=/m.test(readBytes(f))))
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
    .filter((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() && scanEnvText(readBytes(f)).length > 0)
}

// Both the tool HOME (home/) and the gateway HOME (the agent home itself).
function loginFilesWithToken(home) {
  return [home, ...profileDirs(home)]
    .flatMap((d) => [d, path.join(d, 'home')])
    .flatMap((base) => [path.join(base, '.git-credentials'), path.join(base, '.config', 'gh', 'hosts.yml')])
    .filter((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile() && LOGIN_FILES[path.basename(f)].holds(readBytes(f)))
}

function stripLoginFile(file) {
  const left = LOGIN_FILES[path.basename(file)].strip(readBytes(file))
  if (left.split('\n').some((line) => line.trim() && !line.startsWith('#'))) writeLikeOriginal(file, left)
  else fs.rmSync(file)
}

function writeLikeOriginal(file, content) {
  const tmp = `${file}.broker.tmp`
  fs.writeFileSync(tmp, content, { mode: 0o600, encoding: 'latin1' })
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
    for (const f of [...envFiles(home), ...strayEnvCopies(home), ...loginFilesWithToken(home)]) {
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
  const held = new Set(envEntries(current).filter((e) => e.name && !e.comment).map((e) => e.name))
  const missing = envEntries(backup).filter((e) => e.name && !held.has(e.name)).flatMap((e) => e.lines)
  if (!missing.length) return current
  const gap = current === '' || current.endsWith('\n') ? '' : '\n'
  return `${current}${gap}${missing.join('\n')}\n`
}

function restoreBackup(where, home) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(where)) {
    const target = path.join(home, path.relative(where, f))
    const saved = readBytes(f)
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      writeLikeOriginal(target, saved)
      continue
    }
    const current = readBytes(target)
    const login = LOGIN_FILES[path.basename(f)]
    const merged = login ? login.restore(current, saved) : restoreCredentialLines(current, saved)
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

function brokerHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 3000 }, (res) => {
      let raw = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let keyOk = null
        try { keyOk = JSON.parse(raw).key_ok ?? null } catch { /* older broker */ }
        resolve({ up: res.statusCode === 200, keyOk })
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve({ up: false, keyOk: null }))
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
// gh auth token is compared, never printed, so a login file gh still prefers shows up.
export const VERIFY_SH = `
[ -z "\${GITHUB_TOKEN:-}\${GH_TOKEN:-}\${GITHUB_PERSONAL_ACCESS_TOKEN:-}\${GITHUB_APP_PRIVATE_KEY_B64:-}" ] || { echo env-still-has-credential; exit 11; }
printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | grep -q '^password=ghs_' || { echo git-no-token; exit 12; }
gh auth token 2>/dev/null | grep -q '^ghs_' || { echo gh-token-not-from-broker; exit 13; }
repo=$(gh api 'installation/repositories?per_page=100' --jq '([.repositories[]|select(.private)][0] // .repositories[0]).full_name' 2>/dev/null) || { echo gh-failed; exit 13; }
[ -n "$repo" ] || { echo gh-no-repos; exit 13; }
git ls-remote "https://github.com/$repo" HEAD >/dev/null 2>&1 || { echo git-ls-remote-failed; exit 14; }
echo ok
`

// A PAT can reach repos outside the App's org; the broker can't. Show which owners
// this agent has checked out so a repo about to go dark gets seen first. The sed
// keeps only the part after github.com, so a token embedded in a URL can't print.
// Any depth, because a repo this misses is one she loses without being told. It skips
// only trees that can't hold her own checkouts, and git's objects, to stay quick.
export const OWNERS_SH = `find /opt/data \\( -name node_modules -o -name .venv -o -name .cache -o \\( -name objects -path '*/.git/*' \\) \\) -prune -o -type f \\( -path '*/.git/config' -o -path '*/.git/modules/*/config' \\) -exec sed -n 's#.*url = .*github\\.com[:/]\\([A-Za-z0-9_.-]*\\)/.*#\\1#p' {} + 2>/dev/null | sort -u`

function checkoutOwners(run, c) {
  const { rc, out } = run(['exec', c.container, 'sh', '-c', OWNERS_SH])
  return { listed: rc === 0, owners: out.split('\n').filter((o) => /^[A-Za-z0-9_.-]+$/.test(o)) }
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
  const health = await brokerHealth(port)
  if (!health.up) problems.push(`the broker is not answering on port ${port}`)
  else if (health.keyOk === false) problems.push('the broker\'s last check of its App key with GitHub failed. Run ghkey if the key was deleted, or try again in 5 minutes if GitHub was down')
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
      const names = scanEnvText(readBytes(f))
      lines.push(`${path.relative(home, f)}: ${names.length ? names.join(', ') : 'clean'}`)
    }
    for (const f of loginFilesWithToken(home)) lines.push(`${path.relative(home, f)}: a GitHub token`)
  } catch (err) {
    problems.push(`could not read its .env files (${errorName(err)})`)
  }
  if (c.running) {
    const { listed, owners } = checkoutOwners(run, c)
    if (!listed) lines.push(`warning: Could not list the repo owners in its checkouts, so a repo outside the App's org may not show here.`)
    if (owners.length) lines.push(`Repo owners in its checkouts: ${owners.join(', ')}. The broker only reaches the App's own org.`)
  }
  // Same meaning of moved as the health check, whose advice for this case is to roll.
  const wasMoved = fs.existsSync(path.join(home, MARKER)) || fs.existsSync(path.join(home, AGENT_CONFIG_FILE))
  const wasEnrolled = agentEnrolled({ dir, agent, home })
  if (wasMoved && !wasEnrolled) lines.push(`Marked as on the broker but not enrolled, so it gets no tokens. --apply enrols it again.`)
  for (const w of warnings) lines.push(`warning: ${w}`)
  for (const p of problems) lines.push(`BLOCKED: ${p}`)
  if (problems.length) return { ok: false, applied: false, lines }
  if (!apply) {
    lines.push(`DRY RUN: nothing changed. Add --apply to switch ${agent}.`)
    return { ok: true, applied: false, lines }
  }

  const note = (event, fields) => {
    try { audit(dir, event, fields) } catch { /* the log must not undo the work */ }
  }
  let backup = null
  let result = null
  let enrolledNow = false
  try {
    const logins = loginFilesWithToken(home)
    const hasCreds = logins.length > 0 || [...envFiles(home), ...strayEnvCopies(home)]
      .some((f) => scanEnvText(readBytes(f)).length > 0)
    // A re-run on a clean agent has nothing to save.
    if (hasCreds) backup = makeBackup({ dir, agent, home })

    fs.writeFileSync(path.join(home, MARKER), '')
    if (!wasEnrolled) {
      enrollAgent({ dir, agent, home, url: `http://host.docker.internal:${port}` })
      enrolledNow = true
    }
    for (const f of [...envFiles(home), ...strayEnvCopies(home)]) {
      const text = readBytes(f)
      const stripped = stripGithubCredentials(text)
      if (stripped !== text) writeLikeOriginal(f, stripped)
    }
    for (const f of logins) stripLoginFile(f)
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
    // An agent already on the broker before this run stays on it. One that was marked
    // but not enrolled keeps its new enrolment, which is better than how it was.
    if (!wasMoved) {
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
  // Saying "how it was" about a broken agent would read as fixed.
  let restored = `Restored ${agent} to how it was.`
  if (wasMoved && !wasEnrolled) {
    restored = enrolledNow
      ? `Put ${agent}'s old lines back. It stays on the broker and is enrolled again, but the check above still failed.`
      : `Restored ${agent}. It is still marked as on the broker but not enrolled, so it gets no tokens.`
  }
  // The container was never recreated, so it is still running as it was.
  if (result.untouched) lines.push(restored)
  else {
    lines.push(recreate(run, c)
      ? restored
      : `Restored ${agent}'s files, but ${c.container} would not start and may be down.`)
  }
  return { ok: false, applied: false, lines }
}

export async function undo({ agent, homeRoot, dir, docker, dockerEnv }) {
  if (!AGENT_RE.test(agent ?? '')) return { ok: false, lines: ['bad agent name'] }
  const home = homeFor(homeRoot, agent)
  const backups = unusedBackups(dir, agent)
  // An agent with no credentials when rolled left no backup, but it can still come off.
  const onBroker = fs.existsSync(path.join(home, MARKER)) || fs.existsSync(path.join(home, AGENT_CONFIG_FILE)) || agentRegistered({ dir, agent })
  if (!backups.length && !onBroker) return { ok: false, lines: [`no backup for ${agent}, and it isn't on the broker`] }
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
    lines: [started ? (backups.length
      ? `Undone: ${agent} has its GitHub lines back. Any other change to its .env since the move is kept.`
      : `Undone: ${agent} is off the broker. It had no GitHub lines to bring back, so it has no GitHub access now.`) : `Restored ${agent}'s files, but the container would not start and may be down.`],
  }
}

/** Backups hold the old PATs and key. Drop them once the fleet is settled. */
export function purgeBackups({ dir }) {
  fs.rmSync(backupRoot(dir), { recursive: true, force: true })
  audit(dir, 'backups-purged')
}
