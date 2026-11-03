// @vitest-environment node
/**
 * Rollout against fixture agent homes and a fake docker binary. The fake records
 * every call and snapshots .env when the container is recreated, so "the keys were
 * gone by recreate time" is checked rather than assumed. No real container runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { listen, createBroker } from '../token-broker/lib.mjs'
import { checkGithubCredentials } from '../../lib/services/github-credential-check'
import { rollout, undo, purgeBackups, stripGithubCredentials, CREDENTIAL_VARS, scanEnvText, agentsHoldingAppKey, OWNERS_SH, VERIFY_SH, stripGhHosts } from '../token-broker/rollout.mjs'

// Built at runtime: the sanitization gate reads a literal header as a real key.
const PEM_HEADER = (kind: string) => ['-----BEGIN', kind].join(' ') + '-----'

const FAKE_PAT = 'fake-pat-value-do-not-print'
const FAKE_KEY = 'ZmFrZS1rZXktZG8tbm90LXByaW50'
const ENV = [
  'DISCORD_BOT_TOKEN=keep-me',
  `GITHUB_TOKEN=${FAKE_PAT}`,
  `GITHUB_PERSONAL_ACCESS_TOKEN=${FAKE_PAT}`,
  'GITHUB_APP_ID=1',
  `GITHUB_APP_PRIVATE_KEY_B64=${FAKE_KEY}`,
  'GITHUB_APP_INSTALLATION_ID=2',
  'HERMES_AGENT_NAME=mare',
  '',
].join('\n')

const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FD/calls.log"
case "$1" in
  inspect) cat "$FD/inspect.txt"; exit $(cat "$FD/inspect.rc" 2>/dev/null || echo 0) ;;
  compose)
    n=$(ls "$FD" | grep -c '^recreate-')
    cp "$AGENT_HOME/.env" "$FD/recreate-$n.env"
    if [ -f "$FD/lock-home-during-recreate" ]; then chmod 500 "$AGENT_HOME"; fi
    if [ -f "$FD/write-during-recreate" ]; then cat "$FD/write-during-recreate" >> "$AGENT_HOME/.env"; rm "$FD/write-during-recreate"; fi
    exit $(cat "$FD/compose.rc" 2>/dev/null || echo 0) ;;
  exec)
    case "$*" in
      *read_broker_config*) exit $(cat "$FD/module.rc" 2>/dev/null || echo 0) ;;
      *"find /opt/data"*) cat "$FD/owners.out" 2>/dev/null; exit $(cat "$FD/owners.rc" 2>/dev/null || echo 0) ;;
      *) cat "$FD/verify.out" 2>/dev/null; exit $(cat "$FD/verify.rc" 2>/dev/null || echo 0) ;;
    esac ;;
esac
exit 0
`

describe('rollout', () => {
  let root: string
  let dir: string
  let fd: string
  let home: string
  let docker: string
  let server: http.Server
  let port: number

  const opts = (extra = {}) => ({
    agent: 'mare', homeRoot: root, dir, docker, pollMs: 1, verifyDeadlineMs: 20,
    dockerEnv: { FD: fd, AGENT_HOME: home }, ...extra,
  })
  const calls = () => fs.readFileSync(path.join(fd, 'calls.log'), 'utf-8')
  const writeFd = (name: string, v: string) => fs.writeFileSync(path.join(fd, name), v)

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-root-'))
    dir = path.join(root, '.config/hermes/github-app')
    fs.mkdirSync(dir, { recursive: true })
    fd = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-fd-'))
    docker = path.join(fd, 'docker')
    fs.writeFileSync(docker, FAKE_DOCKER, { mode: 0o755 })
    writeFd('inspect.txt', 'mare|/compose/mare/docker-compose.yml|hermes-mare|true\n')
    writeFd('verify.out', 'ok\n')
    writeFd('calls.log', '')
    home = path.join(root, '.hermes-mare')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, '.env'), ENV, { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'config.yaml'), 'model: x\n')
    fs.writeFileSync(path.join(dir, 'private-key.pem'), 'unused', { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app_id: 'x', installation_id: 'y' }))
    server = await listen(createBroker({ dir }), { host: '127.0.0.1', port: 0 })
    port = (server.address() as AddressInfo).port
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app_id: 'x', installation_id: 'y', port }))
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(fd, { recursive: true, force: true })
  })

  it('strips only GitHub credentials, including exported and commented ones', () => {
    const out = stripGithubCredentials(`${ENV}export GH_TOKEN=x\n# GITHUB_PAT=y\nGITHUB_APP_PRIVATE_KEY_PATH=/k\nNOT_GITHUB_TOKEN=keep\n`)
    expect(out).toBe('DISCORD_BOT_TOKEN=keep-me\nHERMES_AGENT_NAME=mare\nNOT_GITHUB_TOKEN=keep\n')
  })

  it('names a token-shaped value under any other variable, without the value', () => {
    const pat = 'ghp_' + 'A'.repeat(36)
    const hits = scanEnvText(`SOME_BOT=${pat}\nOK=hello\nGITHUB_TOKEN=x\n`)
    expect(hits).toEqual(['SOME_BOT', 'GITHUB_TOKEN'])
    expect(JSON.stringify(hits)).not.toContain(pat)
  })

  it('removes everything it flags, so a flag always has a cure', async () => {
    const pat = 'ghp_' + 'A'.repeat(36)
    fs.writeFileSync(path.join(home, '.env'), [
      'KEEP=1', `MY_GITHUB_KEY=${pat}`, `# OLD_ONE=${pat}`, `export OTHER_BOT="${pat}"`, `GITHUB_APP_PRIVATE_KEY=${PEM_HEADER('RSA PRIVATE KEY')}`, '',
    ].join('\n'))
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe('KEEP=1\n')
  })

  it('leaves a private key that is not GitHub\'s alone', async () => {
    const env = `GOOGLE_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklW\nSOME_SSH_KEY="${PEM_HEADER('OPENSSH PRIVATE KEY')}"\n`
    expect(scanEnvText(env)).toEqual([])
    fs.writeFileSync(path.join(home, '.env'), env)
    await rollout(opts({ apply: true }))
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(env)
  })

  it('strips CRLF and spaced lines, and leaves the line endings of the rest', async () => {
    fs.writeFileSync(path.join(home, '.env'), `KEEP=1\r\nGITHUB_TOKEN=${FAKE_PAT}\r\nGH_TOKEN = ${FAKE_PAT}\r\nALSO=2\r\n`)
    const r = await rollout(opts())
    expect(r.lines).toContain('.env: GITHUB_TOKEN, GH_TOKEN')
    await rollout(opts({ apply: true }))
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe('KEEP=1\r\nALSO=2\r\n')
  })

  it('finds copies anywhere the check looks, so its advice clears them', async () => {
    fs.writeFileSync(path.join(home, '.env-old'), `GITHUB_TOKEN=${FAKE_PAT}\n`)
    fs.mkdirSync(path.join(home, 'profiles/p'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles/p/.env.bak'), `GITHUB_TOKEN=${FAKE_PAT}\n`)
    fs.writeFileSync(path.join(home, 'profiles/not-a-dir'), '')
    await rollout(opts({ apply: true }))
    for (const f of ['.env', '.env-old', 'profiles/p/.env.bak']) {
      const file = path.join(home, f)
      expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '').not.toContain(FAKE_PAT)
    }
    const keyPath = path.join(dir, 'private-key.pem')
    expect(checkGithubCredentials({ agents: [{ name: 'mare', dataDir: home }], keyPath }).failing).toEqual([])
  })

  it('dry-runs by default: reports names and changes nothing', async () => {
    const r = await rollout(opts())
    expect(r.ok).toBe(true)
    expect(r.applied).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(false)
    expect(calls()).not.toMatch(/^compose/m)
    const text = r.lines.join('\n')
    expect(text).toContain('GITHUB_TOKEN')
    expect(text).toContain('DRY RUN')
  })

  it('shows repo owners in the agent checkouts, dropping anything that is not a plain name', async () => {
    // URLs are built at runtime: the sanitization gate reads a literal as a real one.
    writeFd('owners.out', ['cyborg-garden', 'someone-else', ['https', '//x', 'leak@bad'].join(':'), ''].join('\n'))
    const text = (await rollout(opts())).lines.join('\n')
    expect(text).toContain('cyborg-garden, someone-else')
    expect(text).not.toContain('leak')
  })

  it('extracts only the owner from a real git config line, never an embedded token', () => {
    const repo = path.join(root, 'cfg')
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, 'config'), `\turl = ${['https', '//x-access-token', 'leak-value'].join(':')}${'@'}github.com/some-owner/some-repo.git\n\turl = git${'@'}github.com:other-owner/r.git\n`)
    const sed = /sed -n '([^']+)'/.exec(OWNERS_SH)?.[1] ?? ''
    const r = spawnSync('sed', ['-n', sed, path.join(repo, 'config')], { encoding: 'utf-8' })
    expect(r.stdout.trim().split('\n')).toEqual(['some-owner', 'other-owner'])
  })

  it('finds an owner at any depth, and in a path with a space, without printing a token', () => {
    const tree = path.join(root, 'data')
    const repo = (rel: string, url: string, config = '.git/config') => {
      const f = path.join(tree, rel, config)
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, `[remote "origin"]\n\turl = ${url}\n`)
    }
    const github = (owner: string) => `https://github.com/${owner}/r.git`
    repo('workspace/a', github('shallow-org'))
    repo('home/repos/b', github('depth5-org'))
    repo('home/work/x/y/z/q/c', github('depth9-org'))
    repo('home/my repos/d', github('spaced-org'))
    repo('home/e', github('submodule-org'), '.git/modules/sub/config')
    repo('home/f', ['https', '//x-access-token', 'leak-value'].join(':') + '@github.com/token-org/f.git')
    repo('home/g/node_modules/h', github('vendored-org'))
    const r = spawnSync('sh', ['-c', OWNERS_SH.replace('/opt/data', tree)], { encoding: 'utf-8' })
    expect(r.stdout.trim().split('\n')).toEqual(['depth5-org', 'depth9-org', 'shallow-org', 'spaced-org', 'submodule-org', 'token-org'])
  })

  it('says so when it could not list the owners, rather than showing none', async () => {
    writeFd('owners.rc', '1')
    const text = (await rollout(opts())).lines.join('\n')
    expect(text).toMatch(/Could not list the repo owners/)
  })

  it('applies: backs up outside the agent mount, strips, marks, enrols and recreates without building', async () => {
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(true)
    const stripped = fs.readFileSync(path.join(home, '.env'), 'utf-8')
    expect(stripped).toBe('DISCORD_BOT_TOKEN=keep-me\nHERMES_AGENT_NAME=mare\n')
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(fd, 'recreate-0.env'), 'utf-8')).toBe(stripped)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'github-broker.json'), 'utf-8')).url).toBe(`http://host.docker.internal:${port}`)
    const compose = calls().split('\n').find((l) => l.startsWith('compose')) ?? ''
    expect(compose).toContain('-p mare -f /compose/mare/docker-compose.yml up -d --no-deps --no-build --force-recreate hermes-mare')
    expect(compose).not.toMatch(/ build( |$)/)
    const backups = fs.readdirSync(path.join(dir, 'env-backups'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, 'env-backups', backups[0], '.env'), 'utf-8')).toBe(ENV)
    expect(fs.statSync(path.join(dir, 'env-backups', backups[0], '.env')).mode & 0o777).toBe(0o600)
  })

  it('checks git and gh as the agent, under the agent HOME', async () => {
    await rollout(opts({ apply: true }))
    const verify = calls().slice(calls().lastIndexOf('exec -u hermes'))
    expect(verify).toContain('-u hermes')
    expect(verify).toContain('HOME=/opt/data/home')
    expect(verify).toContain('git credential fill')
    expect(verify).toContain('installation/repositories')
    expect(verify).toContain('git ls-remote')
  })

  it('restores everything and says so when the check fails', async () => {
    writeFd('verify.rc', '12')
    writeFd('verify.out', 'git-no-token\n')
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).agents.mare).toBeUndefined()
    expect(fs.readFileSync(path.join(fd, 'recreate-1.env'), 'utf-8')).toBe(ENV)
    expect(r.lines.join('\n')).toContain('git-no-token')
    expect(r.lines.join('\n')).toMatch(/restored/i)
  })

  it('restores when the recreate itself fails, and shouts if that restore also fails to start', async () => {
    writeFd('compose.rc', '1')
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    expect(r.lines.join('\n')).toMatch(/may be down/i)
  })

  it('never prints a value, on success or on failure', async () => {
    const good = await rollout(opts({ apply: true }))
    await undo(opts())
    writeFd('verify.rc', '12')
    const bad = await rollout(opts({ apply: true }))
    const text = [...good.lines, ...bad.lines].join('\n')
    for (const v of [FAKE_PAT, FAKE_KEY]) expect(text).not.toContain(v)
  })

  it('strips other .env copies in place, keeping their other lines', async () => {
    fs.writeFileSync(path.join(home, '.env.bak'), ENV)
    fs.writeFileSync(path.join(home, '.env.example'), 'NOTHING=here\n')
    await rollout(opts({ apply: true }))
    expect(fs.readFileSync(path.join(home, '.env.bak'), 'utf-8')).toBe('DISCORD_BOT_TOKEN=keep-me\nHERMES_AGENT_NAME=mare\n')
    expect(fs.existsSync(path.join(home, '.env.example'))).toBe(true)
  })

  it('leaves a copy holding only non-GitHub data alone, with no backup needed', async () => {
    const body = `GOOGLE_PEM=${PEM_HEADER('PRIVATE KEY')}\nOTHER=important\n`
    fs.writeFileSync(path.join(home, '.env'), 'X=1\n')
    fs.writeFileSync(path.join(home, '.env.old'), body)
    await rollout(opts({ apply: true }))
    expect(fs.readFileSync(path.join(home, '.env.old'), 'utf-8')).toBe(body)
    expect(fs.existsSync(path.join(dir, 'env-backups'))).toBe(false)
  })

  it('a failed roll puts a stripped copy back byte for byte', async () => {
    fs.writeFileSync(path.join(home, '.env.bak'), ENV)
    writeFd('verify.out', 'gh-failed\n')
    writeFd('verify.rc', '13')
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env.bak'), 'utf-8')).toBe(ENV)
  })

  it('strips profile .env files too and restores them on failure', async () => {
    const prof = path.join(home, 'profiles', 'p1')
    fs.mkdirSync(prof, { recursive: true })
    fs.writeFileSync(path.join(prof, '.env'), ENV, { mode: 0o600 })
    await rollout(opts({ apply: true }))
    expect(fs.readFileSync(path.join(prof, '.env'), 'utf-8')).not.toContain('GITHUB')
    await undo(opts())
    expect(fs.readFileSync(path.join(prof, '.env'), 'utf-8')).toBe(ENV)
  })

  it.each([
    ['the running image lacks the broker code', () => writeFd('module.rc', '1'), /rebuild/i],
    ['the broker is down', () => { fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1 })) }, /broker/i],
    ['there is no App key on the host', () => fs.rmSync(path.join(dir, 'private-key.pem')), /ghkey/i],
    ['the container is not running', () => writeFd('inspect.txt', 'mare|/c.yml|hermes-mare|false\n'), /not running/i],
    ['config.yaml relies on the PAT for an MCP server', () => fs.appendFileSync(path.join(home, 'config.yaml'), 'x: ${GITHUB_PERSONAL_ACCESS_TOKEN}\n'), /MCP/],
  ])('refuses before changing anything when %s', async (_name, arrange, message) => {
    arrange()
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toMatch(message)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    expect(calls()).not.toMatch(/^compose/m)
  })

  it('--accept-loss proceeds past an MCP or copilot dependency', async () => {
    fs.appendFileSync(path.join(home, 'config.yaml'), 'x: ${GITHUB_PERSONAL_ACCESS_TOKEN}\n')
    expect((await rollout(opts({ apply: true, acceptLoss: true }))).ok).toBe(true)
  })

  it('is safe to re-run on an agent already switched', async () => {
    await rollout(opts({ apply: true }))
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).not.toContain('GITHUB')
    // The newest backup is clean, so keep undo pointing at the real original.
    await undo(opts())
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
  })

  it('a failed re-run leaves an already-switched agent switched', async () => {
    await rollout(opts({ apply: true }))
    writeFd('verify.rc', '12')
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(true)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).not.toContain('GITHUB')
  })

  describe('an agent marked as moved but missing from the registry', () => {
    const report = () => checkGithubCredentials({ agents: [{ name: 'mare', dataDir: home }], keyPath: path.join(dir, 'private-key.pem') })
    const dropFromRegistry = () => {
      const file = path.join(dir, 'registry.json')
      const r = JSON.parse(fs.readFileSync(file, 'utf-8'))
      delete r.agents.mare
      fs.writeFileSync(file, JSON.stringify(r))
    }

    it('the advice the health check gives repairs it', async () => {
      await rollout(opts({ apply: true }))
      dropFromRegistry()
      expect(report().broker.notEnrolled).toEqual(['mare'])
      const dry = await rollout(opts())
      expect(dry.lines.join('\n')).toContain('not enrolled')
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(true)
      expect(report().broker.notEnrolled).toEqual([])
    })

    it('repairs a secret the registry no longer matches, keeping the scope', async () => {
      await rollout(opts({ apply: true }))
      const file = path.join(dir, 'registry.json')
      const reg = JSON.parse(fs.readFileSync(file, 'utf-8'))
      reg.agents.mare = { ...reg.agents.mare, secret_sha256: 'ab'.repeat(32), repos: ['one'] }
      fs.writeFileSync(file, JSON.stringify(reg))
      expect(report().broker.notEnrolled).toEqual(['mare'])
      expect((await rollout(opts({ apply: true }))).ok).toBe(true)
      expect(report().broker.notEnrolled).toEqual([])
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).agents.mare.repos).toEqual(['one'])
    })

    it('if the repair fails it stays marked and enrolled, and says so', async () => {
      await rollout(opts({ apply: true }))
      dropFromRegistry()
      writeFd('verify.rc', '12')
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(false)
      expect(r.lines.join('\n')).not.toContain('to how it was')
      expect(r.lines.join('\n')).toContain('stays on the broker')
      expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(true)
      expect(report().broker.notEnrolled).toEqual([])
    })

    it('a registry with a typo does not cost a healthy agent its secret', async () => {
      await rollout(opts({ apply: true }))
      const secret = fs.readFileSync(path.join(home, 'github-broker.json'), 'utf-8')
      fs.writeFileSync(path.join(dir, 'registry.json'), '{oops')
      await rollout(opts({ apply: true }))
      expect(fs.readFileSync(path.join(home, 'github-broker.json'), 'utf-8')).toBe(secret)
    })
  })

  describe('a .env that is not one simple line per value', () => {
    const body = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='
    const pem = (open: string, close: string) => [
      `GITHUB_APP_PRIVATE_KEY=${open}${PEM_HEADER('RSA PRIVATE KEY')}`, body, `-----END RSA PRIVATE KEY-----${close}`,
    ].join('\n')

    it.each([['double quotes', '"', '"'], ['single quotes', "'", "'"], ['no quotes', '', '']])('strips a multi-line key in %s, body and all', (_n, a, b) => {
      const left = stripGithubCredentials(`A=1\n${pem(a, b)}\nB=2\n`)
      expect(left).toBe('A=1\nB=2\n')
      expect(left).not.toContain(body)
    })

    it('strips a key whose first line is only the opening quote', () => {
      const text = `A=1\nGITHUB_APP_PRIVATE_KEY="\n${PEM_HEADER('RSA PRIVATE KEY')}\n${body}\n-----END RSA PRIVATE KEY-----\n"\nB=2\n`
      expect(scanEnvText(text)).toEqual(['GITHUB_APP_PRIVATE_KEY'])
      expect(stripGithubCredentials(text)).toBe('A=1\nB=2\n')
    })

    it('leaves a multi-line value that is not GitHub, and what follows it', () => {
      const text = `GOOGLE_PRIVATE_KEY="${PEM_HEADER('PRIVATE KEY')}\n${body}\n-----END PRIVATE KEY-----"\nB=2\n`
      expect(stripGithubCredentials(text)).toBe(text)
    })

    it('does not treat a commented-out quote as opening a value', () => {
      const text = `# GITHUB_ORG_NOTE="oops\nGITHUB_TOKEN=${FAKE_PAT}\nB="closed"\n`
      expect(stripGithubCredentials(text)).toBe(`# GITHUB_ORG_NOTE="oops\nB="closed"\n`)
    })

    it('still finds a token inside a value it would not otherwise touch', () => {
      expect(scanEnvText(`A="open\nGH_TOKEN=${FAKE_PAT}\nclose"\n`)).toEqual(['GH_TOKEN'])
    })

    it('rolls and undoes a multi-line key, back to the same bytes', async () => {
      const text = `A=1\n${pem('"', '"')}\nB=2\n`
      fs.writeFileSync(path.join(home, '.env'), text)
      expect((await rollout(opts({ apply: true }))).ok).toBe(true)
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe('A=1\nB=2\n')
      await undo(opts())
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(text)
    })

    it('undo merges a multi-line key whole into a file that moved on', async () => {
      const text = `A=1\n${pem('"', '"')}\nB=2\n`
      fs.writeFileSync(path.join(home, '.env'), text)
      await rollout(opts({ apply: true }))
      fs.appendFileSync(path.join(home, '.env'), 'C=3\n')
      await undo(opts())
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(`A=1\nB=2\nC=3\n${pem('"', '"')}\n`)
    })

    it('keeps a non-UTF-8 byte on another line through a roll and an undo', async () => {
      const bytes = Buffer.concat([Buffer.from(`GITHUB_TOKEN=${FAKE_PAT}\nNAME=caf`), Buffer.from([0xe9]), Buffer.from('\n')])
      fs.writeFileSync(path.join(home, '.env'), bytes)
      expect((await rollout(opts({ apply: true }))).ok).toBe(true)
      expect(fs.readFileSync(path.join(home, '.env')).equals(Buffer.concat([Buffer.from('NAME=caf'), Buffer.from([0xe9]), Buffer.from('\n')]))).toBe(true)
      await undo(opts())
      expect(fs.readFileSync(path.join(home, '.env')).equals(bytes)).toBe(true)
    })

    it('keeps real UTF-8 and a moved-on non-UTF-8 byte through a merging undo', async () => {
      const bytes = Buffer.concat([Buffer.from(`GITHUB_TOKEN=${FAKE_PAT}\nNAME=Māori\nOLD=caf`), Buffer.from([0xe9]), Buffer.from('\n')])
      fs.writeFileSync(path.join(home, '.env'), bytes)
      await rollout(opts({ apply: true }))
      fs.appendFileSync(path.join(home, '.env'), 'NEW=1\n')
      await undo(opts())
      const after = fs.readFileSync(path.join(home, '.env'))
      expect(after.includes(Buffer.from('NAME=Māori'))).toBe(true)
      expect(after.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true)
      expect(after.includes(Buffer.from(`GITHUB_TOKEN=${FAKE_PAT}`))).toBe(true)
    })

    it('keeps a non-UTF-8 byte in a login file', async () => {
      const file = path.join(home, 'home/.git-credentials')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const bytes = Buffer.concat([Buffer.from(`https://x:${FAKE_PAT}@github.com\nhttps://caf`), Buffer.from([0xe9]), Buffer.from(':pw@gitlab.example.com\n')])
      fs.writeFileSync(file, bytes)
      await rollout(opts({ apply: true }))
      expect(fs.readFileSync(file).includes(Buffer.from([0xe9]))).toBe(true)
      await undo(opts())
      expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    })
  })

  it('rejects an agent name that could escape the home root', async () => {
    const r = await rollout(opts({ agent: '../evil', apply: true }))
    expect(r.ok).toBe(false)
    expect(calls()).toBe('')
  })

  it('undo puts the agent back exactly', async () => {
    await rollout(opts({ apply: true }))
    const r = await undo(opts())
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(false)
  })

  it('undo brings back only the GitHub lines, keeping everything changed since', async () => {
    await rollout(opts({ apply: true }))
    fs.writeFileSync(path.join(home, '.env'), 'DISCORD_BOT_TOKEN=ROTATED\nHERMES_AGENT_NAME=mare\nNEW_SURFACE=added-later\n')
    expect((await undo(opts())).ok).toBe(true)
    const after = fs.readFileSync(path.join(home, '.env'), 'utf-8')
    expect(after).toContain('DISCORD_BOT_TOKEN=ROTATED\n')
    expect(after).toContain('NEW_SURFACE=added-later\n')
    expect(after).not.toContain('keep-me')
    expect(after).toContain(`GITHUB_TOKEN=${FAKE_PAT}\n`)
    expect(after).toContain(`GITHUB_APP_PRIVATE_KEY_B64=${FAKE_KEY}\n`)
    expect(scanEnvText(after)).toEqual(scanEnvText(ENV))
  })

  it('undo does not replace or duplicate a GitHub line set since', async () => {
    await rollout(opts({ apply: true }))
    fs.appendFileSync(path.join(home, '.env'), 'GITHUB_TOKEN=newer\n')
    await undo(opts())
    const lines = fs.readFileSync(path.join(home, '.env'), 'utf-8').split('\n')
    expect(lines.filter((l) => l.startsWith('GITHUB_TOKEN='))).toEqual(['GITHUB_TOKEN=newer'])
    expect(lines).toContain('GITHUB_APP_ID=1')
  })

  it('undo adds a line break before the GitHub lines when the file has none', async () => {
    await rollout(opts({ apply: true }))
    fs.writeFileSync(path.join(home, '.env'), 'ONLY=one')
    await undo(opts())
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8').split('\n')).toContain('ONLY=one')
  })

  it('a failed roll keeps a line written while it was verifying', async () => {
    writeFd('write-during-recreate', 'WRITTEN_DURING_VERIFY=yes\n')
    writeFd('verify.out', 'gh-failed\n')
    writeFd('verify.rc', '13')
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(false)
    const after = fs.readFileSync(path.join(home, '.env'), 'utf-8')
    expect(after).toContain('WRITTEN_DURING_VERIFY=yes\n')
    expect(after).toContain(`GITHUB_TOKEN=${FAKE_PAT}\n`)
    expect(after).toContain('DISCORD_BOT_TOKEN=keep-me\n')
  })

  it('undo brings back a copy removed since, and leaves one that is still there', async () => {
    fs.writeFileSync(path.join(home, '.env.bak'), ENV)
    fs.writeFileSync(path.join(home, '.env.old'), ENV)
    await rollout(opts({ apply: true }))
    fs.rmSync(path.join(home, '.env.bak'))
    fs.appendFileSync(path.join(home, '.env.old'), 'MINE=1\n')
    await undo(opts())
    expect(fs.readFileSync(path.join(home, '.env.bak'), 'utf-8')).toBe(ENV)
    expect(fs.readFileSync(path.join(home, '.env.old'), 'utf-8')).toContain('MINE=1\n')
  })

  describe('when editing files throws partway', () => {
    const backups = () => (fs.existsSync(path.join(dir, 'env-backups')) ? fs.readdirSync(path.join(dir, 'env-backups')) : [])
    const expectPutBack = () => {
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
      expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(false)
      expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(false)
      expect(calls()).not.toMatch(/^compose/m)
      expect(backups()).toEqual([])
    }
    let locked: string | null = null
    afterEach(() => {
      if (locked) fs.chmodSync(locked, 0o700)
      locked = null
    })

    it('puts the agent back on a read-only profile, with no stack trace and no half move', async () => {
      const prof = path.join(home, 'profiles', 'p1')
      fs.mkdirSync(prof, { recursive: true })
      fs.writeFileSync(path.join(prof, '.env'), ENV)
      fs.chmodSync(prof, 0o500)
      locked = prof
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(false)
      expect(r.lines.join('\n')).toMatch(/FAILED: .*EACCES/)
      expect(r.lines.join('\n')).toMatch(/restored/i)
      expectPutBack()
      expect(fs.readFileSync(path.join(prof, '.env'), 'utf-8')).toBe(ENV)
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).agents.mare).toBeUndefined()
    })

    it('puts the agent back when the registry has a typo, and does not overwrite the file', async () => {
      fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {},}')
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(false)
      expectPutBack()
      expect(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).toBe('{"agents": {},}')
    })

    it('puts the agent back when the audit log cannot be written', async () => {
      fs.mkdirSync(path.join(dir, 'audit.jsonl'))
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(false)
      expectPutBack()
    })

    it('blocks rather than throws on an .env it cannot read', async () => {
      fs.chmodSync(path.join(home, '.env'), 0)
      locked = path.join(home, '.env')
      const r = await rollout(opts({ apply: true }))
      expect(r.ok).toBe(false)
      expect(r.lines.join('\n')).toMatch(/BLOCKED: .*EACCES/)
      expect(calls()).not.toMatch(/^compose/m)
    })

    it('keeps the backup and says to run undo when the restore itself fails', async () => {
      writeFd('lock-home-during-recreate', '')
      writeFd('verify.rc', '13')
      writeFd('verify.out', 'gh-failed\n')
      locked = home
      const r = await rollout(opts({ apply: true }))
      fs.chmodSync(home, 0o700)
      fs.rmSync(path.join(fd, 'lock-home-during-recreate'))
      expect(r.ok).toBe(false)
      expect(r.lines.join('\n')).toMatch(/ghkey undo mare/)
      expect(backups()).toHaveLength(1)
      expect((await undo(opts())).ok).toBe(true)
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    })

    it('undo reports a failure and can be run again', async () => {
      await rollout(opts({ apply: true }))
      fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {},}')
      const r = await undo(opts())
      expect(r.ok).toBe(false)
      expect(r.lines.join('\n')).toMatch(/ghkey undo mare/)
      fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {}}')
      expect((await undo(opts())).ok).toBe(true)
      expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
    })
  })

  describe('after a credential came back and the agent was rolled again', () => {
    const FAKE_RETURNED = 'fake-returned-value'
    const rollTwice = async () => {
      await rollout(opts({ apply: true }))
      fs.appendFileSync(path.join(home, '.env'), `GH_TOKEN=${FAKE_RETURNED}\n`)
      await rollout(opts({ apply: true }))
    }

    it('undo brings back the original credentials too, not just the returned line', async () => {
      await rollTwice()
      const r = await undo(opts())
      expect(r.ok).toBe(true)
      const text = fs.readFileSync(path.join(home, '.env'), 'utf-8')
      expect(scanEnvText(text).sort()).toEqual([...scanEnvText(ENV), 'GH_TOKEN'].sort())
      expect(text).toContain(FAKE_PAT)
      expect(text).toContain(FAKE_KEY)
      expect(text).toContain(FAKE_RETURNED)
    })

    it('the newest value wins when a name is in more than one backup', async () => {
      await rollout(opts({ apply: true }))
      fs.appendFileSync(path.join(home, '.env'), 'GITHUB_TOKEN=fake-newer-value\n')
      await rollout(opts({ apply: true }))
      await undo(opts())
      const text = fs.readFileSync(path.join(home, '.env'), 'utf-8')
      expect(text).toContain('GITHUB_TOKEN=fake-newer-value')
      expect(text).not.toContain(`GITHUB_TOKEN=${FAKE_PAT}`)
    })

    it('a line she removed between an undo and the next roll stays gone', async () => {
      await rollout(opts({ apply: true }))
      await undo(opts())
      const envPath = path.join(home, '.env')
      fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf-8').replace(`GITHUB_PERSONAL_ACCESS_TOKEN=${FAKE_PAT}\n`, ''))
      await rollout(opts({ apply: true }))
      await undo(opts())
      expect(scanEnvText(fs.readFileSync(envPath, 'utf-8'))).not.toContain('GITHUB_PERSONAL_ACCESS_TOKEN')
    })

    it('a used backup stays on disk until purge', async () => {
      await rollTwice()
      await undo(opts())
      const all = fs.readdirSync(path.join(dir, 'env-backups'), { recursive: true }) as string[]
      expect(all.filter((f) => f.endsWith('.env'))).toHaveLength(2)
      expect((await undo(opts())).lines.join('\n')).toMatch(/no backup/)
      purgeBackups({ dir })
      expect(fs.existsSync(path.join(dir, 'env-backups'))).toBe(false)
    })
  })

  describe('a PAT in a git or gh login file', () => {
    // Built at runtime: the sanitization gate reads a literal as a real credential.
    const PAT = ['gh', 'p_', 'fakeLoginFileValue'].join('')
    const SHORT = ['gh', 's_', 'fakeShortLived'].join('')
    const line = (user: string, secret: string, host = 'github.com') => `https://${user}:${secret}${'@'}${host}\n`
    const hosts = (token: string) => `github.com:\n    users:\n        someone:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: someone\n`
    const creds = () => path.join(home, 'home', '.git-credentials')
    const hostsFile = () => path.join(home, 'home', '.config', 'gh', 'hosts.yml')
    const plant = () => {
      fs.mkdirSync(path.dirname(hostsFile()), { recursive: true })
      fs.writeFileSync(creds(), line('login', PAT) + line('me', 'other-host-value', 'gitlab.example'))
      fs.writeFileSync(hostsFile(), hosts(PAT))
    }

    it('shows both files in the dry run, without the value, and changes nothing', async () => {
      plant()
      const text = (await rollout(opts())).lines.join('\n')
      expect(text).toContain('home/.git-credentials: a GitHub token')
      expect(text).toContain('home/.config/gh/hosts.yml: a GitHub token')
      expect(text).not.toContain(PAT)
      expect(fs.readFileSync(hostsFile(), 'utf-8')).toBe(hosts(PAT))
    })

    it('removes the PAT from both on apply, and keeps a line for another host', async () => {
      plant()
      expect((await rollout(opts({ apply: true }))).ok).toBe(true)
      expect(fs.readFileSync(creds(), 'utf-8')).toBe(line('me', 'other-host-value', 'gitlab.example'))
      expect(fs.existsSync(hostsFile())).toBe(false)
    })

    it('checks the files in the gateway HOME and in profiles too', async () => {
      const gateway = path.join(home, '.config', 'gh', 'hosts.yml')
      const profile = path.join(home, 'profiles', 'p', 'home', '.git-credentials')
      fs.mkdirSync(path.dirname(gateway), { recursive: true })
      fs.mkdirSync(path.dirname(profile), { recursive: true })
      fs.writeFileSync(gateway, hosts(PAT))
      fs.writeFileSync(profile, line('login', PAT))
      await rollout(opts({ apply: true }))
      expect(fs.existsSync(gateway)).toBe(false)
      expect(fs.existsSync(profile)).toBe(false)
    })

    it('leaves a short-lived broker token and a login for another host alone', async () => {
      fs.mkdirSync(path.dirname(hostsFile()), { recursive: true })
      const other = line('x-access-token', SHORT) + line('me', 'other-host-value', 'gitlab.example')
      fs.writeFileSync(creds(), other)
      fs.writeFileSync(hostsFile(), hosts(SHORT))
      const text = (await rollout(opts({ apply: true }))).lines.join('\n')
      expect(text).not.toContain('a GitHub token')
      expect(fs.readFileSync(creds(), 'utf-8')).toBe(other)
      expect(fs.readFileSync(hostsFile(), 'utf-8')).toBe(hosts(SHORT))
    })

    it('keeps another host in hosts.yml when it removes the GitHub block', () => {
      const other = 'ghe.example:\n    oauth_token: other-host-value\n'
      expect(stripGhHosts(hosts(PAT) + other)).toBe(other)
    })

    it('a failed roll puts both back byte for byte', async () => {
      plant()
      const before = fs.readFileSync(creds(), 'utf-8')
      writeFd('verify.rc', '12')
      writeFd('verify.out', 'git-no-token\n')
      expect((await rollout(opts({ apply: true }))).ok).toBe(false)
      expect(fs.readFileSync(creds(), 'utf-8')).toBe(before)
      expect(fs.readFileSync(hostsFile(), 'utf-8')).toBe(hosts(PAT))
    })

    it('undo restores them over the broker-era hosts.yml that boot wrote', async () => {
      plant()
      const before = fs.readFileSync(creds(), 'utf-8')
      await rollout(opts({ apply: true }))
      fs.writeFileSync(hostsFile(), `# managed-by: hermes git_credentials_boot\n${hosts(SHORT)}`)
      expect((await undo(opts())).ok).toBe(true)
      expect(fs.readFileSync(creds(), 'utf-8')).toBe(before)
      expect(fs.readFileSync(hostsFile(), 'utf-8')).toBe(hosts(PAT))
    })

    it('undo keeps a gh login made since, and a line added since', async () => {
      plant()
      const before = fs.readFileSync(creds(), 'utf-8')
      await rollout(opts({ apply: true }))
      const later = ['gh', 'o_', 'fakeLaterLogin'].join('')
      fs.writeFileSync(hostsFile(), hosts(later))
      fs.appendFileSync(creds(), line('new', 'new-host-value', 'codeberg.example'))
      await undo(opts())
      expect(fs.readFileSync(hostsFile(), 'utf-8')).toBe(hosts(later))
      const text = fs.readFileSync(creds(), 'utf-8').split('\n')
      expect(text).toEqual(expect.arrayContaining([...before.split('\n'), line('new', 'new-host-value', 'codeberg.example').trim()]))
    })

    describe('the verify step', () => {
      const runVerify = (ghToken: string) => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bin-'))
        fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$1" in credential) echo password=${SHORT} ;; esac\nexit 0\n`, { mode: 0o755 })
        fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$1" in auth) echo ${ghToken} ;; api) echo o/r ;; esac\nexit 0\n`, { mode: 0o755 })
        const r = spawnSync('sh', ['-c', VERIFY_SH], { encoding: 'utf-8', env: { PATH: `${bin}:/usr/bin:/bin`, NODE_ENV: 'test' } })
        fs.rmSync(bin, { recursive: true, force: true })
        return r
      }

      it('fails when gh is not using a broker token, without printing it', () => {
        const r = runVerify(PAT)
        expect(r.status).toBe(13)
        expect(r.stdout.trim()).toBe('gh-token-not-from-broker')
        expect(r.stdout + r.stderr).not.toContain(PAT)
      })

      it('passes when gh is using a broker token', () => {
        const r = runVerify(SHORT)
        expect(r.status).toBe(0)
        expect(r.stdout.trim()).toBe('ok')
      })
    })
  })

  it('blocks a roll while GitHub is rejecting the App key', async () => {
    const broker = createBroker({ dir })
    await broker.checkKey() // the placeholder key can't sign, so this stops before any network call
    const bad = await listen(broker, { host: '127.0.0.1', port: 0 })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app_id: 'x', installation_id: 'y', port: (bad.address() as AddressInfo).port }))
    const r = await rollout(opts({ apply: true }))
    await new Promise((res) => bad.close(res))
    expect(r.ok).toBe(false)
    expect(r.lines.join('\n')).toMatch(/BLOCKED: .*App key/)
    expect(calls()).not.toContain('compose -p')
  })

  it('undo takes an agent off the broker when it had no credentials to back up', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'DISCORD_BOT_TOKEN=keep-me\n')
    expect((await rollout(opts({ apply: true }))).ok).toBe(true)
    const before = calls().split('\n').filter((l) => l.startsWith('compose')).length
    const r = await undo(opts())
    expect(r.ok).toBe(true)
    expect(r.lines.join()).toContain('no GitHub lines to bring back')
    expect(fs.existsSync(path.join(home, 'github-broker.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, '.hsm-github-broker'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).agents.mare).toBeUndefined()
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe('DISCORD_BOT_TOKEN=keep-me\n')
    expect(calls().split('\n').filter((l) => l.startsWith('compose')).length).toBe(before + 1)
  })

  it('undo clears a registry entry left with no files in the home', async () => {
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ agents: { mare: { secret_sha256: 'aa', repos: 'all', permissions: 'all' } } }))
    expect((await undo(opts())).ok).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).agents.mare).toBeUndefined()
  })

  it('undo with no backup says so and changes nothing', async () => {
    const r = await undo(opts())
    expect(r.ok).toBe(false)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe(ENV)
  })

  it('purges backups', async () => {
    await rollout(opts({ apply: true }))
    purgeBackups({ dir })
    expect(fs.existsSync(path.join(dir, 'env-backups'))).toBe(false)
  })

  it('lists which agents still carry the App key, for the old-key delete hold', () => {
    expect(agentsHoldingAppKey(root)).toEqual(['mare'])
    fs.writeFileSync(path.join(home, '.env'), 'OK=1\n')
    expect(agentsHoldingAppKey(root)).toEqual([])
  })

  it('exports a credential list that includes the App key and PAT names', () => {
    expect(CREDENTIAL_VARS).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID']))
  })
})
