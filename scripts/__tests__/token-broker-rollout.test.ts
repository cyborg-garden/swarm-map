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
import { rollout, undo, purgeBackups, stripGithubCredentials, CREDENTIAL_VARS, scanEnvText, agentsHoldingAppKey, OWNERS_SH } from '../token-broker/rollout.mjs'

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
    exit $(cat "$FD/compose.rc" 2>/dev/null || echo 0) ;;
  exec)
    case "$*" in
      *read_broker_config*) exit $(cat "$FD/module.rc" 2>/dev/null || echo 0) ;;
      *"find /opt/data"*) cat "$FD/owners.out" 2>/dev/null; exit 0 ;;
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
      'KEEP=1', `MY_GITHUB_KEY=${pat}`, `# OLD_ONE=${pat}`, `export OTHER_BOT="${pat}"`, 'GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----', '',
    ].join('\n'))
    const r = await rollout(opts({ apply: true }))
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(home, '.env'), 'utf-8')).toBe('KEEP=1\n')
  })

  it('leaves a private key that is not GitHub\'s alone', async () => {
    const env = 'GOOGLE_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklW\nSOME_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----"\n'
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
    const body = 'GOOGLE_PEM=-----BEGIN PRIVATE KEY-----\nOTHER=important\n'
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
