// @vitest-environment node
//
// A kept scratch folder: read out of the cell as a tar stream, kept as it is, and unpacked again only
// inside the next cell, by the cell's own user, into the capped folder. This machine never unpacks it.
import { describe, expect, it } from 'vitest'
import { keptScratchMaxBytes, KEPT_SCRATCH_FILE, scratchRestoreArgs, SCRATCH_DIR, scratchSaveArgs } from '../cell.ts'

describe('a kept scratch folder', () => {
  it('[U:kept-scratch] is read and put back by the cell\'s own user, inside the cell, in the scratch folder only', () => {
    expect(scratchSaveArgs('smlab-0a1b2c3d')).toEqual(['exec', '-u', 'node', 'smlab-0a1b2c3d-cell-1', 'tar', '-c', '-C', SCRATCH_DIR, '.'])
    expect(scratchRestoreArgs('smlab-0a1b2c3d')).toEqual(['exec', '-i', '-u', 'node', 'smlab-0a1b2c3d-cell-1', 'tar', '-x', '--no-same-owner', '--no-same-permissions', '-C', SCRATCH_DIR])
    expect(SCRATCH_DIR).toBe('/tmp/smlab/work')
  })
  it('[U:kept-scratch] names only a lab cell, and keeps no more than the folder can hold', () => {
    expect(() => scratchSaveArgs('prod')).toThrow(/REFUSING TO RUN: F5/)
    expect(() => scratchRestoreArgs('smlab-0a1b2c3d; rm -rf /')).toThrow(/REFUSING TO RUN: F5/)
    expect(keptScratchMaxBytes(64)).toBe(65 * 1024 * 1024)
    expect(KEPT_SCRATCH_FILE).toBe('scratch.tar')
  })
})
