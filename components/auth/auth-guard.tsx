'use client'

import { useEffect } from 'react'

/**
 * Client-side companion to the middleware auth gate.
 *
 * Pages fetch via inline `fetch(url, { method })` calls and the `useApi` hook —
 * there is no single request wrapper. To redirect to /login on a 401 from ANY of
 * them without editing every call site, we wrap window.fetch once at the root
 * layout and watch for the gate's `401 { error: 'auth required' }` response.
 * Mounted globally (not just the dashboard) so the pre-auth setup wizard, which
 * now also hits the gated API, redirects instead of silently failing.
 *
 * This is a UX convenience only — it is NOT a security control. The real
 * enforcement is server-side in proxy.ts.
 */
export function AuthGuard() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as { __hsmFetchPatched?: boolean }
    if (w.__hsmFetchPatched) return
    w.__hsmFetchPatched = true

    const originalFetch = window.fetch.bind(window)
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await originalFetch(...args)
      if (res.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url
        // Only react to our own API gate, and don't loop on the login endpoint.
        if (url.includes('/api/') && !url.includes('/api/auth/')) {
          const next = encodeURIComponent(
            window.location.pathname + window.location.search,
          )
          window.location.href = `/login?next=${next}`
        }
      }
      return res
    }
  }, [])

  return null
}
