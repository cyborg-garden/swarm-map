// Web through the door: which addresses an agent may fetch, written down once
// and read the same way by the launcher, the dashboard, decide() and the door.
// Pure, and it imports nothing but Node's URL parser, so a gate in a cell can
// load it too. docs/lab/tools-slice.md, "Web through the door".
//
// An allowlist entry is a host, or a host and a path: `en.wikipedia.org`,
// `github.com/cyborg-garden`. The host is matched exactly: no wildcard, no
// subdomain, no other port. A path matches itself and what is under it, by
// whole segments: `/cyborg-garden` matches `/cyborg-garden/x` and not
// `/cyborg-gardens`. Names are compared as the URL parser writes them: lower
// case, with an international name in its punycode form, and no trailing dot.
import type { EgressPolicy } from '../policy/types.ts'

/** The one web tool there is. Its class is `network`. */
export const WEB_TOOL = 'web_fetch'

/** The most entries an allowlist may hold. */
export const MAX_WEB_ENTRIES = 50
/** The longest address an agent may ask for. */
export const MAX_URL_CHARS = 2048

/**
 * Suggestions the dashboard offers as one-click chips. None is on by default.
 * A host is exact, so a site that lives at `www.` needs that name too.
 */
export const SUGGESTED_WEB: { label: string; entries: string[] }[] = [
  { label: 'cyborg-garden on GitHub', entries: ['github.com/cyborg-garden', 'api.github.com/repos/cyborg-garden', 'api.github.com/orgs/cyborg-garden', 'raw.githubusercontent.com/cyborg-garden'] },
  { label: 'cyborg.garden', entries: ['cyborg.garden'] },
  { label: 'Wikipedia (English)', entries: ['en.wikipedia.org'] },
  { label: 'Stack Overflow', entries: ['stackoverflow.com'] },
  // Only the archive's pages: web.archive.org/save/<address> has the archive fetch any address, query and all.
  { label: 'Internet Archive', entries: ['archive.org', 'web.archive.org/web'] },
  { label: 'Sefaria', entries: ['www.sefaria.org'] },
  { label: 'Library of Congress', entries: ['www.loc.gov'] },
]

export interface WebEntry { host: string; path: string }

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/
/** A name the URL parser accepted that is really an address: an IPv4 one in any spelling it normalises to, or IPv6. */
const isAddress = (host: string): boolean => IPV4.test(host) || host.startsWith('[') || host.includes(':')
const plainHost = (hostname: string): string => hostname.replace(/\.$/, '')

/** One allowlist entry, read. Returns why it is refused, or the host and path prefix it allows. */
export function parseWebEntry(raw: unknown): WebEntry | { problem: string } {
  if (typeof raw !== 'string') return { problem: 'not text' }
  let text = raw.trim()
  if (/^https:\/\//i.test(text)) text = text.slice('https://'.length)
  if (text === '' || text.length > 200) return { problem: 'empty or too long' }
  if (/[\s*?#@\\%]|[\u0000-\u001f\u007f]/.test(text)) return { problem: 'a host and an optional path only: no wildcard, query, name, password or escape' }
  // Checked before the parser, which would quietly take `a/../b` to be `b`.
  if (text.split('/').slice(1).some((seg) => seg === '.' || seg === '..')) return { problem: 'no . or .. in the path' }
  let url: URL
  try { url = new URL(`https://${text}`) } catch { return { problem: 'not a host name' } }
  if (url.port !== '') return { problem: 'no port: only the usual one is used' }
  const host = plainHost(url.hostname)
  if (isAddress(host)) return { problem: 'a name, not an address' }
  if (!host.includes('.') || host.startsWith('.') || host.includes('..')) return { problem: 'a full host name, such as en.wikipedia.org' }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return { host, path }
}

/** The record's form of an allowlist: one line per host, GET only, with the path prefixes if the host is not open as a whole. */
export function egressHostsFor(entries: WebEntry[]): EgressPolicy['hosts'] {
  const byHost = new Map<string, Set<string>>()
  for (const e of entries) {
    const paths = byHost.get(e.host) ?? new Set<string>()
    paths.add(e.path)
    byHost.set(e.host, paths)
  }
  return [...byHost].map(([host, paths]) => (paths.has('')
    ? { host, methods: ['GET'] }
    : { host, methods: ['GET'], paths: [...paths].sort() }))
}

/** The allowlist as entries again, for showing. */
export function webEntriesOf(egress: Pick<EgressPolicy, 'hosts'>): string[] {
  return egress.hosts.flatMap((h) => (h.paths && h.paths.length > 0 ? h.paths.map((p) => `${h.host}${p}`) : [h.host]))
}

/** Does this host and path fall under the record's list, for this method? */
export function egressAllows(egress: Pick<EgressPolicy, 'hosts'>, host: string, path: string, method: string): boolean {
  if (method !== 'GET') return false
  return egress.hosts.some((h) => h.host === host
    && (h.methods === undefined || h.methods.includes('GET'))
    && (h.paths === undefined || h.paths.length === 0 || h.paths.some((p) => path === p || path.startsWith(`${p}/`))))
}

/**
 * An address an agent asked for, read the way the door will fetch it. Says
 * why it is refused, or gives the host and path decide() is asked about and
 * the address with no fragment. Nothing about the list is looked at here.
 */
export function readWebUrl(raw: unknown, schemes: string[] = ['https:']): { url: string; host: string; path: string } | { problem: string } {
  if (typeof raw !== 'string' || raw === '') return { problem: 'no address' }
  if (raw.length > MAX_URL_CHARS) return { problem: 'the address is too long' }
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) return { problem: 'the address holds a space, a backslash or a control character' }
  let url: URL
  try { url = new URL(raw) } catch { return { problem: 'not an address' } }
  if (!schemes.includes(url.protocol)) return { problem: `only ${schemes.map((s) => s.replace(':', '')).join(' or ')} addresses` }
  if (url.username !== '' || url.password !== '') return { problem: 'the address carries a name or a password, and none is ever sent' }
  if (url.port !== '') return { problem: 'only the usual port is used' }
  const host = plainHost(url.hostname)
  if (host === '' || isAddress(host)) return { problem: 'a host name, not an address' }
  // An escaped slash, backslash or dot could read as one path to the list and another to the site.
  if (/%(2f|5c|2e|00)/i.test(url.pathname)) return { problem: 'the path holds an escaped slash, backslash or dot' }
  url.hash = ''
  return { url: url.href, host, path: url.pathname }
}
