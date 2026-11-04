// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  DISCORD_DM_USERS_VAR,
  SIGNAL_DENY_ALL_USERS,
  discordDmAfterAdminSet,
  discordDmAfterAllowlistEdit,
  setEnvLine,
  validIdentities,
} from './dm-allowlist'

const A = '100000000000000001'
const B = '100000000000000002'
const C = '100000000000000003'

describe('constants', () => {
  it('names the var the adapter reads, and a Signal deny value no sender can match', () => {
    expect(DISCORD_DM_USERS_VAR).toBe('DISCORD_DM_ALLOWED_USERS')
    expect(SIGNAL_DENY_ALL_USERS).toBe('0')
    expect(validIdentities('signal', [SIGNAL_DENY_ALL_USERS])).toEqual([])
  })
})

describe('validIdentities', () => {
  it('keeps native ids only: drops wildcards and usernames, trims, dedupes', () => {
    expect(validIdentities('discord', [A, ` ${A} `, '*', 'somebody', B])).toEqual([A, B])
  })
})

describe('setEnvLine', () => {
  it('appends a missing key', () => {
    expect(setEnvLine('X=1\n', 'K', 'v')).toBe('X=1\nK=v\n')
  })
  it('replaces every duplicate with one line, leaving the rest alone', () => {
    expect(setEnvLine('K=a\nX=1\nK=b\n', 'K', 'v')).toBe('K=v\nX=1\n')
  })
  it('keeps a CRLF line ending', () => {
    expect(setEnvLine('K=a\r\nX=1\r\n', 'K', 'v')).toBe('K=v\r\nX=1\r\n')
  })
  it('does not match a commented line or a longer key', () => {
    expect(setEnvLine('# K=a\nK_2=b\n', 'K', 'v')).toBe('# K=a\nK_2=b\nK=v\n')
  })
  it('refuses a value that would inject a line', () => {
    expect(() => setEnvLine('', 'K', 'a\nEVIL=1')).toThrow()
  })
})

describe('discordDmAfterAdminSet (an explicit admin change)', () => {
  it('sets the list to the admins', () => {
    expect(discordDmAfterAdminSet(A, [A, B])).toBe(`${A},${B}`)
  })
  it('closes DMs when the admins are cleared', () => {
    expect(discordDmAfterAdminSet(A, [])).toBe('')
  })
  it('opens a closed list for a named admin', () => {
    expect(discordDmAfterAdminSet(undefined, [A])).toBe(A)
    expect(discordDmAfterAdminSet('', [A])).toBe(A)
  })
  it('asks for no write when the set already matches, in any order', () => {
    expect(discordDmAfterAdminSet(`${B},${A}`, [A, B])).toBeNull()
  })
  it('leaves a deliberate * alone', () => {
    expect(discordDmAfterAdminSet('*', [A])).toBeNull()
    expect(discordDmAfterAdminSet(`${A},*`, [])).toBeNull()
  })
})

describe('discordDmAfterAllowlistEdit (allowlist edit while it doubles as the admin set)', () => {
  it('never writes on a save that did not change the allowlist', () => {
    expect(discordDmAfterAllowlistEdit('', A, A)).toBeNull()
    expect(discordDmAfterAllowlistEdit(A, `${A},${B}`, `${B},${A}`)).toBeNull()
    expect(discordDmAfterAllowlistEdit(undefined, '', '')).toBeNull()
  })
  it('follows the allowlist when the DM list matched it', () => {
    expect(discordDmAfterAllowlistEdit('', '', A)).toBe(A)
    expect(discordDmAfterAllowlistEdit(undefined, undefined, A)).toBe(A)
    expect(discordDmAfterAllowlistEdit(A, A, `${A},${B}`)).toBe(`${A},${B}`)
    expect(discordDmAfterAllowlistEdit(`${A},${B}`, `${B},${A}`, A)).toBe(A)
    expect(discordDmAfterAllowlistEdit(A, A, '')).toBe('')
  })
  it('does not widen a DM list hand-set narrower than the allowlist', () => {
    expect(discordDmAfterAllowlistEdit(A, `${A},${B}`, `${A},${B},${C}`)).toBeNull()
  })
  it('does not open an agent whose DMs are closed while it already has users', () => {
    expect(discordDmAfterAllowlistEdit('', A, `${A},${B}`)).toBeNull()
    expect(discordDmAfterAllowlistEdit(undefined, A, `${A},${B}`)).toBeNull()
  })
  it('never derives * and never touches an existing *', () => {
    expect(discordDmAfterAllowlistEdit(A, A, '*')).toBeNull()
    expect(discordDmAfterAllowlistEdit('*', A, B)).toBeNull()
  })
  it('never lists a username, which the DM gate could not match', () => {
    expect(discordDmAfterAllowlistEdit('', '', `somebody,${A}`)).toBe(A)
  })
})
