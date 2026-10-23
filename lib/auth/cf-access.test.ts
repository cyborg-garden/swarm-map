import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  accessConfigFromEnv,
  isCloudflareEdgeRequest,
  verifyAccessJwt,
  __resetAccessJwksCache,
  type AccessConfig,
} from './cf-access'

const TEAM = 'testteam.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD }
const NOW = 1_800_000_000

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let goodKey: CryptoKeyPair
let otherKey: CryptoKeyPair
let goodJwk: JsonWebKey

async function genKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
}

async function sign(
  payload: Record<string, unknown>,
  opts: { key?: CryptoKey; kid?: string; alg?: string } = {},
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? goodKey.privateKey, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 300, iat: NOW, email: 'op@example.com', ...over }
}

const fetchMock = vi.fn()

beforeAll(async () => {
  goodKey = await genKey()
  otherKey = await genKey()
  goodJwk = await crypto.subtle.exportKey('jwk', goodKey.publicKey)
})

beforeEach(() => {
  __resetAccessJwksCache()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`)
    return new Response(JSON.stringify({ keys: [{ ...goodJwk, kid: 'k1', use: 'sig' }] }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('accessConfigFromEnv', () => {
  it('off when neither var is set', () => {
    expect(accessConfigFromEnv({})).toEqual({ state: 'off' })
  })
  it('misconfigured when only one is set (fail closed, never silently off)', () => {
    expect(accessConfigFromEnv({ CF_ACCESS_AUD: AUD }).state).toBe('misconfigured')
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: TEAM }).state).toBe('misconfigured')
  })
  it('normalises scheme, trailing slash and case', () => {
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: 'https://TestTeam.cloudflareaccess.com/', CF_ACCESS_AUD: AUD }))
      .toEqual({ state: 'on', config: { teamDomain: TEAM, aud: AUD } })
  })
  it('rejects a team domain that is not a bare hostname', () => {
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: 'evil.com/x?y', CF_ACCESS_AUD: AUD }).state).toBe('misconfigured')
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: 'op@example.com', CF_ACCESS_AUD: AUD }).state).toBe('misconfigured')
  })
})

describe('isCloudflareEdgeRequest', () => {
  it('true for any Cloudflare edge marker', () => {
    for (const h of ['cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion', 'cf-access-authenticated-user-email']) {
      expect(isCloudflareEdgeRequest(new Headers({ [h]: 'x' }))).toBe(true)
    }
  })
  it('false for a plain on-host request', () => {
    expect(isCloudflareEdgeRequest(new Headers({ host: 'host.docker.internal:3000' }))).toBe(false)
  })
})

describe('verifyAccessJwt', () => {
  it('accepts a valid token and returns the email', async () => {
    const v = await verifyAccessJwt(await sign(claims()), CONFIG, NOW)
    expect(v).toEqual({ ok: true, email: 'op@example.com' })
  })
  it('accepts a string aud', async () => {
    expect((await verifyAccessJwt(await sign(claims({ aud: AUD })), CONFIG, NOW)).ok).toBe(true)
  })
  it('rejects a missing token', async () => {
    expect(await verifyAccessJwt(undefined, CONFIG, NOW)).toEqual({ ok: false, reason: 'missing token' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects a signature from another key', async () => {
    const v = await verifyAccessJwt(await sign(claims(), { key: otherKey.privateKey }), CONFIG, NOW)
    expect(v).toEqual({ ok: false, reason: 'bad signature' })
  })
  it('rejects a tampered payload', async () => {
    const [h, , s] = (await sign(claims())).split('.')
    const forged = `${h}.${b64url(JSON.stringify(claims({ email: 'attacker@example.com' })))}.${s}`
    expect((await verifyAccessJwt(forged, CONFIG, NOW)).ok).toBe(false)
  })
  it('rejects alg none and HS256 without fetching keys', async () => {
    for (const alg of ['none', 'HS256']) {
      const v = await verifyAccessJwt(await sign(claims(), { alg }), CONFIG, NOW)
      expect(v).toEqual({ ok: false, reason: 'unexpected alg' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects the wrong audience', async () => {
    expect(await verifyAccessJwt(await sign(claims({ aud: ['other-app'] })), CONFIG, NOW)).toEqual({ ok: false, reason: 'wrong audience' })
  })
  it('rejects the wrong issuer', async () => {
    expect(await verifyAccessJwt(await sign(claims({ iss: 'https://evil.cloudflareaccess.com' })), CONFIG, NOW)).toEqual({ ok: false, reason: 'wrong issuer' })
  })
  it('rejects an expired token (beyond leeway) and a missing exp', async () => {
    expect(await verifyAccessJwt(await sign(claims({ exp: NOW - 61 })), CONFIG, NOW)).toEqual({ ok: false, reason: 'expired' })
    const noExp = claims(); delete noExp.exp
    expect(await verifyAccessJwt(await sign(noExp), CONFIG, NOW)).toEqual({ ok: false, reason: 'missing exp' })
  })
  it('rejects a not-yet-valid token', async () => {
    expect(await verifyAccessJwt(await sign(claims({ nbf: NOW + 600 })), CONFIG, NOW)).toEqual({ ok: false, reason: 'not yet valid' })
  })
  it('rejects malformed tokens without throwing', async () => {
    for (const t of ['abc', 'a.b', 'a.b.c.d', '!!.!!.!!', `${b64url('[]')}.${b64url('{}')}.x`]) {
      expect((await verifyAccessJwt(t, CONFIG, NOW)).ok).toBe(false)
    }
  })
  it('fails closed when the JWKS cannot be fetched', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }))
    expect(await verifyAccessJwt(await sign(claims()), CONFIG, NOW)).toEqual({ ok: false, reason: 'jwks unavailable' })
  })
  it('backs off after a failed fetch: a burst of requests makes one call', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }))
    const tok = await sign(claims())
    await Promise.all(Array.from({ length: 20 }, () => verifyAccessJwt(tok, CONFIG, NOW)))
    for (let i = 0; i < 20; i++) await verifyAccessJwt(tok, CONFIG, NOW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('keeps using known keys when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await verifyAccessJwt(await sign(claims()), CONFIG, NOW) // warm cache
      vi.setSystemTime(Date.now() + 11 * 60 * 1000) // past the TTL
      fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }))
      expect((await verifyAccessJwt(await sign(claims()), CONFIG, NOW)).ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('retries after the backoff expires (no permanent lockout)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 500 }))
      const tok = await sign(claims())
      expect((await verifyAccessJwt(tok, CONFIG, NOW)).ok).toBe(false)
      vi.setSystemTime(Date.now() + 31 * 1000)
      expect((await verifyAccessJwt(tok, CONFIG, NOW)).ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
  it('an empty key set does not evict known keys', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await verifyAccessJwt(await sign(claims()), CONFIG, NOW) // warm cache
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ keys: [] })))
      expect((await verifyAccessJwt(await sign(claims()), CONFIG, NOW)).ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('caches the JWKS across requests', async () => {
    await verifyAccessJwt(await sign(claims()), CONFIG, NOW)
    await verifyAccessJwt(await sign(claims()), CONFIG, NOW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('refreshes once for an unknown kid, then rate-limits further refreshes', async () => {
    await verifyAccessJwt(await sign(claims()), CONFIG, NOW) // warm cache
    expect(await verifyAccessJwt(await sign(claims(), { kid: 'nope' }), CONFIG, NOW)).toEqual({ ok: false, reason: 'unknown kid' })
    expect(await verifyAccessJwt(await sign(claims(), { kid: 'nope2' }), CONFIG, NOW)).toEqual({ ok: false, reason: 'unknown kid' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
