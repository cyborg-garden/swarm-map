// @vitest-environment node
import { describe, it, expect } from 'vitest'
import os from 'os'
import { DATA_DIR } from '@/lib/services/data-dir'

describe('where tests keep Swarm Map state', () => {
  it('DATA_DIR is a scratch directory, not the default under the home directory', () => {
    // vitest.setup.ts sets it. Code that reads harnesses.json through DATA_DIR
    // (the shared id step, the services singleton) must not depend on the
    // machine a test happens to run on.
    expect(DATA_DIR.startsWith(os.tmpdir())).toBe(true)
    expect(DATA_DIR).not.toContain('.hermes-swarm-map')
  })
})
