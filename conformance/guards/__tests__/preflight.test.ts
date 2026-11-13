// @vitest-environment node
//
// Negative controls for the fake-proof guards. Each guard must refuse a
// known-bad input; a guard that cannot be made to refuse proves nothing.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertLocalDocker, assertNoCredentials, assertOurProject, assertSafeWorkDir, RefusingToRun,
} from '../preflight.ts'

describe('F2: no real credential is present', () => {
  it('refuses an env that names a chat token, even with a junk value', () => {
    expect(() => assertNoCredentials({ PATH: '/usr/bin', DISCORD_BOT_TOKEN: 'x' }))
      .toThrow(/^REFUSING TO RUN: F2 .*DISCORD_BOT_TOKEN/)
  })

  it.each([
    'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD',
  ])('refuses the name %s', (name) => {
    expect(() => assertNoCredentials({ [name]: 'x' })).toThrow(RefusingToRun)
  })

  it('refuses a value shaped like a credential under an innocent name', () => {
    // Minted here so no key-shaped string is ever committed.
    const shaped = [
      ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-'),
      'ghp_' + 'a1B2'.repeat(9),
      ['xoxb', '1234567890', 'abcdefghijkl'].join('-'),
      'AKIA' + 'ABCDEFGH'.repeat(2),
      '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    ]
    for (const value of shaped) {
      expect(() => assertNoCredentials({ NOTES: value }), value.slice(0, 6)).toThrow(/^REFUSING TO RUN: F2 .*NOTES/)
    }
  })

  it.each([
    'OPENAI_API_KEY_2', 'API_KEY_PROD', 'MYSQL_PWD', 'GH_PAT', 'KUBECONFIG', 'SSH_AUTH_SOCK', 'GOOGLE_APPLICATION_CREDENTIALS',
    'NPM_AUTH', 'PGPASSFILE', 'SESSION_COOKIE', 'DATABASE_URL', 'REDIS_DSN', 'my_token_backup',
    'SMTP_PASS', 'GPG_PASSPHRASE', 'DISCORD_WEBHOOK', 'NETRC', 'BEARER', 'DB_PW', 'SIGNAL_PIN', 'DATABASE_URL_PROD',
  ])('refuses the name %s, wherever the telling word sits in it', (name) => {
    expect(() => assertNoCredentials({ [name]: 'x' })).toThrow(RefusingToRun)
  })

  it('refuses more shapes of real credential under an innocent name', () => {
    // Minted here so no key-shaped string is ever committed.
    const b64 = (text: string): string => Buffer.from(text).toString('base64url')
    const shaped: [string, string][] = [
      ['a URL with a password in it', 'postgres://' + 'user:' + 'hunter2' + '@db.example:5432/x'],
      ['a JSON web token', [b64('{"alg":"HS256"}'), b64('{"sub":"1234567890"}'), 'A'.repeat(32)].join('.')],
      ['a payment key', ['sk', 'live', 'A1b2'.repeat(6)].join('_')],
      ['a Google key', 'AI' + 'za' + 'B'.repeat(35)],
      ['a model hub token', 'hf' + '_' + 'c'.repeat(34)],
      ['a GitLab token', 'gl' + 'pat-' + 'd'.repeat(20)],
      ['a registry token', 'np' + 'm_' + 'e'.repeat(36)],
      ['an app-level chat token', ['xapp', '1', 'A0123456789', 'f'.repeat(20)].join('-')],
      ['a bot token in three dotted parts', ['M'.repeat(24), 'G'.repeat(6), 'h'.repeat(27)].join('.')],
      ['a bot token as id:secret', '1234567890' + ':' + 'A'.repeat(35)],
    ]
    for (const [what, value] of shaped) {
      expect(() => assertNoCredentials({ NOTES: value }), what).toThrow(/^REFUSING TO RUN: F2 .*NOTES/)
    }
  })

  it('positive control: ordinary values are not mistaken for credentials', () => {
    expect(() => assertNoCredentials({
      PATH: '/usr/local/bin:/usr/bin', HOME: '/home/runner', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      NODE_OPTIONS: '--import file:///tmp/x/child-tripwire.ts', PI_OFFLINE: '1', SWARM_GATE_TIMEOUT_MS: '2000',
      HOMEPAGE: 'https://example.org/a/b?c=d', VERSION: '1.5.2', SHLVL: '1',
    })).not.toThrow()
  })

  it('never prints the value it found', () => {
    const value = 'ghp_' + 'z9Y8'.repeat(9)
    try {
      assertNoCredentials({ NOTES: value })
      expect.unreachable()
    } catch (err) {
      expect(String(err)).not.toContain(value)
    }
  })

  it('accepts a plain env and the fakes minted for one run', () => {
    expect(() => assertNoCredentials({
      PATH: '/usr/bin', HOME: '/home/runner', SWARMLAB_NONCE: 'deadbeef',
      SWARMLAB_FAKE_CHAT: 'FAKECHAT-deadbeef', SWARMLAB_UPSTREAM: 'UPSTREAM-deadbeef',
    }, { nonce: 'deadbeef' })).not.toThrow()
  })

  it('accepts the run fakes only when they carry the nonce of this run', () => {
    expect(() => assertNoCredentials({ SWARMLAB_UPSTREAM: 'UPSTREAM-0badf00d' }, { nonce: 'deadbeef' }))
      .toThrow(RefusingToRun)
  })
})

describe('F5: a work dir is judged by where it really is', () => {
  let scratch: string
  beforeEach(() => { scratch = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-f5-')) })
  afterEach(() => rmSync(scratch, { recursive: true, force: true }))

  it('refuses a link under the temp dir that points outside it', () => {
    const outside = path.join(scratch, 'pretend-home')
    const tmp = path.join(scratch, 'pretend-tmp')
    mkdirSync(outside); mkdirSync(tmp)
    symlinkSync(outside, path.join(tmp, 'link'))
    expect(() => assertSafeWorkDir(path.join(tmp, 'link', 'work'), { home: outside, tmp })).toThrow(/^REFUSING TO RUN: F5 /)
    // Even when where it points is not the home directory: it is still not under the temp dir.
    expect(() => assertSafeWorkDir(path.join(tmp, 'link', 'work'), { home: '/nowhere', tmp })).toThrow(/not under the temp dir/)
  })

  it('positive control: a real folder under the temp dir is accepted, also when the temp dir is itself reached through a link', () => {
    const real = path.join(scratch, 'real-tmp')
    mkdirSync(real)
    symlinkSync(real, path.join(scratch, 'tmp-link'))
    expect(() => assertSafeWorkDir(path.join(real, 'w'), { home: '/nowhere', tmp: real })).not.toThrow()
    expect(() => assertSafeWorkDir(path.join(scratch, 'tmp-link', 'w'), { home: '/nowhere', tmp: path.join(scratch, 'tmp-link') })).not.toThrow()
  })
})

describe('F5: Docker is the local one, and the project is ours', () => {
  it('refuses a remote Docker host', () => {
    expect(() => assertLocalDocker({ dockerHost: 'ssh://remote-host' })).toThrow(/^REFUSING TO RUN: F5 /)
    expect(() => assertLocalDocker({ dockerHost: 'tcp://192.0.2.5:2375' })).toThrow(RefusingToRun)
    expect(() => assertLocalDocker({ contextEndpoint: 'ssh://someone@remote-host' })).toThrow(RefusingToRun)
    expect(() => assertLocalDocker({ contextEndpoint: '' })).toThrow(RefusingToRun)
  })

  it('accepts a local unix socket', () => {
    expect(() => assertLocalDocker({ contextEndpoint: 'unix:///var/run/docker.sock' })).not.toThrow()
    expect(() => assertLocalDocker({ dockerHost: 'unix:///tmp/d.sock', contextEndpoint: 'unix:///tmp/d.sock' })).not.toThrow()
  })

  it('refuses a project or container name that is not from the lab', () => {
    expect(() => assertOurProject('hermes-swarm', [])).toThrow(/^REFUSING TO RUN: F5 /)
    expect(() => assertOurProject('swarmlab-DEADBEEF', [])).toThrow(RefusingToRun)
    expect(() => assertOurProject('swarmlab-deadbeef', ['hermes-agent-1'])).toThrow(/hermes-agent-1/)
    expect(() => assertOurProject('swarmlab-deadbeef', ['swarmlab-deadbeef-cell-1'])).not.toThrow()
  })

  it('refuses a work dir outside the temp dir or inside an agent home', () => {
    const home = '/Users/someone'
    const tmp = os.tmpdir()
    expect(() => assertSafeWorkDir(path.join(home, '.hermes-x', 'work'), { home, tmp })).toThrow(/^REFUSING TO RUN: F5 /)
    expect(() => assertSafeWorkDir(path.join(home, 'hermes-swarm'), { home, tmp })).toThrow(RefusingToRun)
    expect(() => assertSafeWorkDir(path.join(home, 'projects', 'x'), { home, tmp })).toThrow(RefusingToRun)
    expect(() => assertSafeWorkDir(path.join(tmp, '..', 'escape'), { home, tmp })).toThrow(RefusingToRun)
    expect(() => assertSafeWorkDir(path.join(tmp, 'swarmlab-deadbeef'), { home, tmp })).not.toThrow()
    // A temp dir that sits anywhere in the home directory is refused, agent home or not.
    expect(() => assertSafeWorkDir('/Users/someone/scratch/w', { home, tmp: '/Users/someone/scratch' })).toThrow(/home directory/)
    expect(() => assertSafeWorkDir('/Users/someone/.openclaw/w', { home, tmp: '/Users/someone' })).toThrow(RefusingToRun)
    // A temp dir that itself sits inside an agent home is still refused.
    expect(() => assertSafeWorkDir('/Users/someone/.hermes-x/tmp/w', { home, tmp: '/Users/someone/.hermes-x/tmp' })).toThrow(RefusingToRun)
  })
})
