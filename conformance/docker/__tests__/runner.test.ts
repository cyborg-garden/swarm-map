// @vitest-environment node
//
// What the runner may remove. It needs no Docker: the lists Docker would print
// are handed in.
import { describe, expect, it } from 'vitest'
import { ownedNames, parseLedger, strayRunNames } from '../runner.ts'

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

  it('[U:lab-objects] also finds the one-off containers a run starts outside any rig, by their exact names', () => {
    expect(strayRunNames([
      'smlab-deadbeef-lookup', 'smlab-0badf00d-version', 'smlab-12345678-refuse',
      'smlab-deadbeef-cell-1', 'smlab-deadbeef-lookup-2', 'xsmlab-deadbeef-lookup', 'smlab-DEADBEEF-lookup', 'smlab-lookup', 'some-postgres', '',
    ])).toEqual(['smlab-deadbeef-lookup', 'smlab-0badf00d-version', 'smlab-12345678-refuse'])
  })

  it('[U:lab-objects] under another prefix, only that prefix is its own', () => {
    expect(ownedNames(['smlabv-deadbeef-cell-1 smlabv-deadbeef', 'smlab-deadbeef-cell-1 smlab-deadbeef'], 'smlabv')).toEqual(['smlabv-deadbeef-cell-1'])
    expect(ownedNames(['smlabv-deadbeef-cell-1 smlabv-deadbeef', 'smlab-deadbeef-cell-1 smlab-deadbeef'])).toEqual(['smlab-deadbeef-cell-1'])
    expect(strayRunNames(['smlabv-deadbeef-lookup', 'smlab-deadbeef-lookup', 'smlabv-deadbeef-source'], 'smlabv')).toEqual(['smlabv-deadbeef-lookup', 'smlabv-deadbeef-source'])
  })
})

describe('what cleaning up may touch is what this worktree wrote down', () => {
  it('[U:lab-ledger] reads the runs and the images it recorded', () => {
    expect(parseLedger('run smlab 0123456789abcdef\nimage smlab-cell:pi-1.5.2-0123456789ab\nimage smlab-rig:0123456789ab\nrun mylab fedcba9876543210\n')).toEqual({
      runs: [{ prefix: 'smlab', id: '0123456789abcdef' }, { prefix: 'mylab', id: 'fedcba9876543210' }],
      images: ['smlab-cell:pi-1.5.2-0123456789ab', 'smlab-rig:0123456789ab'],
    })
    expect(parseLedger('run smlab 0123456789abcdef\nrun smlab 0123456789abcdef\n').runs).toEqual([{ prefix: 'smlab', id: '0123456789abcdef' }])
    expect(parseLedger('')).toEqual({ runs: [], images: [] })
  })

  it('[U:lab-ledger] drops any line that is not a run id or a per-source lab image, so nothing else can be named for removal', () => {
    expect(parseLedger([
      'run smlab short', 'run smlab 0123456789ABCDEF', 'run smlab 0123456789abcdef extra', 'run 0123456789abcdef', 'run', 'prune',
      'run sm-lab 0123456789abcdef', 'run * 0123456789abcdef', 'run Smlab 0123456789abcdef',
      // The images every worktree used to share, and images that are not the lab's.
      'image smlab-cell:pi-1.5.2', 'image smlab-rig:local', 'image postgres:15', 'image smlab-rig:0123456789ab --force', 'image smlab-rig', 'image -a',
      'image smlab-other:0123456789ab', 'image registry.example/smlab-rig:0123456789ab',
    ].join('\n'))).toEqual({ runs: [], images: [] })
  })
})
