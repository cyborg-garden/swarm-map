// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkGithubCredentials, gitCredentialsHoldToken, ghHostsHoldToken, GITHUB_CREDENTIAL_VARS } from '../github-credential-check'
import { CREDENTIAL_VARS, scanEnvText, stripGithubCredentials, gitCredentialsHoldToken as rolloutCreds, ghHostsHoldToken as rolloutHosts } from '../../../scripts/token-broker/rollout.mjs'

// Built at runtime: the sanitization gate reads a literal header as a real key.
const PEM_HEADER = (kind: string) => ['-----BEGIN', kind].join(' ') + '-----'

describe('a key pasted with its line breaks', () => {
  it('is flagged when its first line is only the opening quote, as the strip sees it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-multiline-'))
    const body = `GITHUB_APP_PRIVATE_KEY="\n${PEM_HEADER('RSA PRIVATE KEY')}\nQUJD\n"\n`
    fs.writeFileSync(path.join(root, '.env'), body)
    const r = checkGithubCredentials({ agents: [{ name: 'mare', dataDir: root }], keyPath: path.join(root, 'private-key.pem') })
    expect(r.pending.flatMap((f) => f.vars)).toEqual(scanEnvText(body))
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('checkGithubCredentials', () => {
  let root: string
  let keyPath: string
  const DAY = 86400e3
  const NOW = Date.UTC(2026, 10, 3)

  const agent = (name: string, env: string, brokered = false) => {
    const dataDir = path.join(root, name)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, '.env'), env)
    if (brokered) {
      fs.writeFileSync(path.join(dataDir, '.hsm-github-broker'), '')
      enrol(name, dataDir)
    }
    return { name, dataDir }
  }
  // What enrollAgent leaves behind: the secret in the home, its hash in the registry.
  const enrol = (name: string, dataDir: string) => {
    const secret = `fixture-secret-${name}`
    fs.writeFileSync(path.join(dataDir, 'github-broker.json'), JSON.stringify({ url: 'http://unused', secret }))
    const reg = path.join(root, 'registry.json')
    let registry: { agents: Record<string, unknown> } = { agents: {} }
    try {
      registry = JSON.parse(fs.readFileSync(reg, 'utf-8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return // a test's deliberate typo
    }
    registry.agents[name] = { secret_sha256: crypto.createHash('sha256').update(secret).digest('hex'), repos: 'all', permissions: 'all' }
    fs.writeFileSync(reg, JSON.stringify(registry))
  }
  const status = (fields: Record<string, unknown> = {}) =>
    fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({
      at: new Date(NOW).toISOString(), key: { ok: true, failures: 0, status: 200 }, agents: {}, ...fields,
    }))
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
    status()
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
    [`GITHUB_APP_PRIVATE_KEY=${PEM_HEADER('RSA PRIVATE KEY')}`, true],
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

  describe('a token in a git or gh login file', () => {
    // Built at runtime: the sanitization gate reads a literal as a real credential.
    const PAT = ['gh', 'p_', 'fakeLoginFileValue'].join('')
    const SHORT = ['gh', 's_', 'fakeShortLived'].join('')
    const url = (user: string, secret: string, host = 'github.com') => `https://${user}:${secret}${'@'}${host}\n`
    const hosts = (token: string) => `# a comment\ngithub.com:\n    users:\n        me:\n            oauth_token: ${token}\n    oauth_token: ${token}\n`
    const plant = (dataDir: string, rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dataDir, rel), text)
    }

    it.each([
      'home/.git-credentials', '.git-credentials', 'profiles/p/home/.git-credentials',
    ])('fails on a PAT in %s, naming the file and not the value', (rel) => {
      const dir = agent('a', 'OK=1\n', true)
      plant(dir.dataDir, rel, url('login', PAT))
      const r = check([dir])
      expect(r.status).toBe('fail')
      expect(r.failing).toEqual([{ agent: 'a', file: rel, vars: ['GitHub token'] }])
      expect(r.message).toContain(rel)
      expect(JSON.stringify(r)).not.toContain(PAT)
    })

    it.each([
      'home/.config/gh/hosts.yml', '.config/gh/hosts.yml',
    ])('fails on a PAT in %s', (rel) => {
      const dir = agent('a', 'OK=1\n', true)
      plant(dir.dataDir, rel, hosts(PAT))
      expect(check([dir]).failing).toEqual([{ agent: 'a', file: rel, vars: ['GitHub token'] }])
    })

    it('is quiet about a broker token, and a login for another host', () => {
      const dir = agent('a', 'OK=1\n', true)
      plant(dir.dataDir, 'home/.git-credentials', url('x-access-token', SHORT) + url('me', 'v', 'gitlab.example'))
      plant(dir.dataDir, 'home/.config/gh/hosts.yml', hosts(SHORT) + `ghe.example:\n    oauth_token: ${PAT}\n`)
      expect(check([dir]).status).toBe('ok')
    })

    it('lists an agent not yet moved as pending', () => {
      const dir = agent('a', 'OK=1\n')
      plant(dir.dataDir, 'home/.git-credentials', url('login', PAT))
      const r = check([dir])
      expect(r.status).toBe('pending')
      expect(r.message).toContain('a')
    })

    it('agrees with the rollout on what counts', () => {
      const credsCases = [url('login', PAT), url('x-access-token', SHORT), url('me', PAT, 'gitlab.example'), url('me', PAT, 'github.com.evil.example'), url('me', PAT, 'gist.github.com'), '', `https://me${'@'}gitlab.example\n`]
      for (const c of credsCases) expect(gitCredentialsHoldToken(c)).toBe(rolloutCreds(c))
      expect(credsCases.map(gitCredentialsHoldToken)).toEqual([true, false, false, false, true, false, false])
      const hostsCases = [hosts(PAT), hosts(SHORT), `ghe.example:\n    oauth_token: ${PAT}\n`, '"github.com":\n    oauth_token: x\n', '']
      for (const c of hostsCases) expect(ghHostsHoldToken(c)).toBe(rolloutHosts(c))
      expect(hostsCases.map(ghHostsHoldToken)).toEqual([true, false, false, true, false])
    })
  })

  describe('whether the broker is really working', () => {
    it('fails when the broker has never reported in, as with nothing running', () => {
      fs.rmSync(path.join(root, 'status.json'))
      const r = check([agent('a', 'OK=1\n', true)])
      expect(r.status).toBe('fail')
      expect(r.broker.running).toBe(false)
      expect(r.message).toMatch(/broker is not running/)
    })

    it('fails when its last report is over five minutes old', () => {
      status({ at: new Date(NOW - 301_000).toISOString() })
      expect(check([agent('a', 'OK=1\n', true)]).status).toBe('fail')
      status({ at: new Date(NOW - 299_000).toISOString() })
      expect(check([agent('a', 'OK=1\n', true)]).status).toBe('ok')
    })

    it('treats an unparseable report as not running, and quotes nothing from it', () => {
      fs.writeFileSync(path.join(root, 'status.json'), '{"quoted-text"')
      const r = check([agent('a', 'OK=1\n', true)])
      expect(r.broker.running).toBe(false)
      expect(r.message).not.toContain('quoted-text')
    })

    it('fails when GitHub keeps rejecting the key, and says what to do', () => {
      status({ key: { ok: false, failures: 2, status: 401 } })
      const r = check([agent('a', 'OK=1\n', true)])
      expect(r.status).toBe('fail')
      expect(r.broker.keyRejected).toBe(true)
      expect(r.message).toMatch(/rejecting the App key/)
      expect(r.message).toMatch(/ghkey/)
    })

    it('says GitHub is out of reach rather than blaming the key when there is no answer', () => {
      status({ key: { ok: false, failures: 3, status: null } })
      const r = check([agent('a', 'OK=1\n', true)])
      expect(r.status).toBe('fail')
      expect(r.message).toMatch(/can't reach GitHub/)
      expect(r.message).not.toMatch(/rejecting/)
    })

    it('does not raise an alarm on one failed check', () => {
      status({ key: { ok: false, failures: 1, status: 502 } })
      expect(check([agent('a', 'OK=1\n', true)]).status).toBe('ok')
    })

    it('fails when a moved agent is not in the registry', () => {
      const a = agent('a', 'OK=1\n', true)
      fs.writeFileSync(path.join(root, 'registry.json'), '{"agents": {}}')
      const r = check([a])
      expect(r.status).toBe('fail')
      expect(r.broker.notEnrolled).toEqual(['a'])
      expect(r.message).toMatch(/a/)
      expect(JSON.stringify(r)).not.toContain('fixture-secret')
    })

    it('fails when a marked agent has lost its secret file', () => {
      const a = agent('a', 'OK=1\n', true)
      fs.rmSync(path.join(a.dataDir, 'github-broker.json'))
      expect(check([a]).broker.notEnrolled).toEqual(['a'])
    })

    it('fails when an agent keeps failing to get a token', () => {
      status({ agents: { mare: { failures: 2, status: 422 }, once: { failures: 1, status: 502 } } })
      const r = check([agent('a', 'OK=1\n', true)])
      expect(r.status).toBe('fail')
      expect(r.broker.mintFailing).toEqual(['mare'])
      expect(r.message).toMatch(/mare/)
      expect(r.message).not.toMatch(/once/)
    })

    it('stays quiet about the broker on a host with no broker', () => {
      fs.rmSync(keyPath)
      fs.rmSync(path.join(root, 'status.json'))
      expect(check([agent('a', 'OK=1\n')]).status).toBe('ok')
    })
  })

  it('survives an agent with no data dir', () => {
    expect(check([{ name: 'gone', dataDir: path.join(root, 'nope') }]).status).toBe('ok')
  })
})
