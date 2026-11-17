// @vitest-environment node
//
// The web allowlist: how an entry is read, how an address an agent gives is
// read, and what decide() says about it. No network.
import { describe, expect, it } from 'vitest'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { decide } from '../decide.ts'
import { withHash } from '../policy/canonical.ts'
import { validatePolicy } from '../policy/validate.ts'
import { egressAllows, egressHostsFor, parseWebEntry, readWebUrl, SUGGESTED_WEB, webEntriesOf, type WebEntry } from '../tools/web.ts'

const entries = (...raw: string[]): WebEntry[] => raw.map((r) => {
  const e = parseWebEntry(r)
  if ('problem' in e) throw new Error(`${r}: ${e.problem}`)
  return e
})
const policyWith = (...raw: string[]) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), { 'egress.hosts': egressHostsFor(entries(...raw)) }))
/** What decide() says about an address, after the door has read it. */
function verdict(policy: ReturnType<typeof policyWith>, url: string, method = 'GET'): string {
  const read = readWebUrl(url)
  if ('problem' in read) return `refused: ${read.problem}`
  return decide(policy, { kind: 'egress', host: read.host, path: read.path, method }, {}).verdict
}

describe('web allowlist entries', () => {
  it('[U:web-entry] a host, or a host and a path, written the way the URL parser writes it', () => {
    expect(parseWebEntry('en.wikipedia.org')).toEqual({ host: 'en.wikipedia.org', path: '' })
    expect(parseWebEntry('GitHub.com/cyborg-garden/')).toEqual({ host: 'github.com', path: '/cyborg-garden' })
    expect(parseWebEntry('https://Example.ORG.')).toEqual({ host: 'example.org', path: '' })
    // An international name is kept in its punycode form, so it compares with what a fetch would use.
    expect(parseWebEntry('bücher.example')).toEqual({ host: 'xn--bcher-kva.example', path: '' })
  })

  it('[U:web-entry] no wildcard, port, address, name, password, query or dot segment', () => {
    for (const bad of [
      '*.wikipedia.org', 'wikipedia.org:8443', '127.0.0.1', '0x7f.1', '[::1]', 'user@site.example', 'github.com?x=1',
      'github.com/#x', 'localhost', 'github.com/a/../b', 'github.com/%2e%2e', 'http://github.com', '', ' ', 'a b.com', 'evil.com\\@good.com',
    ]) expect(parseWebEntry(bad), bad).toHaveProperty('problem')
  })

  it('[U:web-entry] every suggested entry is a valid one, and the record round-trips them', () => {
    const all = SUGGESTED_WEB.flatMap((s) => s.entries)
    expect(all.every((e) => !('problem' in parseWebEntry(e)))).toBe(true)
    const policy = policyWith(...all)
    expect(validatePolicy(policy, { testing: true })).toEqual([])
    expect(webEntriesOf(policy.egress).sort()).toEqual(all.sort())
  })

  it('[U:web-entry] a host listed whole wins over a path on it', () => {
    expect(egressHostsFor(entries('github.com/cyborg-garden', 'github.com'))).toEqual([{ host: 'github.com', methods: ['GET'] }])
  })

  it('[U:web-entry] the record refuses a host that is not written as the parser writes it, and a method but GET', () => {
    const base = loadFixturePolicy('policy-team.json')
    for (const hosts of [[{ host: 'GitHub.com' }], [{ host: '*.github.com' }], [{ host: '10.0.0.1' }], [{ host: 'github.com', methods: ['POST'] }], [{ host: 'github.com', paths: ['x'] }], [{ host: 'github.com', paths: ['/x/'] }]]) {
      expect(validatePolicy(withHash(applyPatch(base, { 'egress.hosts': hosts })), { testing: true }), JSON.stringify(hosts)).not.toEqual([])
    }
  })
})

describe('web addresses an agent gives', () => {
  const policy = policyWith('github.com/cyborg-garden', 'en.wikipedia.org', 'xn--bcher-kva.example')

  it('[U:web-url] an address on the list is allowed, matched by exact host and whole path segments', () => {
    expect(verdict(policy, 'https://en.wikipedia.org/wiki/Moss')).toBe('allow')
    expect(verdict(policy, 'https://EN.Wikipedia.org./wiki/Moss')).toBe('allow')
    expect(verdict(policy, 'https://github.com/cyborg-garden')).toBe('allow')
    expect(verdict(policy, 'https://github.com/cyborg-garden/swarm-map#readme')).toBe('allow')
    expect(verdict(policy, 'https://bücher.example/')).toBe('allow')
  })

  it('[U:web-url] anything else is refused', () => {
    for (const url of [
      'https://github.com/cyborg-gardens', 'https://github.com/other-org/x', 'https://github.com/', 'https://gist.github.com/cyborg-garden',
      'https://de.wikipedia.org/', 'https://wikipedia.org/', 'https://en.wikipedia.org.evil.com/', 'https://evilen.wikipedia.org/',
      'https://github.com/cyborg-garden/../other-org', 'https://github.com/cyborg-garden/%2e%2e/other-org', 'https://github.com/cyborg-garden%2f..%2fother-org',
    ]) expect(verdict(policy, url), url).not.toBe('allow')
    expect(verdict(policy, 'https://en.wikipedia.org/', 'POST')).toBe('deny')
  })

  it('[U:web-url] the address itself: https only, no name or password, usual port, a name and not an address', () => {
    for (const url of [
      'http://en.wikipedia.org/', 'ftp://en.wikipedia.org/', 'file:///etc/passwd', 'https://ex:pw@docs.example/', 'https://docs.example@evil.example/',
      'https://en.wikipedia.org:8443/', 'https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f000001/', 'https://en.wikipedia.org/a b',
      'https://docs.example\\@evil.example/', 'javascript:alert(1)', '', 'x'.repeat(3000),
    ]) expect(readWebUrl(url), url).toHaveProperty('problem')
    expect(readWebUrl(42)).toHaveProperty('problem')
  })

  it('[U:web-url] an escaped slash, backslash or dot under an allowed prefix is refused, so the site cannot read it as another path', () => {
    for (const url of ['https://github.com/cyborg-garden/a%2F..%2F..%2Fother-org', 'https://github.com/cyborg-garden/a%5c..%5cother-org', 'https://github.com/cyborg-garden/%2E%2E%2Fother-org']) {
      expect(readWebUrl(url), url).toHaveProperty('problem')
    }
  })

  it('[U:web-url] the list itself allows GET only, whoever asks it', () => {
    const { egress } = policyWith('en.wikipedia.org')
    expect(egressAllows(egress, 'en.wikipedia.org', '/', 'GET')).toBe(true)
    for (const m of ['POST', 'PUT', 'DELETE', 'get', 'HEAD']) expect(egressAllows(egress, 'en.wikipedia.org', '/', m), m).toBe(false)
  })

  it('[U:web-url] an empty list allows nothing', () => {
    expect(verdict(policyWith(), 'https://en.wikipedia.org/')).toBe('deny')
  })
})
