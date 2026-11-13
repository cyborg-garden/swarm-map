// @vitest-environment node
//
// Pi's environment is listed by hand. Three of its lines are the only thing
// that tells a real Pi to stay off the network at start-up: no version check,
// no telemetry, no fetching. Nothing else in the lab would notice them going
// missing, so they are pinned here.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { piArgs, piEnv, sessionDirFor } from '../shim.ts'

const base = { agentDir: '/cell/agent', homeDir: '/cell/home' }

describe('the environment the shim gives Pi', () => {
  it('[U:pi-env] tells Pi to stay offline: no fetching, no telemetry, no version check', () => {
    expect(piEnv(base)).toMatchObject({ PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' })
  })

  it('[U:pi-env] extra rig variables cannot switch those off', () => {
    const env = piEnv({ ...base, rigEnv: { PI_OFFLINE: '0', PI_TELEMETRY: '1', PI_SKIP_VERSION_CHECK: '0', EXTRA: 'kept' } })
    expect(env).toMatchObject({ PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', EXTRA: 'kept' })
  })

  it('[U:pi-env] is listed by hand: exactly these names, and nothing from the process that starts it', () => {
    process.env.PI_ENV_TEST_CANARY = 'from-the-host'
    try {
      expect(Object.keys(piEnv(base)).sort()).toEqual([
        'HOME', 'PATH', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'SWARM_GATE_TIMEOUT_MS',
      ])
    } finally {
      delete process.env.PI_ENV_TEST_CANARY
    }
  })

  it('[U:pi-env] HOME and PATH are the cell\'s own, never the host\'s', () => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
    process.env.HOME = '/Users/host-person'
    process.env.PATH = '/host/only/bin:/usr/bin'
    try {
      const env = piEnv(base)
      expect(env.HOME).toBe('/cell/home')
      expect(env.PI_CODING_AGENT_DIR).toBe('/cell/agent')
      expect(env.PATH).toBe([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'))
      expect(env.PATH).not.toContain('/host/only/bin')
    } finally {
      process.env.HOME = saved.HOME
      process.env.PATH = saved.PATH
    }
  })
})

// Pi's flags are the other half of what it is started with. Each `--no-*`
// switches off a way for Pi to pick up tools or instructions the door never
// saw. The fake Pi ignores them, so nothing but this would notice one going.
describe('the flags the shim gives Pi', () => {
  const o = { sessionDir: '/cell/sessions/abc', gate: { path: '/cell/gate.ts' }, model: 'scripted' }

  it('[U:pi-env] with tools: exactly these flags, in this order', () => {
    expect(piArgs({ ...o, tools: ['bash', 'read'] })).toEqual([
      '--mode', 'rpc', '--session-dir', '/cell/sessions/abc', '--provider', 'swarm', '--model', 'scripted',
      '--tools', 'bash,read',
      '--no-context-files', '--no-skills', '--no-mcp', '--no-extensions', '--no-prompt-templates',
      '-e', '/cell/gate.ts',
    ])
  })

  it('[U:pi-env] with no tools allowed, Pi is told to load none of its own', () => {
    const args = piArgs({ ...o, tools: [] })
    expect(args).toContain('--no-builtin-tools')
    expect(args).not.toContain('--tools')
  })

  it('[U:pi-env] a session that is picked up again says so, and only then', () => {
    expect(piArgs({ ...o, tools: [], resume: true })).toContain('--continue')
    expect(piArgs({ ...o, tools: [] })).not.toContain('--continue')
  })

  it('[U:pi-env] each session has a folder of its own, and the same session finds its folder again', () => {
    const a = sessionDirFor('/cell/sessions', 'fake:room:r-general')
    const b = sessionDirFor('/cell/sessions', 'fake:room:r-lounge')
    expect(a).not.toBe(b)
    expect(sessionDirFor('/cell/sessions', 'fake:room:r-general')).toBe(a)
    expect(path.dirname(a)).toBe('/cell/sessions')
    // The key is not used as a path: it cannot climb out of the sessions folder.
    expect(path.dirname(sessionDirFor('/cell/sessions', '../../etc'))).toBe('/cell/sessions')
  })
})
