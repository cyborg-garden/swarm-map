// @vitest-environment node
//
// Pi's environment is listed by hand. Three of its lines are the only thing
// that tells a real Pi to stay off the network at start-up: no version check,
// no telemetry, no fetching. Nothing else in the lab would notice them going
// missing, so they are pinned here.
import { describe, expect, it } from 'vitest'
import { piEnv } from '../shim.ts'

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
})
