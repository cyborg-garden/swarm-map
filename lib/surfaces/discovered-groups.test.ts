import { describe, it, expect } from 'vitest'
import { addableDiscoveredGroups } from './discovered-groups'

const found = [
  { id: 'g1', name: 'One' },
  { id: 'g2', name: 'Two' },
]

describe('addableDiscoveredGroups', () => {
  it('hides groups already on the allowlist', () => {
    expect(addableDiscoveredGroups(found, { allowedGroups: ['g1'], allowAllGroups: false })).toEqual([found[1]])
  })

  it('offers nothing when every group is already allowed by "*"', () => {
    expect(addableDiscoveredGroups(found, { allowedGroups: [], allowAllGroups: true })).toEqual([])
  })

  it('offers all groups when the allowlist is empty and not "*"', () => {
    expect(addableDiscoveredGroups(found, { allowedGroups: [], allowAllGroups: false })).toEqual(found)
  })
})
