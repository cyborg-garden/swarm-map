// @vitest-environment node
//
// How the runner finds the addresses the probe will try. The lookup runs in a
// container; what it does with the answers is decided here and can be tested
// anywhere, with a resolver that is not real.
import { describe, expect, it } from 'vitest'
import { findAddresses, type Lookups } from '../lookup.ts'

const none = (): Promise<string[]> => Promise.reject(new Error('ENODATA'))
const answers = (over: Partial<Lookups> = {}): Lookups => ({
  hostAddress: async () => '192.0.2.254',
  resolve4: async (name) => (name === 'example.com' ? ['192.0.2.10', '192.0.2.11'] : ['192.0.2.53']),
  resolve6: async () => ['2001:db8::53'],
  ...over,
})

describe('finding the addresses the probe will try', () => {
  it('[U:probe-targets] takes each address from this machine\'s own resolver', async () => {
    expect(await findAddresses(answers())).toEqual({ hostIp: '192.0.2.254', publicIp: '192.0.2.10', resolverIp: '192.0.2.53', resolverIp6: '2001:db8::53' })
  })

  it('[U:probe-targets] a resolver that gives no IPv6 answers is not the end: the public resolver is asked itself', async () => {
    const asked: (string | undefined)[] = []
    const found = await findAddresses(answers({
      resolve6: async (_name, server) => { asked.push(server); if (server === undefined) return none(); return ['2001:db8::1111'] },
    }))
    expect(found.resolverIp6).toBe('2001:db8::1111')
    // First this machine's resolver, then the public one that was just found, by its address.
    expect(asked).toEqual([undefined, '192.0.2.53'])
  })

  it('[U:probe-targets] an address that cannot be found stays empty, so the check that needs it fails rather than passes untried', async () => {
    expect(await findAddresses(answers({ resolve6: none }))).toMatchObject({ resolverIp: '192.0.2.53', resolverIp6: '' })
    expect(await findAddresses({ hostAddress: () => Promise.reject(new Error('x')), resolve4: none, resolve6: none }))
      .toEqual({ hostIp: '', publicIp: '', resolverIp: '', resolverIp6: '' })
    // With no public resolver found there is nobody else to ask.
    const asked: (string | undefined)[] = []
    await findAddresses(answers({ resolve4: none, resolve6: async (_n, server) => { asked.push(server); return none() } }))
    expect(asked).toEqual([undefined])
  })

  it('[U:probe-targets] an answer that is not an address is dropped', async () => {
    const found = await findAddresses(answers({ hostAddress: async () => 'not an address; rm -rf', resolve6: async () => ['$(id)'] }))
    expect(found).toMatchObject({ hostIp: '', resolverIp6: '' })
  })
})
