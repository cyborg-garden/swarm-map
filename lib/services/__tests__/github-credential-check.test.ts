// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkGithubCredentials, GITHUB_CREDENTIAL_VARS } from '../github-credential-check'
import { CREDENTIAL_VARS } from '../../../scripts/token-broker/rollout.mjs'

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

  it('stays quiet about a missing key before anyone has moved', () => {
    fs.rmSync(keyPath)
    expect(check([agent('a', 'GITHUB_TOKEN=x\n')]).status).toBe('pending')
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

  it('survives an agent with no data dir', () => {
    expect(check([{ name: 'gone', dataDir: path.join(root, 'nope') }]).status).toBe('ok')
  })
})
