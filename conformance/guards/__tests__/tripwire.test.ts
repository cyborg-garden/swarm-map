// @vitest-environment node
//
// F6 negative control: the tripwire must stop and record anything that tries
// to leave the machine. If this test cannot make it trip, no other test may
// lean on it.
import dns from 'node:dns'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, clearTripwire, tripwireAttempts, TripwireError } from '../tripwire.ts'

armTripwire()
afterEach(() => clearTripwire())

describe('F6 tripwire', () => {
  it('stops a TCP connect to a non-loopback address and records it', () => {
    // 192.0.2.1 is TEST-NET-1: reserved, never routed.
    expect(() => net.connect({ host: '192.0.2.1', port: 9 })).toThrow(TripwireError)
    expect(() => net.connect(9, '192.0.2.1')).toThrow(TripwireError)
    expect(() => new net.Socket().connect(9, '192.0.2.1')).toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual([
      'net.connect 192.0.2.1:9', 'net.connect 192.0.2.1:9', 'net.connect 192.0.2.1:9',
    ])
  })

  it('stops a DNS lookup of a real name and records it', () => {
    expect(() => dns.lookup('example.com', () => {})).toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual(['dns.lookup example.com'])
  })

  it('stops fetch to a remote URL and records it', async () => {
    await expect(fetch('http://192.0.2.1:9/')).rejects.toThrow(TripwireError)
    await expect(fetch('https://example.com/')).rejects.toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual(['fetch 192.0.2.1', 'fetch example.com'])
  })

  it('lets loopback through', async () => {
    const server = net.createServer((s) => s.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const got = await new Promise<string>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port })
      let data = ''
      s.on('data', (d) => { data += d })
      s.on('end', () => resolve(data))
      s.on('error', reject)
    })
    await new Promise((resolve) => server.close(resolve))
    expect(got).toBe('ok')
    expect(tripwireAttempts()).toEqual([])
  })
})
