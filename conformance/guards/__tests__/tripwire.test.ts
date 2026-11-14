// @vitest-environment node
//
// F6 negative control: the tripwire must stop and record anything that tries
// to leave the machine. If this test cannot make it trip, no other test may
// lean on it.
import dgram from 'node:dgram'
import dns from 'node:dns'
import * as dnsNamed from 'node:dns'
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

  it('stops a UDP send or connect to a non-loopback address and records it', () => {
    const socket = dgram.createSocket('udp4')
    try {
      expect(() => socket.send('x', 9, '192.0.2.1')).toThrow(TripwireError)
      expect(() => socket.send(Buffer.from('xyz'), 0, 1, 9, '192.0.2.1')).toThrow(TripwireError)
      expect(() => socket.connect(9, '192.0.2.1')).toThrow(TripwireError)
      expect(tripwireAttempts()).toEqual(['udp.send 192.0.2.1:9', 'udp.send 192.0.2.1:9', 'udp.connect 192.0.2.1:9'])
    } finally {
      socket.close()
    }
  })

  it('lets a UDP send to loopback through', async () => {
    const socket = dgram.createSocket('udp4')
    await new Promise<void>((resolve, reject) => socket.send('x', 9, '127.0.0.1', (err) => (err ? reject(err) : resolve())))
    socket.close()
    expect(tripwireAttempts()).toEqual([])
  })

  it('stops every other way of asking DNS about a real name', async () => {
    expect(() => dns.resolve4('example.com', () => {})).toThrow(TripwireError)
    expect(() => dns.resolve('example.com', 'MX', () => {})).toThrow(TripwireError)
    expect(() => new dns.Resolver().resolve4('example.com', () => {})).toThrow(TripwireError)
    await expect(dns.promises.lookup('example.com')).rejects.toThrow(TripwireError)
    await expect(dns.promises.resolve4('example.com')).rejects.toThrow(TripwireError)
    await expect(new dns.promises.Resolver().resolveTxt('example.com')).rejects.toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual([
      'dns.resolve4 example.com', 'dns.resolve example.com', 'dns.Resolver.resolve4 example.com',
      'dns.promises.lookup example.com', 'dns.promises.resolve4 example.com', 'dns.promises.Resolver.resolveTxt example.com',
    ])
  })

  it('stops a reverse lookup of an address that is not this machine', async () => {
    expect(() => dns.lookupService('192.0.2.1', 22, () => {})).toThrow(TripwireError)
    await expect(dns.promises.lookupService('192.0.2.1', 22)).rejects.toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual(['dns.lookupService 192.0.2.1', 'dns.promises.lookupService 192.0.2.1'])
  })

  it('stops a connect to a local socket file, which is how a Docker daemon or an ssh agent is reached', () => {
    expect(() => net.connect({ path: '/var/run/docker.sock' })).toThrow(TripwireError)
    expect(() => net.connect('/var/run/docker.sock')).toThrow(TripwireError)
    expect(tripwireAttempts()).toEqual(['net.connect socket /var/run/docker.sock', 'net.connect socket /var/run/docker.sock'])
  })

  it('code that imported a DNS function by name gets the guarded one too', () => {
    expect(() => dnsNamed.lookup('example.com', () => {})).toThrow(TripwireError)
    expect(() => dnsNamed.resolve4('example.com', () => {})).toThrow(TripwireError)
  })
})
