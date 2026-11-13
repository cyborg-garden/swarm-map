import '@testing-library/jest-dom/vitest'
import { afterAll } from 'vitest'

// Tests must never read this machine's real Swarm Map state. Several
// services find harnesses.json through DATA_DIR (lib/services/data-dir.ts),
// which falls back to ~/.hermes-swarm-map: on a machine that runs Swarm Map
// that is the live fleet's file. Point it at an empty scratch directory
// unless a test file has chosen its own (in vi.hoisted, which runs later).
import fs from 'fs'
import os from 'os'
import path from 'path'

if (!process.env.DATA_DIR) {
  const scratchDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-test-data-'))
  process.env.DATA_DIR = scratchDataDir
  // One scratch dir per test file, removed when that file is done. (An exit
  // hook would not do: vitest's workers are stopped without one.)
  afterAll(() => fs.rmSync(scratchDataDir, { recursive: true, force: true }))
}
