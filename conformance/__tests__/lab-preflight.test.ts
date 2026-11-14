// @vitest-environment node
//
// Negative controls for the preflight calls inside startLab(). The guard
// functions have their own tests (guards/__tests__/preflight.test.ts); these
// prove the lab actually calls them. A lab that is handed something unsafe
// must refuse before the harness is started, and leave nothing behind.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { fakePiCommand, piHarness } from '../harnesses/pi.ts'
import type { HarnessUnderTest } from '../suites/harness.ts'
import { startLab } from '../suites/lab.ts'

armTripwire()
afterEach(() => expect(tripwireAttempts()).toEqual([]))

/** The fake-Pi harness, with a record of whether the lab ever started it. */
function watched(over: Partial<HarnessUnderTest> = {}): { harness: HarnessUnderTest; started: string[] } {
  const real = piHarness(fakePiCommand(), 'fake')
  const started: string[] = []
  const harness: HarnessUnderTest = {
    ...real, ...over,
    start: (cell, variant) => { started.push(variant); return real.start(cell, variant) },
  }
  return { harness, started }
}

describe('startLab() runs its preflight', () => {
  it('positive control: a safe harness in a safe work dir starts', async () => {
    const { harness, started } = watched()
    const lab = await startLab({ harness, shim: 'good' })
    await lab.close()
    expect(started).toEqual(['good'])
  })

  it('[U:lab-preflight] F2: a harness about to be handed a chat token is never started', async () => {
    const real = piHarness(fakePiCommand(), 'fake')
    const { harness, started } = watched({
      cellEnv: (cell, variant) => ({ ...real.cellEnv(cell, variant), DISCORD_BOT_TOKEN: 'x' }),
    })
    await expect(startLab({ harness, shim: 'good' })).rejects.toThrow(/^REFUSING TO RUN: F2 .*DISCORD_BOT_TOKEN/)
    expect(started).toEqual([])
  })

  it('[U:lab-preflight] F2 covers a shim that is broken on purpose too', async () => {
    const real = piHarness(fakePiCommand(), 'fake')
    const { harness, started } = watched({
      cellEnv: (cell, variant) => ({ ...real.cellEnv(cell, variant), ...(variant === 'leaks-env' ? { GITHUB_TOKEN: 'x' } : {}) }),
    })
    await expect(startLab({ harness, shim: 'leaks-env' })).rejects.toThrow(/^REFUSING TO RUN: F2 .*GITHUB_TOKEN/)
    expect(started).toEqual([])
  })

  it('[U:lab-preflight] F5: a work dir inside an agent home is refused, and nothing is left there', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-preflight-'))
    const agentHome = path.join(root, '.hermes-someone')
    mkdirSync(agentHome)
    try {
      const { harness, started } = watched()
      await expect(startLab({ harness, shim: 'good', workRoot: agentHome })).rejects.toThrow(/^REFUSING TO RUN: F5 work dir is inside an agent home/)
      expect(started).toEqual([])
      expect(readdirSync(agentHome)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('[U:lab-preflight] F5: a work dir outside the temp dir is refused', async () => {
    // Under the repo, so it is certainly not under the temp dir; removed again whatever happens.
    const outside = mkdtempSync(path.join(import.meta.dirname, 'not-tmp-'))
    try {
      const { harness, started } = watched()
      await expect(startLab({ harness, shim: 'good', workRoot: outside })).rejects.toThrow(/^REFUSING TO RUN: F5 work dir is not under the temp dir/)
      expect(started).toEqual([])
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
