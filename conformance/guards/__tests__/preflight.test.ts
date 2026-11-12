// @vitest-environment node
//
// Negative controls for the fake-proof guards. Each guard must refuse a
// known-bad input; a guard that cannot be made to refuse proves nothing.
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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
    // A temp dir that itself sits inside an agent home is still refused.
    expect(() => assertSafeWorkDir('/Users/someone/.hermes-x/tmp/w', { home, tmp: '/Users/someone/.hermes-x/tmp' })).toThrow(RefusingToRun)
  })
})
