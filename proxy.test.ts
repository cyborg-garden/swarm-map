import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy, config as proxyConfig } from './proxy'
import { SESSION_COOKIE, computeSessionValue } from '@/lib/auth/session'

const TOKEN = 'super-secret-operator-token'

// Real runtime agent-read paths (verified against the swarm_map_policy plugin).
const AGENT_GROUPS = '/api/harnesses/h_1/surfaces/signal/groups/g_abc'
const AGENT_ADMIN = '/api/harnesses/h_1/surfaces/signal/admins/u_123'
const AGENT_POLICY = '/api/harnesses/h_1/policy'
// Gated reads (operator-only / sensitive).
const ADMIN_ROSTER = '/api/harnesses/h_1/surfaces/signal/admins' // no userId → roster
const PIN = '/api/surfaces/signal/pin?phone=%2B15550001111'

function req(path: string, method: string, cookie?: string): NextRequest {
  const headers = new Headers()
  if (cookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`)
  return new NextRequest(new URL(`http://localhost:3000${path}`), { method, headers })
}

/** NextResponse.next() carries the x-middleware-next marker; a block does not. */
function passedThrough(res: Response): boolean {
  return res.headers.get('x-middleware-next') === '1'
}

describe('proxy auth gate — token SET', () => {
  beforeEach(() => { process.env.HSM_OPERATOR_TOKEN = TOKEN })
  afterEach(() => { delete process.env.HSM_OPERATOR_TOKEN })

  // --- agent-read allowlist: ungated even with no cookie ---
  it('GET agent groups path (is_group_allowed) → passes ungated', async () => {
    expect(passedThrough(await proxy(req(AGENT_GROUPS, 'GET')))).toBe(true)
  })
  it('GET agent per-user admins path (is_platform_admin) → passes ungated', async () => {
    expect(passedThrough(await proxy(req(AGENT_ADMIN, 'GET')))).toBe(true)
  })
  it('GET agent policy path → passes ungated', async () => {
    expect(passedThrough(await proxy(req(AGENT_POLICY, 'GET')))).toBe(true)
  })
  it('GET /api/health/docker → passes ungated (pre-auth readiness probe)', async () => {
    expect(passedThrough(await proxy(req('/api/health/docker', 'GET')))).toBe(true)
  })

  // --- all other reads are gated (they can leak operator-sensitive data) ---
  it('GET /api/harnesses with no cookie → 401 (dashboard read, needs session)', async () => {
    const res = await proxy(req('/api/harnesses', 'GET'))
    expect(res.status).toBe(401)
  })
  it('GET decrypted signal PIN with no cookie → 401', async () => {
    expect((await proxy(req(PIN, 'GET'))).status).toBe(401)
  })
  it('GET /api/audit with no cookie → 401', async () => {
    expect((await proxy(req('/api/audit', 'GET'))).status).toBe(401)
  })
  it('GET admins ROSTER (no userId) with no cookie → 401 (distinct from the agent per-user path)', async () => {
    expect((await proxy(req(ADMIN_ROSTER, 'GET'))).status).toBe(401)
  })
  it('gated GET with a valid cookie → passes', async () => {
    const good = await computeSessionValue(TOKEN)
    expect(passedThrough(await proxy(req('/api/harnesses', 'GET', good)))).toBe(true)
  })

  // --- agent-callable POST: group-invite approval (the ONLY ungated mutation) ---
  it('POST agent groups path (group-invite approval) → passes ungated', async () => {
    expect(passedThrough(await proxy(req(AGENT_GROUPS, 'POST')))).toBe(true)
  })
  it('PUT / PATCH / DELETE on the groups path are still gated', async () => {
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      expect((await proxy(req(AGENT_GROUPS, m))).status).toBe(401)
    }
  })
  it('POST on the sibling admins path is still gated (only groups is agent-callable)', async () => {
    expect((await proxy(req(AGENT_ADMIN, 'POST'))).status).toBe(401)
  })

  // --- mutations always require the session ---
  it('POST with no cookie → 401', async () => {
    const res = await proxy(req('/api/harnesses/create', 'POST'))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('auth required')
  })
  it('POST with a tampered cookie → 401', async () => {
    const good = await computeSessionValue(TOKEN)
    const tampered = (good[0] === 'a' ? 'b' : 'a') + good.slice(1)
    expect((await proxy(req('/api/harnesses/create', 'POST', tampered))).status).toBe(401)
  })
  it('POST with a valid cookie → passes', async () => {
    const good = await computeSessionValue(TOKEN)
    expect(passedThrough(await proxy(req('/api/harnesses/create', 'POST', good)))).toBe(true)
  })
  it('PUT / PATCH / DELETE with no cookie → 401', async () => {
    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      expect((await proxy(req('/api/settings', m))).status).toBe(401)
    }
  })
  it('excludes /api/auth/login and /api/auth/logout from the gate', async () => {
    expect(passedThrough(await proxy(req('/api/auth/login', 'POST')))).toBe(true)
    expect(passedThrough(await proxy(req('/api/auth/logout', 'POST')))).toBe(true)
  })
})

describe('proxy auth gate — token UNSET (fail-closed)', () => {
  beforeEach(() => { delete process.env.HSM_OPERATOR_TOKEN })

  it('POST with no cookie → 503 (auth not configured — never silently open)', async () => {
    const res = await proxy(req('/api/harnesses/create', 'POST'))
    expect(res.status).toBe(503)
    expect(passedThrough(res)).toBe(false)
  })
  it('DELETE with no cookie → 503', async () => {
    expect((await proxy(req('/api/keys/k_1', 'DELETE'))).status).toBe(503)
  })
  it('gated GET (dashboard read) → 503', async () => {
    expect((await proxy(req('/api/harnesses', 'GET'))).status).toBe(503)
  })
  it('sensitive GET (signal pin) → 503 (never serve secrets unconfigured)', async () => {
    expect((await proxy(req(PIN, 'GET'))).status).toBe(503)
  })
  it('agent-read allowlist still passes so the fleet keeps working', async () => {
    expect(passedThrough(await proxy(req(AGENT_ADMIN, 'GET')))).toBe(true)
    expect(passedThrough(await proxy(req(AGENT_GROUPS, 'GET')))).toBe(true)
  })
  it('agent group-invite approval POST still passes (same fleet-keeps-working rationale)', async () => {
    expect(passedThrough(await proxy(req(AGENT_GROUPS, 'POST')))).toBe(true)
  })
  it('GET /api/health/docker still passes — the wizard must check Docker before login', async () => {
    expect(passedThrough(await proxy(req('/api/health/docker', 'GET')))).toBe(true)
  })
  it('GET /api/health/docker does NOT leak the gate to other health paths', async () => {
    expect((await proxy(req('/api/health', 'GET'))).status).toBe(503)
  })
})

// --- Layer 0: Cloudflare Access JWT at the origin -------------------------

describe('proxy — Cloudflare Access at the origin', () => {
  const TEAM = 'testteam.cloudflareaccess.com'
  const AUD = 'aud-tag-123'
  let keys: CryptoKeyPair
  let jwk: JsonWebKey

  const b64url = (bytes: Uint8Array | string): string => {
    const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    let bin = ''
    for (const b of raw) bin += String.fromCharCode(b)
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const jwt = async (over: Record<string, unknown> = {}): Promise<string> => {
    const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
    const p = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 300, ...over }))
    const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${h}.${p}`))
    return `${h}.${p}.${b64url(new Uint8Array(s))}`
  }
  const edgeReq = (path: string, method: string, extra: Record<string, string> = {}, cookie?: string): NextRequest => {
    const headers = new Headers({ 'cf-ray': '8abc-AKL', 'cf-connecting-ip': '203.0.113.9', ...extra })
    if (cookie) headers.set('cookie', `${SESSION_COOKIE}=${cookie}`)
    return new NextRequest(new URL(`https://hsm.example.org${path}`), { method, headers })
  }

  beforeEach(async () => {
    const { __resetAccessJwksCache } = await import('@/lib/auth/cf-access')
    __resetAccessJwksCache()
    keys ??= await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    jwk ??= await crypto.subtle.exportKey('jwk', keys.publicKey)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }))))
    process.env.HSM_OPERATOR_TOKEN = TOKEN
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM
    process.env.CF_ACCESS_AUD = AUD
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.HSM_OPERATOR_TOKEN
    delete process.env.CF_ACCESS_TEAM_DOMAIN
    delete process.env.CF_ACCESS_AUD
  })

  it('edge request with no JWT → 403, even on a page', async () => {
    const res = await proxy(edgeReq('/', 'GET'))
    expect(res.status).toBe(403)
    expect(passedThrough(res)).toBe(false)
  })
  it('edge request with no JWT → 403 on an agent-exempt path (agents never use the tunnel)', async () => {
    expect((await proxy(edgeReq(AGENT_POLICY, 'GET'))).status).toBe(403)
    expect((await proxy(edgeReq(AGENT_GROUPS, 'POST'))).status).toBe(403)
  })
  it('edge request with a JWT for another app → 403', async () => {
    const res = await proxy(edgeReq('/', 'GET', { 'cf-access-jwt-assertion': await jwt({ aud: ['other'] }) }))
    expect(res.status).toBe(403)
  })
  it('edge request with a valid JWT → page passes', async () => {
    const res = await proxy(edgeReq('/', 'GET', { 'cf-access-jwt-assertion': await jwt() }))
    expect(passedThrough(res)).toBe(true)
  })
  it('valid JWT does NOT replace the operator session for gated API routes', async () => {
    const res = await proxy(edgeReq('/api/harnesses', 'GET', { 'cf-access-jwt-assertion': await jwt() }))
    expect(res.status).toBe(401)
  })
  it('valid JWT + valid session → gated API passes', async () => {
    const good = await computeSessionValue(TOKEN)
    const res = await proxy(edgeReq('/api/harnesses', 'GET', { 'cf-access-jwt-assertion': await jwt() }, good))
    expect(passedThrough(res)).toBe(true)
  })
  it('on-host request (no Cloudflare headers) skips the JWT layer: agent paths still pass', async () => {
    expect(passedThrough(await proxy(req(AGENT_POLICY, 'GET')))).toBe(true)
    expect(passedThrough(await proxy(req('/', 'GET')))).toBe(true)
  })
  it('on-host request still hits the session gate', async () => {
    expect((await proxy(req('/api/harnesses', 'GET'))).status).toBe(401)
  })
  it('half-configured Access → edge requests refused with 503 (fail closed)', async () => {
    delete process.env.CF_ACCESS_AUD
    expect((await proxy(edgeReq('/', 'GET', { 'cf-access-jwt-assertion': await jwt() }))).status).toBe(503)
  })
  it('Access not configured → edge requests fall through to the existing gates', async () => {
    delete process.env.CF_ACCESS_AUD
    delete process.env.CF_ACCESS_TEAM_DOMAIN
    expect(passedThrough(await proxy(edgeReq('/', 'GET')))).toBe(true)
    expect((await proxy(edgeReq('/api/harnesses', 'GET'))).status).toBe(401)
  })
  it('pages never hit the session gate (unchanged behaviour off the API)', async () => {
    expect(passedThrough(await proxy(req('/settings', 'GET')))).toBe(true)
  })
})

describe('proxy matcher covers pages, not static chunks', () => {
  // Next compiles the matcher with path-to-regexp; the pattern is a plain
  // regex group, so it can be checked the same way.
  const re = new RegExp('^' + proxyConfig.matcher.replace('/((?!', '/(?!(?:').replace(').*)', ')).*') + '$')
  it('matches pages and the API (the Access check must see them)', () => {
    for (const p of ['/', '/settings', '/api/harnesses', '/api']) expect(re.test(p)).toBe(true)
  })
  it('skips static build output', () => {
    expect(re.test('/_next/static/chunks/app.js')).toBe(false)
    expect(re.test('/favicon.ico')).toBe(false)
  })
})
