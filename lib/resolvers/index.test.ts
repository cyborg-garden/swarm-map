// @vitest-environment node
/**
 * Tests for expandSignalAllowlist, resolveTelegramAdmins, expandTelegramAllowlist.
 *
 * Sealed-sender Signal DMs identify the sender only by UUID, never phone number.
 * The gateway compares that inbound UUID against SIGNAL_ALLOWED_USERS verbatim,
 * so a phone-number-only allowlist silently rejects the very person it names.
 * expandSignalAllowlist resolves each phone to its UUID and stores BOTH forms.
 *
 * Telegram has the analogous failure: the gateway matches numeric sender IDs
 * against TELEGRAM_ALLOWED_USERS verbatim, so a raw @username never matches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./signal', () => ({
  resolveSignalPhone: vi.fn(),
  getSignalAccountUuid: vi.fn(),
}))
vi.mock('./telegram', () => ({
  resolveTelegramUsername: vi.fn(),
  getTelegramDisplayName: vi.fn(),
}))
vi.mock('./mattermost', () => ({
  resolveMattermostUsername: vi.fn(),
}))
vi.mock('./discord', () => ({
  resolveDiscordUsername: vi.fn(),
  expandDiscordAllowlist: vi.fn(),
}))

import { expandSignalAllowlist, resolveTelegramAdmins, expandTelegramAllowlist, resolveIdentifier } from './index'
import { resolveSignalPhone } from './signal'
import { resolveTelegramUsername } from './telegram'
import { resolveMattermostUsername } from './mattermost'
import { resolveDiscordUsername } from './discord'
import { SURFACES } from '@/lib/surfaces/registry'

const mockResolve = vi.mocked(resolveSignalPhone)
const mockTgResolve = vi.mocked(resolveTelegramUsername)
const mockMmResolve = vi.mocked(resolveMattermostUsername)
const mockDcResolve = vi.mocked(resolveDiscordUsername)

describe('expandSignalAllowlist', () => {
  beforeEach(() => vi.clearAllMocks())

  it('expands a phone-number entry to include its resolved UUID', async () => {
    mockResolve.mockResolvedValue({
      display: '+15550001234',
      nativeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })

    const result = await expandSignalAllowlist('h_harbor', ['+15550001234'])

    expect(result).toEqual([
      '+15550001234',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ])
  })

  it('passes a UUID entry through without resolving', async () => {
    const result = await expandSignalAllowlist('h_harbor', [
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ])

    expect(result).toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'])
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('passes the "*" wildcard through untouched', async () => {
    const result = await expandSignalAllowlist('h_harbor', ['*'])

    expect(result).toEqual(['*'])
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('keeps the phone number when resolution fails', async () => {
    mockResolve.mockResolvedValue(null)

    const result = await expandSignalAllowlist('h_harbor', ['+15550001234'])

    expect(result).toEqual(['+15550001234'])
  })

  it('does not duplicate a UUID already present in the list', async () => {
    mockResolve.mockResolvedValue({
      display: '+15550001234',
      nativeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })

    const result = await expandSignalAllowlist('h_harbor', [
      '+15550001234',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ])

    expect(result).toEqual([
      '+15550001234',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ])
  })
})

describe('resolveTelegramAdmins (strict — connect path)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes numeric IDs through without resolving', async () => {
    const result = await resolveTelegramAdmins('h_x', ['123456789', '-1001234'])
    expect(result).toEqual({
      ok: true,
      ids: ['123456789', '-1001234'],
      resolved: [
        { display: '123456789', nativeId: '123456789' },
        { display: '-1001234', nativeId: '-1001234' },
      ],
    })
    expect(mockTgResolve).not.toHaveBeenCalled()
  })

  it('resolves @usernames to numeric IDs, passing the explicit bot token through', async () => {
    mockTgResolve.mockResolvedValue({ display: '@operator', nativeId: '424242', profileName: 'Operator' })
    const result = await resolveTelegramAdmins('h_x', ['111', ' @operator '], 'tok:abc')
    expect(result).toEqual({
      ok: true,
      ids: ['111', '424242'],
      resolved: [
        { display: '111', nativeId: '111' },
        { display: '@operator', nativeId: '424242', profileName: 'Operator' },
      ],
    })
    expect(mockTgResolve).toHaveBeenCalledWith('h_x', '@operator', 'tok:abc')
  })

  it('fails (never stores the raw handle) when a handle does not resolve', async () => {
    mockTgResolve.mockResolvedValue(null)
    const result = await resolveTelegramAdmins('h_x', ['@ghost'], 'tok:abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('@ghost')
  })

  it('rejects the wildcard as an admin entry', async () => {
    const result = await resolveTelegramAdmins('h_x', ['*'])
    expect(result.ok).toBe(false)
  })

  it('dedupes entries that resolve to the same numeric ID and skips blanks', async () => {
    mockTgResolve.mockResolvedValue({ display: '@dup', nativeId: '999' })
    const result = await resolveTelegramAdmins('h_x', ['999', '@dup', '', ' '])
    expect(result).toMatchObject({ ok: true, ids: ['999'] })
  })
})

describe('expandTelegramAllowlist (best-effort — settings path)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('expands an @username entry to include its resolved numeric ID', async () => {
    mockTgResolve.mockResolvedValue({ display: '@operator', nativeId: '424242' })
    expect(await expandTelegramAllowlist('h_x', ['@operator'])).toEqual(['@operator', '424242'])
  })

  it('passes numeric IDs and the "*" wildcard through without resolving', async () => {
    expect(await expandTelegramAllowlist('h_x', ['123', '*', '-100999'])).toEqual(['123', '*', '-100999'])
    expect(mockTgResolve).not.toHaveBeenCalled()
  })

  it('keeps the handle unchanged when resolution fails (no worse than before)', async () => {
    mockTgResolve.mockResolvedValue(null)
    expect(await expandTelegramAllowlist('h_x', ['@ghost'])).toEqual(['@ghost'])
  })

  it('does not duplicate an ID already present in the list', async () => {
    mockTgResolve.mockResolvedValue({ display: '@operator', nativeId: '424242' })
    expect(await expandTelegramAllowlist('h_x', ['@operator', '424242'])).toEqual(['@operator', '424242'])
  })

  it('sends an over-long numeric (21 digits — outside the canonical bound) to resolution, keeping it raw on failure', async () => {
    // Unified onto registry.identity.nativePattern: the old inline /^-?\d+$/
    // was unbounded and passed this through as if it were a native id.
    const tooLong = '1'.repeat(21)
    expect(SURFACES.telegram.identity.nativePattern.test(tooLong)).toBe(false)
    mockTgResolve.mockResolvedValue(null)
    expect(await expandTelegramAllowlist('h_x', [tooLong])).toEqual([tooLong])
    expect(mockTgResolve).toHaveBeenCalledWith('h_x', tooLong)
  })
})

// ── resolveIdentifier: every "already native — skip" check sources the
// registry's canonical nativePattern (drift D8, unified). These pin each
// platform's skip behavior AGAINST the registry pattern itself, so the two
// cannot diverge again without failing here.

describe('resolveIdentifier — native-id skips agree with registry.identity.nativePattern', () => {
  beforeEach(() => vi.clearAllMocks())

  it('discord: a canonical snowflake skips resolution', async () => {
    const snowflake = '123456789012345678'
    expect(SURFACES.discord.identity.nativePattern.test(snowflake)).toBe(true)
    expect(await resolveIdentifier('h_x', 'discord', snowflake)).toEqual({
      display: snowflake,
      nativeId: snowflake,
    })
    expect(mockDcResolve).not.toHaveBeenCalled()
  })

  it('discord: a 5-digit value is NOT a native id — it goes to resolution', async () => {
    // Load-bearing tightening case: the legacy loose bound (5–25 in the old
    // isValidIdentity switch) would have called this a snowflake.
    expect(SURFACES.discord.identity.nativePattern.test('12345')).toBe(false)
    mockDcResolve.mockResolvedValue(null)
    expect(await resolveIdentifier('h_x', 'discord', '12345')).toBeNull()
    expect(mockDcResolve).toHaveBeenCalledWith('h_x', '12345')
  })

  it('telegram: canonical numerics skip; a 21-digit numeric resolves instead', async () => {
    expect(await resolveIdentifier('h_x', 'telegram', '-1001234567')).toEqual({
      display: '-1001234567',
      nativeId: '-1001234567',
    })
    expect(mockTgResolve).not.toHaveBeenCalled()
    mockTgResolve.mockResolvedValue(null)
    const tooLong = '1'.repeat(21)
    expect(await resolveIdentifier('h_x', 'telegram', tooLong)).toBeNull()
    expect(mockTgResolve).toHaveBeenCalledWith('h_x', tooLong)
  })

  it('mattermost: a 26-char id skips; anything else resolves', async () => {
    const mmId = 'abcdefghijklmnopqrstuvwxyz'
    expect(SURFACES.mattermost.identity.nativePattern.test(mmId)).toBe(true)
    expect(await resolveIdentifier('h_x', 'mattermost', mmId)).toEqual({
      display: mmId,
      nativeId: mmId,
    })
    expect(mockMmResolve).not.toHaveBeenCalled()
    mockMmResolve.mockResolvedValue(null)
    await resolveIdentifier('h_x', 'mattermost', 'operator')
    expect(mockMmResolve).toHaveBeenCalledWith('h_x', 'operator')
  })

  it('signal: a full canonical UUID skips (any case); a phone still resolves', async () => {
    // Phones match the canonical pattern too (they ARE native ids), but only
    // the UUID form may skip — a phone entry still resolves so its
    // sealed-sender UUID can be stored alongside (see isSignalUuid).
    const upper = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'
    expect(SURFACES.signal.identity.nativePattern.test(upper)).toBe(true)
    expect(await resolveIdentifier('h_x', 'signal', upper)).toEqual({
      display: upper,
      nativeId: upper,
    })
    expect(mockResolve).not.toHaveBeenCalled()
    expect(SURFACES.signal.identity.nativePattern.test('+15550001234')).toBe(true)
    mockResolve.mockResolvedValue({ display: '+15550001234', nativeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    expect(await resolveIdentifier('h_x', 'signal', '+15550001234')).toEqual({
      display: '+15550001234',
      nativeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })
  })

  it('unknown platform returns null', async () => {
    expect(await resolveIdentifier('h_x', 'whatsapp', '12345')).toBeNull()
  })
})
