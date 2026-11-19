import { describe, it, expect } from 'vitest'
import { filterKeys } from '@/lib/keys-filter'
import type { Key } from '@/lib/types'

const keys: Key[] = [
  {
    id: 'k1',
    provider: 'anthropic',
    name: 'Team Key',
    maskedValue: 'sk-ant-...AB12',
    assignedTo: ['h1', 'h2'],
    health: 'good',
  },
  {
    id: 'k2',
    provider: 'openai',
    name: 'Personal',
    maskedValue: 'sk-...XY99',
    assignedTo: ['h3'],
    health: 'warning',
  },
  {
    id: 'k3',
    provider: 'google',
    maskedValue: 'AIza...ZZ00',
    assignedTo: [],
    health: 'expired',
  },
]

const harnessNames = (ids: string[]): string =>
  ids
    .map((id) => ({ h1: 'matilde', h2: 'wren', h3: 'hermes-prime' }[id] ?? id))
    .join(', ')

describe('filterKeys', () => {
  it('returns all keys for an empty query', () => {
    expect(filterKeys(keys, '')).toEqual(keys)
    expect(filterKeys(keys, '   ')).toEqual(keys)
  })

  it('returns [] when keys is null/undefined', () => {
    expect(filterKeys(null, 'anthropic')).toEqual([])
    expect(filterKeys(undefined, 'anthropic')).toEqual([])
  })

  it('matches on provider case-insensitively', () => {
    expect(filterKeys(keys, 'ANTHROPIC').map((k) => k.id)).toEqual(['k1'])
    expect(filterKeys(keys, 'openai').map((k) => k.id)).toEqual(['k2'])
  })

  it('matches on display name', () => {
    expect(filterKeys(keys, 'team').map((k) => k.id)).toEqual(['k1'])
    expect(filterKeys(keys, 'personal').map((k) => k.id)).toEqual(['k2'])
  })

  it('matches on masked value', () => {
    expect(filterKeys(keys, 'ab12').map((k) => k.id)).toEqual(['k1'])
    expect(filterKeys(keys, 'aiza').map((k) => k.id)).toEqual(['k3'])
  })

  it('matches on assigned-harness names via the resolver', () => {
    expect(filterKeys(keys, 'matilde', harnessNames).map((k) => k.id)).toEqual(['k1'])
    expect(filterKeys(keys, 'hermes', harnessNames).map((k) => k.id)).toEqual(['k2'])
  })

  it('falls back to raw harness ids when no resolver is given', () => {
    expect(filterKeys(keys, 'h3').map((k) => k.id)).toEqual(['k2'])
  })

  it('excludes non-matching keys', () => {
    expect(filterKeys(keys, 'nonexistent-substring')).toEqual([])
  })
})
