/**
 * Operator-session primitives for the HSM auth gate.
 *
 * The session cookie is a STATELESS HMAC — no session store. Its value is
 * HMAC-SHA256(key = HSM_OPERATOR_TOKEN, message = SESSION_MESSAGE), hex-encoded.
 * The proxy recomputes this from the server-only token and constant-time
 * compares it against the cookie, so verification needs nothing but the env var.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle) rather than node:crypto so
 * the exact same module runs in both the Next.js proxy runtime and Node route
 * handlers. All functions are async because subtle.sign is async.
 *
 * SECURITY: HSM_OPERATOR_TOKEN is read from process.env by callers only. It is
 * never exposed to the client (no NEXT_PUBLIC_) and never logged.
 */

/** Name of the httpOnly operator-session cookie. */
export const SESSION_COOKIE = 'hsm_session'

/** Fixed HMAC message. Bumping this string invalidates all existing cookies. */
export const SESSION_MESSAGE = 'hsm-operator-v1'

/**
 * HMAC-SHA256(key, message) as a lowercase hex string.
 * Length is always 64 chars (32 bytes) regardless of input.
 */
export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The session-cookie value for a given operator token: HMAC(token, SESSION_MESSAGE).
 * Passing the wrong token produces a different (also 64-char) value, so callers
 * can compare two session values in constant time without leaking token length.
 */
export function computeSessionValue(token: string): Promise<string> {
  return hmacHex(token, SESSION_MESSAGE)
}

/**
 * Constant-time string comparison. Guards on length first (both operands here
 * are fixed-length hex, so the length branch reveals nothing about the secret),
 * then XOR-accumulates every char so the loop time does not depend on where the
 * first mismatch is. Avoids the early-exit timing leak of `===`.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * True if `providedToken` matches `expectedToken` (the env secret). Compared via
 * their HMACs so both operands are fixed-length — no raw-token length leak.
 */
export async function verifyToken(
  providedToken: string,
  expectedToken: string,
): Promise<boolean> {
  const [provided, expected] = await Promise.all([
    computeSessionValue(providedToken),
    computeSessionValue(expectedToken),
  ])
  return timingSafeEqual(provided, expected)
}

/**
 * True if `cookieValue` is a valid session for `expectedToken`.
 */
export async function verifySession(
  cookieValue: string | undefined,
  expectedToken: string,
): Promise<boolean> {
  if (!cookieValue) return false
  const expected = await computeSessionValue(expectedToken)
  return timingSafeEqual(cookieValue, expected)
}
