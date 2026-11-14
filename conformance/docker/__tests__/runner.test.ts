// @vitest-environment node
//
// What the runner may remove. It needs no Docker: the lists Docker would print
// are handed in.
import { describe, expect, it } from 'vitest'
import { ownedNames } from '../runner.ts'

describe('the lab only removes what is its own, by label and by name', () => {
  it('[U:lab-objects] keeps a name that carries its lab project as a prefix', () => {
    expect(ownedNames([
      'smlab-deadbeef-cell-1 smlab-deadbeef',
      'smlab-deadbeef_cell smlab-deadbeef',
      'smlab-deadbeef_lab smlab-deadbeef',
    ])).toEqual(['smlab-deadbeef-cell-1', 'smlab-deadbeef_cell', 'smlab-deadbeef_lab'])
  })

  it('[U:lab-objects] leaves alone anything with no lab label, a label that is not a lab project, or a name that is not the lab\'s', () => {
    expect(ownedNames([
      'some-postgres ',
      'some-postgres',
      'webapp-db-1 webapp',
      'smlab-deadbeef-cell-1 smlab-deadbeef-extra',
      'smlab-deadbeef-cell-1 SMLAB-DEADBEEF',
      // Labelled as a lab project, but not named for it: a label is a claim anyone can make.
      'some-postgres smlab-deadbeef',
      'smlab-0badf00d-cell-1 smlab-deadbeef',
      'smlab-deadbeefx smlab-deadbeef',
      '',
    ])).toEqual([])
  })
})
