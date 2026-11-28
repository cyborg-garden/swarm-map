/**
 * Cloudflare Access JWT verification at the origin.
 *
 * WHY: hsm.<domain> is published through a Cloudflare Tunnel with an Access
 * policy in front. Access is enforced at Cloudflare's edge only; if the policy
 * is deleted, narrowed to the wrong path, or the hostname is re-pointed, the
 * tunnel keeps forwarding and HSM would serve whoever arrives. Cloudflare's
 * guidance is to also validate the signed `Cf-Access-Jwt-Assertion` header at
 * the origin. This module does that with Web Crypto only (no dependency), so it
 * runs in the Next.js proxy runtime.
 *
 * SCOPE: only requests that came through Cloudflare are checked (see
 * isCloudflareEdgeRequest). Requests made directly on the host — agent
 * containers via host.docker.internal, host-side gates — never carry a JWT and
 * keep the existing operator-session gate. HSM listens on loopback by default,
 * so "direct" means "on this machine".
 *
 * CONFIG: CF_ACCESS_TEAM_DOMAIN (e.g. yourteam.cloudflareaccess.com) and
 * CF_ACCESS_AUD (the Access application's audience tag). Both unset = feature
 * off. Exactly one set = misconfigured, and edge requests are refused (fail
 * closed) rather than served unchecked.
 */

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'

/** Clock skew tolerated on exp/nbf, in seconds. */
const LEEWAY_S = 60
/** How long a fetched JWKS is trusted before a refresh. */
const JWKS_TTL_MS = 10 * 60 * 1000
/** Minimum gap between forced refreshes triggered by an unknown kid. */
const JWKS_FORCED_REFRESH_GAP_MS = 30 * 1000
/** Upper bound on a JWKS fetch; the proxy must not hang on Cloudflare. */
const JWKS_FETCH_TIMEOUT_MS = 5000

export interface AccessConfig {
  teamDomain: string
  aud: string
}

export type AccessConfigResult =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; config: AccessConfig }

const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/** Read and validate the Access config from the environment. */
export function accessConfigFromEnv(env: Record<string, string | undefined> = process.env): AccessConfigResult {
  const rawTeam = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim()
  const aud = (env.CF_ACCESS_AUD ?? '').trim()
  if (!rawTeam && !aud) return { state: 'off' }
  if (!rawTeam || !aud) {
    return { state: 'misconfigured', reason: 'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must both be set' }
  }
  const teamDomain = rawTeam.replace(/^https:\/\//i, '').replace(/\/+$/, '').toLowerCase()
  if (!TEAM_DOMAIN_RE.test(teamDomain)) {
    return { state: 'misconfigured', reason: 'CF_ACCESS_TEAM_DOMAIN is not a hostname' }
  }
  return { state: 'on', config: { teamDomain, aud } }
}

/**
 * True when the request arrived through Cloudflare's edge. Cloudflare sets
 * Cf-Ray and Cf-Connecting-Ip on every proxied request and cloudflared
 * forwards them, so their presence is the tunnel's fingerprint. A local caller
 * can add these headers too, but that only subjects it to the stricter check;
 * it can never remove the headers from a real edge request.
 */
export function isCloudflareEdgeRequest(headers: Headers): boolean {
  return (
    headers.has('cf-ray') ||
    headers.has('cf-connecting-ip') ||
    headers.has(ACCESS_JWT_HEADER) ||
    headers.has('cf-access-authenticated-user-email')
  )
}

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  n?: string
  e?: string
  use?: string
}

interface JwksCacheEntry {
  keys: Map<string, CryptoKey>
  fetchedAt: number
}

const jwksCache = new Map<string, JwksCacheEntry>()
const lastForcedRefresh = new Map<string, number>()
/** One shared fetch per team domain, so a burst of requests makes one call. */
const inflight = new Map<string, Promise<Map<string, CryptoKey>>>()
/** When the last fetch failed; no new fetch until the backoff passes. */
const lastFailure = new Map<string, number>()
/** Wait this long after a failed JWKS fetch before trying again. */
const JWKS_FAILURE_BACKOFF_MS = 30 * 1000

/** Test hook: drop cached keys so each test controls the JWKS it sees. */
export function __resetAccessJwksCache(): void {
  jwksCache.clear()
  lastForcedRefresh.clear()
  inflight.clear()
  lastFailure.clear()
}

async function fetchJwks(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    cache: 'no-store',
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue
    if (jwk.use && jwk.use !== 'sig') continue
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      keys.set(jwk.kid, key)
    } catch {
      // A malformed key is skipped, not fatal: the other keys still verify.
    }
  }
  return keys
}

/**
 * Refresh the cached keys. Concurrent callers share one fetch. After a failure,
 * further fetches wait out a backoff, and the previous keys (if any) stay in
 * use, so an outage at Cloudflare neither floods it nor locks out tokens
 * signed by keys we already trust. Throws only when there are no keys at all.
 */
async function refresh(teamDomain: string): Promise<JwksCacheEntry> {
  const now = Date.now()
  const stale = jwksCache.get(teamDomain)
  const failedAt = lastFailure.get(teamDomain)
  if (failedAt !== undefined && now - failedAt < JWKS_FAILURE_BACKOFF_MS) {
    if (stale) return stale
    throw new Error('JWKS fetch backing off after a failure')
  }
  let p = inflight.get(teamDomain)
  if (!p) {
    p = fetchJwks(teamDomain).finally(() => inflight.delete(teamDomain))
    inflight.set(teamDomain, p)
  }
  try {
    const keys = await p
    // An empty set is treated as a failure: it would otherwise evict keys we
    // already trust and lock everyone out until the next refresh.
    if (keys.size === 0) throw new Error('JWKS contained no usable keys')
    const entry = { keys, fetchedAt: Date.now() }
    jwksCache.set(teamDomain, entry)
    lastFailure.delete(teamDomain)
    return entry
  } catch (err) {
    lastFailure.set(teamDomain, Date.now())
    if (stale) return stale
    throw err
  }
}

async function keyForKid(teamDomain: string, kid: string): Promise<CryptoKey | undefined> {
  let entry = jwksCache.get(teamDomain)
  if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) {
    entry = await refresh(teamDomain)
  }
  const hit = entry.keys.get(kid)
  if (hit) return hit
  // Unknown kid: Cloudflare may have rotated. Refresh at most once per gap so a
  // stream of junk kids cannot turn every request into a JWKS fetch.
  const now = Date.now()
  const last = lastForcedRefresh.get(teamDomain) ?? 0
  if (now - last < JWKS_FORCED_REFRESH_GAP_MS) return undefined
  lastForcedRefresh.set(teamDomain, now)
  entry = await refresh(teamDomain)
  return entry.keys.get(kid)
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url')
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 0 ? '' : null
  if (pad === null) throw new Error('bad base64url length')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJsonSegment(s: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('segment is not an object')
  return parsed as Record<string, unknown>
}

export type AccessVerdict =
  | { ok: true; email?: string }
  | { ok: false; reason: string }

/**
 * Verify a Cloudflare Access JWT: RS256 signature against the team's JWKS,
 * issuer, audience, expiry and not-before. Never throws; any failure is a
 * rejection with a short reason suitable for logs (never echo it to clients).
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<AccessVerdict> {
  if (!token) return { ok: false, reason: 'missing token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' }
  const [h, p, sig] = parts

  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = decodeJsonSegment(h)
    payload = decodeJsonSegment(p)
  } catch {
    return { ok: false, reason: 'undecodable token' }
  }

  // Pin the algorithm: never let the token choose (alg=none, HS256 with the
  // public key as secret, etc.).
  if (header.alg !== 'RS256') return { ok: false, reason: 'unexpected alg' }
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'missing kid' }

  let key: CryptoKey | undefined
  try {
    key = await keyForKid(config.teamDomain, header.kid)
  } catch {
    return { ok: false, reason: 'jwks unavailable' }
  }
  if (!key) return { ok: false, reason: 'unknown kid' }

  let valid = false
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    )
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'bad signature' }

  if (payload.iss !== `https://${config.teamDomain}`) return { ok: false, reason: 'wrong issuer' }
  const aud = payload.aud
  const auds = Array.isArray(aud) ? aud : [aud]
  if (!auds.includes(config.aud)) return { ok: false, reason: 'wrong audience' }
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'missing exp' }
  if (payload.exp + LEEWAY_S < nowS) return { ok: false, reason: 'expired' }
  if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > nowS) return { ok: false, reason: 'not yet valid' }

  return { ok: true, email: typeof payload.email === 'string' ? payload.email : undefined }
}
