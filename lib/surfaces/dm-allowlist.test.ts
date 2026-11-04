// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  DISCORD_DM_USERS_VAR,
  SIGNAL_DENY_ALL_USERS,
  discordDmAfterAdminSet,
  discordDmRefusedAdmins,
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

describe('discordDmAfterAdminSet', () => {
  const NO_EXPLICIT = undefined

  it('follows an admin change when the DM list equalled the previous admins', () => {
    expect(discordDmAfterAdminSet(A, [A], [A, B], A)).toEqual({ action: 'write', value: `${A},${B}` })
    expect(discordDmAfterAdminSet(`${B},${A}`, [A, B], [C], A)).toEqual({ action: 'write', value: C })
    expect(discordDmAfterAdminSet(A, [A], [], A)).toEqual({ action: 'write', value: '' })
  })
  it('a chosen first list that differs from the allowlist opens a closed agent', () => {
    expect(discordDmAfterAdminSet(undefined, NO_EXPLICIT, [A], `${A},${B}`)).toEqual({ action: 'write', value: A })
    expect(discordDmAfterAdminSet('', NO_EXPLICIT, [A], `${A},${B}`)).toEqual({ action: 'write', value: A })
  })
  it('a first list that matches the allowlist (GET sent back) does not open it, in any order', () => {
    expect(discordDmAfterAdminSet('', NO_EXPLICIT, [B, A], `${A},${B}`)).toEqual({ action: 'left', reason: 'matches-allowlist' })
    expect(discordDmAfterAdminSet(undefined, NO_EXPLICIT, [A], A)).toEqual({ action: 'left', reason: 'matches-allowlist' })
  })
  it('a usernames entry on the allowlist does not hide the match', () => {
    expect(discordDmAfterAdminSet('', NO_EXPLICIT, [A], `somebody,${A}`)).toEqual({ action: 'left', reason: 'matches-allowlist' })
  })
  it('does nothing when the list already matches, in any order', () => {
    expect(discordDmAfterAdminSet(`${B},${A}`, [C], [A, B], A)).toEqual({ action: 'none' })
    expect(discordDmAfterAdminSet(A, NO_EXPLICIT, [A], A)).toEqual({ action: 'none' })
    expect(discordDmAfterAdminSet('', NO_EXPLICIT, [], '')).toEqual({ action: 'none' })
  })
  it('saving the same admins does not widen a list that differs', () => {
    expect(discordDmAfterAdminSet(A, [A, B], [A, B], `${A},${B}`)).toEqual({ action: 'left', reason: 'differs' })
  })
  it('a first admin list does not drop or add to a hand-set list', () => {
    expect(discordDmAfterAdminSet(A, NO_EXPLICIT, [B], C)).toEqual({ action: 'left', reason: 'differs' })
    expect(discordDmAfterAdminSet(A, NO_EXPLICIT, [A, B], C)).toEqual({ action: 'left', reason: 'differs' })
    expect(discordDmAfterAdminSet(A, NO_EXPLICIT, [], C)).toEqual({ action: 'left', reason: 'differs' })
  })
  it('a closed list stays closed once an admin list already exists', () => {
    expect(discordDmAfterAdminSet('', [A], [A, B], A)).toEqual({ action: 'left', reason: 'differs' })
  })
  it('leaves a deliberate * alone', () => {
    expect(discordDmAfterAdminSet('*', NO_EXPLICIT, [A], C)).toEqual({ action: 'left', reason: 'differs' })
    expect(discordDmAfterAdminSet(`${A},*`, [A], [], A)).toEqual({ action: 'left', reason: 'differs' })
  })
})

describe('discordDmRefusedAdmins', () => {
  const env = (users: string, dm: string, extra = '') =>
    `DISCORD_ALLOWED_USERS=${users}\nDISCORD_DM_ALLOWED_USERS=${dm}\n${extra}`

  it('names a listed admin who is not on the allowlist', () => {
    expect(discordDmRefusedAdmins(env(A, `${A},${B}`), [A, B])).toEqual([B])
  })
  it('is empty when every listed admin passes', () => {
    expect(discordDmRefusedAdmins(env(`${A},${B}`, `${A},${B}`), [A, B])).toEqual([])
  })
  it('ignores an admin the DM list leaves out: they are not being refused by the allowlist', () => {
    expect(discordDmRefusedAdmins(env(A, A), [A, B])).toEqual([])
  })
  it('counts a * DM list as listing them', () => {
    expect(discordDmRefusedAdmins(env(A, '*'), [A, B])).toEqual([B])
  })
  it('is empty when everyone passes the allowlist', () => {
    expect(discordDmRefusedAdmins(env('*', A), [A])).toEqual([])
    expect(discordDmRefusedAdmins(env('', A, 'DISCORD_ALLOW_ALL_USERS=true\n'), [A])).toEqual([])
  })
})
