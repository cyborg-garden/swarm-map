// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkGithubCredentials, GITHUB_CREDENTIAL_VARS } from '../github-credential-check'
import { CREDENTIAL_VARS, scanEnvText, stripGithubCredentials } from '../../../scripts/token-broker/rollout.mjs'

describe('checkGithubCredentials', () => {
  let root: string
  let keyPath: string
  const DAY = 86400e3
  const NOW = Date.UTC(2026, 10, 3)

  const agent = (name: string, env: string, brokered = false) => {
    const dataDir = path.join(root, name)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, '.env'), env)
    if (brokered) fs.writeFileSync(path.join(dataDir, '.hsm-github-broker'), '')
    return { name, dataDir }
  }
  const setKeyAge = (days: number) => {
    fs.writeFileSync(keyPath, 'unused')
    const t = new Date(NOW - days * DAY)
    fs.utimesSync(keyPath, t, t)
  }
  const check = (agents: { name: string; dataDir: string }[]) => checkGithubCredentials({ agents, keyPath, now: NOW })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-check-'))
    keyPath = path.join(root, 'private-key.pem')
    setKeyAge(1)
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('passes a brokered agent with a clean .env', () => {
    const r = check([agent('a', 'OTHER=1\n', true)])
    expect(r.status).toBe('ok')
    expect(r.failing).toEqual([])
  })

  it.each(['GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_APP_PRIVATE_KEY_B64'])(
    'fails loud when %s reappears on a brokered agent',
    (name) => {
      const r = check([agent('a', `${name}=value-do-not-print\n`, true)])
      expect(r.status).toBe('fail')
      expect(r.failing).toEqual([{ agent: 'a', file: '.env', vars: [name] }])
      expect(r.message).toContain('a')
    },
  )

  it('never carries a value anywhere in the report', () => {
    const secret = 'value-do-not-print'
    const r = check([
      agent('a', `GITHUB_TOKEN=${secret}\n`, true),
      agent('b', `GITHUB_TOKEN=${secret}\nX=gh${'p_'}${'A'.repeat(36)}\n`),
    ])
    expect(JSON.stringify(r)).not.toContain(secret)
    expect(JSON.stringify(r)).not.toContain('AAAA')
  })

  it('catches a token-shaped value under another name, a commented one, and an env backup', () => {
    const dir = agent('a', `SOME_BOT=gh${'p_'}${'A'.repeat(36)}\n# GITHUB_PAT=old\n`, true)
    fs.writeFileSync(path.join(dir.dataDir, '.env.bak'), 'GITHUB_TOKEN=x\n')
    const r = check([dir])
    expect(r.status).toBe('fail')
    expect(r.failing).toContainEqual({ agent: 'a', file: '.env', vars: ['SOME_BOT', 'GITHUB_PAT'] })
    expect(r.failing).toContainEqual({ agent: 'a', file: '.env.bak', vars: ['GITHUB_TOKEN'] })
  })

  it('checks profile .env files', () => {
    const dir = agent('a', 'OK=1\n', true)
    fs.mkdirSync(path.join(dir.dataDir, 'profiles', 'p'), { recursive: true })
    fs.writeFileSync(path.join(dir.dataDir, 'profiles', 'p', '.env'), 'GITHUB_TOKEN=x\n')
    expect(check([dir]).failing).toEqual([{ agent: 'a', file: 'profiles/p/.env', vars: ['GITHUB_TOKEN'] }])
  })

  it('ignores a bare empty placeholder and .env.example', () => {
    const dir = agent('a', 'GITHUB_TOKEN=\n# GITHUB_PAT=\n', true)
    fs.writeFileSync(path.join(dir.dataDir, '.env.example'), 'GITHUB_TOKEN=your-token\n')
    expect(check([dir]).status).toBe('ok')
  })

  it('lists an agent not yet moved as pending, not as a failure', () => {
    const r = check([agent('a', 'GITHUB_TOKEN=x\n')])
    expect(r.status).toBe('pending')
    expect(r.failing).toEqual([])
    expect(r.pending).toEqual([{ agent: 'a', file: '.env', vars: ['GITHUB_TOKEN'] }])
  })

  it('says when the key is over 90 days old', () => {
    setKeyAge(91)
    const r = check([agent('a', 'OK=1\n', true)])
    expect(r.status).toBe('key-old')
    expect(r.key).toEqual({ present: true, ageDays: 91, over90: true })
    expect(r.message).toContain('91 days')
    expect(r.message).toContain('ghkey')
    setKeyAge(90)
    expect(check([agent('a', 'OK=1\n', true)]).status).toBe('ok')
  })

  it('keeps fail ahead of an old key, and reports both', () => {
    setKeyAge(200)
    const r = check([agent('a', 'GITHUB_TOKEN=x\n', true)])
    expect(r.status).toBe('fail')
    expect(r.message).toContain('200 days')
  })

  it('fails when brokered agents exist but the key is gone', () => {
    fs.rmSync(keyPath)
    const r = check([agent('a', 'OK=1\n', true)])
    expect(r.status).toBe('fail')
    expect(r.key.present).toBe(false)
  })

  it('stays quiet on a host with no broker at all', () => {
    fs.rmSync(keyPath)
    const r = check([agent('a', 'GITHUB_TOKEN=x\n')])
    expect(r.status).toBe('ok')
    expect(r.message).not.toMatch(/No GitHub credentials/)
    expect(r.pending).toHaveLength(1)
  })

  it('names an unmoved agent holding a credential and says how to move it', () => {
    const r = check([agent('newbie', 'GITHUB_TOKEN=x\n')])
    expect(r.status).toBe('pending')
    expect(r.message).toMatch(/newbie/)
    expect(r.message).toMatch(/ghkey roll/)
  })

  it('still treats an agent as moved when only its marker has gone', () => {
    const a = agent('a', 'GITHUB_TOKEN=x\n')
    fs.writeFileSync(path.join(a.dataDir, 'github-broker.json'), '{}')
    expect(check([a]).status).toBe('fail')
  })

  it.each([
    ['CRLF line endings', '.env', 'GITHUB_TOKEN=x\r\nOTHER=1\r\n'],
    ['spaces around the equals', '.env', 'GITHUB_TOKEN = x\n'],
    ['a dash-named copy', '.env-old', 'GITHUB_TOKEN=x\n'],
    ['an underscore-named copy', '.env_save', 'GITHUB_TOKEN=x\n'],
    ['a copy in a profile', 'profiles/p/.env.bak', 'GITHUB_TOKEN=x\n'],
  ])('catches %s', (_name, file, body) => {
    const a = agent('a', 'OTHER=1\n', true)
    fs.mkdirSync(path.dirname(path.join(a.dataDir, file)), { recursive: true })
    fs.writeFileSync(path.join(a.dataDir, file), body)
    const r = check([a])
    expect(r.status).toBe('fail')
    expect(r.failing).toEqual([{ agent: 'a', file, vars: ['GITHUB_TOKEN'] }])
  })

  it('fails on an .env it cannot read, rather than calling it clean', () => {
    const a = agent('a', 'OTHER=1\n', true)
    fs.chmodSync(path.join(a.dataDir, '.env'), 0)
    const r = check([a])
    fs.chmodSync(path.join(a.dataDir, '.env'), 0o600)
    expect(r.status).toBe('fail')
    expect(r.unreadable).toEqual([{ agent: 'a', file: '.env' }])
    expect(r.message).toMatch(/a \.env/)
  })

  it('agrees with the rollout on which variables are credentials', () => {
    expect([...GITHUB_CREDENTIAL_VARS].sort()).toEqual([...CREDENTIAL_VARS].sort())
  })

  it('fails when the broker registry has a typo, and quotes nothing from the file', () => {
    const reg = path.join(root, 'registry.json')
    fs.writeFileSync(reg, '{"agents": {"quoted-text": {},},}')
    const r = check([agent('a', 'OTHER=1\n', true)])
    expect(r.status).toBe('fail')
    expect(r.message).toMatch(/registry\.json/)
    expect(r.message).not.toContain('quoted-text')
    fs.writeFileSync(reg, '{"agents": {"a": {}}}')
    expect(check([agent('a', 'OTHER=1\n', true)]).status).toBe('ok')
  })

  it('does not blame GitHub for a private key under another name', () => {
    const r = check([agent('a', 'GOOGLE_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklW\nSOME_SSH_KEY="-----BEGIN OPENSSH"\n', true)])
    expect(r.status).toBe('ok')
  })

  // The check's advice is "run ghkey roll". That only holds if the check flags
  // exactly what the rollout strips, so run every shape through both.
  it.each([
    ['GITHUB_TOKEN=x', true],
    ['# GITHUB_PAT=old', true],
    ['export GH_TOKEN=x', true],
    [`MY_GITHUB_KEY=gh${'p_'}${'A'.repeat(36)}`, true],
    [`MY_KEY=github_${'pat_'}AAAA`, true],
    [`# OLD=gh${'p_'}AAAA`, true],
    [`SOME_BOT="gh${'s_'}AAAA"`, true],
    ['GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----', true],
    ['MY_GH_KEY=LS0tLS1CRUdJTiBSU0E', true],
    ['GOOGLE_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklW', false],
    ['SOME_SSH_KEY="-----BEGIN OPENSSH"', false],
    ['GITHUB_TOKEN = spaced', true],
    ['  # export GITHUB_TOKEN = spaced', true],
    ['GITHUB_TOKEN=crlf\r', true],
    ['NOT_GITHUB_TOKEN=keep', false],
    ['GITHUB_WEBHOOK_SECRET=keep', false],
  ])('flags and strips %s the same way', (line, flagged) => {
    const r = check([agent('a', `${line}\n`, true)])
    expect(r.status === 'fail').toBe(flagged)
    expect(scanEnvText(line).length > 0).toBe(flagged)
    expect(stripGithubCredentials(line) === '').toBe(flagged)
  })

  it('survives an agent with no data dir', () => {
    expect(check([{ name: 'gone', dataDir: path.join(root, 'nope') }]).status).toBe('ok')
  })
})
