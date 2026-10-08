import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

/**
 * Auth gate for mutating API routes.
 *
 * WHY: HSM has no transport auth. Agent containers reach the host through the
 * container engine's network (Docker Desktop, OrbStack), so an agent-container
 * request arrives with no reliable marker distinguishing it from a dashboard
 * request — the only viable separator is a credential the agent cannot obtain.
 * This gate requires a valid operator-session cookie (a stateless HMAC of
 * HSM_OPERATOR_TOKEN) on every state-changing request.
 *
 * BEHAVIOR:
 *  - POST / PUT / PATCH / DELETE: require a valid hsm_session cookie.
 *  - GET / HEAD: require the session too — UNLESS the path is one of the few an
 *    agent legitimately reads at runtime (AGENT_READABLE_GET_PATHS). Many reads
 *    leak operator-sensitive data (keys roster, settings PII, people, admin
 *    rosters, decrypted PIN, audit trail), so reads are gated by default and the
 *    agent-read paths are an explicit allowlist. Agents get their policy/
 *    allowlist from env_file at boot; the only runtime HTTP reads they make are
 *    the per-user is-admin / is-group-allowed booleans below (they carry no
 *    secrets). Dashboard reads ride the same-origin cookie once logged in.
 *  - /api/auth/login and /api/auth/logout are excluded (establish/clear session).
 *
 * FAIL CLOSED: if HSM_OPERATOR_TOKEN is unset/empty, gated requests are REFUSED
 * with 503 rather than served open — a missing operator secret must never
 * degrade to no-auth. The agent-read allowlist still passes (booleans, no
 * secrets) so the fleet keeps working while auth is (mis)configured.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const READ_METHODS = new Set(['GET', 'HEAD'])

// Routes that must never be gated: they run before a session exists (login),
// tear it down (logout), and neither should 401 the operator out.
const EXCLUDED_PATHS = new Set(['/api/auth/login', '/api/auth/logout'])

// Liveness probes that must answer before any session exists — the setup wizard
// checks Docker before the operator can log in. Returns availability/versions,
// no secrets. Gating this made the wizard read the gate's 503 as "Docker is
// missing" and tell the operator to install Docker Desktop.
const PUBLIC_GET_PATHS = new Set(['/api/health/docker'])

// The ONLY GET paths agents read at runtime (verified against hermes-agent
// swarm_map_policy plugin). Each returns a boolean, no secret. `admins/<userId>`
// is the per-user is-admin check — distinct from the bare `admins` roster, which
// IS gated. `policy` is allowlisted defensively for older agent builds.
const AGENT_READABLE_GET_PATHS: RegExp[] = [
  /^\/api\/harnesses\/[^/]+\/surfaces\/[^/]+\/groups\/[^/]+$/,  // is_group_allowed
  /^\/api\/harnesses\/[^/]+\/surfaces\/[^/]+\/admins\/[^/]+$/,  // is_platform_admin (per-user)
  /^\/api\/harnesses\/[^/]+\/policy$/,                          // agent .env policy read
]

// The ONLY POST path agents call at runtime: group-invite approval ("user X
// just added me to group Y — approved?"). The plugin cannot obtain the operator
// cookie, so this rides the same exemption as the agent reads above.
//
// TRUST MODEL: the caller self-reports addedByUserId — the server cannot verify
// who really performed the platform-side invite, so any local process could
// claim an admin's ID. What bounds the blast radius: the handler can ONLY
// append one structurally-validated groupId to that surface's group allowlist
// (never admins, tokens, or any other env var), the invite policy + admin check
// still gate it, and every approval is audit-logged with the claimed actor.
// This mirrors the trust already extended to the agent's is_admin /
// is_group_allowed reads, which the same plugin acts on.
const AGENT_CALLABLE_POST_PATHS: RegExp[] = [
  /^\/api\/harnesses\/[^/]+\/surfaces\/[^/]+\/groups\/[^/]+$/,  // group-invite approval
]

function requiresAuth(method: string, pathname: string): boolean {
  if (MUTATING_METHODS.has(method)) {
    if (method === 'POST' && AGENT_CALLABLE_POST_PATHS.some((re) => re.test(pathname))) {
      return false
    }
    return true
  }
  if (READ_METHODS.has(method)) {
    if (PUBLIC_GET_PATHS.has(pathname)) return false
    return !AGENT_READABLE_GET_PATHS.some((re) => re.test(pathname))
  }
  return false // OPTIONS and other non-mutating verbs
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const method = request.method.toUpperCase()
  const pathname = request.nextUrl.pathname

  // Auth endpoints establish/clear the session; never gate them.
  if (EXCLUDED_PATHS.has(pathname)) {
    return NextResponse.next()
  }

  // Ordinary reads (agents' policy/is-admin reads, dashboard reads) pass ungated.
  if (!requiresAuth(method, pathname)) {
    return NextResponse.next()
  }

  const token = process.env.HSM_OPERATOR_TOKEN
  // FAIL CLOSED: no operator secret configured → refuse rather than serve open.
  if (!token) {
    return NextResponse.json({ error: 'auth not configured' }, { status: 503 })
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value
  if (await verifySession(cookie, token)) {
    return NextResponse.next()
  }

  return NextResponse.json({ error: 'auth required' }, { status: 401 })
}

export const config = {
  matcher: '/api/:path*',
}
