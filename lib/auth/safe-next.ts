/**
 * Validate a post-login `?next=` target so it can only send the browser to a
 * path on this origin.
 *
 * Without this, `/login?next=javascript:...` runs script after sign-in and
 * `?next=//evil.com` is an open redirect. Anything that is not a plain
 * same-origin path falls back to `/`.
 */
// C0 controls, DEL and backslash. The URL parser silently strips tab/newline
// and treats `\` as `/`, so they are rejected before parsing, not after.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/

export function safeNextPath(next: string | null | undefined, origin: string): string {
  const fallback = '/'
  if (typeof next !== 'string' || next === '') return fallback
  if (UNSAFE_CHARS.test(next)) return fallback
  // Must be a rooted path: a single leading slash, no scheme, no `//host`.
  if (!next.startsWith('/') || next.startsWith('//')) return fallback
  // Also check one decode deep, so a double-encoded `/%09/` or `/%5C` cannot
  // become an off-origin target if anything downstream decodes it again.
  let decoded: string
  try {
    decoded = decodeURIComponent(next)
  } catch {
    return fallback
  }
  if (UNSAFE_CHARS.test(decoded) || decoded.startsWith('//')) return fallback

  let url: URL
  try {
    url = new URL(next, origin)
  } catch {
    return fallback
  }
  if (url.origin !== new URL(origin).origin) return fallback

  const out = url.pathname + url.search + url.hash
  // Dot-segment normalisation can turn `/.//evil.com` into `//evil.com`,
  // which a browser would read as protocol-relative.
  if (!out.startsWith('/') || out.startsWith('//')) return fallback
  return out
}
