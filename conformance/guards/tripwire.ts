// F6: the in-process tripwire for lab tests that run without Docker.
//
// Once armed, any attempt to reach something that is not this machine throws
// and is recorded: a TCP connect, a DNS lookup, a fetch. A prompt or a comment
// saying "tests use fakes" is not a guard; this is. Lab test files arm it at
// the top and fail if anything was recorded.
import dns from 'node:dns'
import net from 'node:net'

export class TripwireError extends Error {
  constructor(what: string) {
    super(`TRIPWIRE: a lab test tried to leave this machine (${what})`)
    this.name = 'TripwireError'
  }
}

const attempts: string[] = []
let armed = false

export function tripwireAttempts(): string[] {
  return [...attempts]
}

export function clearTripwire(): void {
  attempts.length = 0
}

export function isLoopback(host: string | undefined): boolean {
  if (host === undefined || host === '') return true // Node's default is localhost
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127(\.\d{1,3}){3}$/.test(h)
}

function trip(what: string): never {
  attempts.push(what)
  throw new TripwireError(what)
}

type ConnectTarget = { host?: string; port?: number | string; path?: string }

/** Read the destination out of the many shapes net's connect() accepts. */
function connectTarget(args: unknown[]): ConnectTarget {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first }
  if (typeof first === 'number' || typeof first === 'string') {
    return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined }
  }
  if (first !== null && typeof first === 'object') return first as ConnectTarget
  return {}
}

export function armTripwire(): void {
  if (armed) return
  armed = true

  const realConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function tripwiredConnect(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args)
    if (target.path === undefined && !isLoopback(target.host)) trip(`net.connect ${target.host}:${target.port}`)
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect

  const realLookup = dns.lookup
  dns.lookup = function tripwiredLookup(hostname: string, ...rest: unknown[]) {
    if (!isLoopback(hostname)) trip(`dns.lookup ${hostname}`)
    return (realLookup as (...a: unknown[]) => unknown)(hostname, ...rest)
  } as typeof dns.lookup

  const realFetch = globalThis.fetch
  globalThis.fetch = async function tripwiredFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!isLoopback(url.hostname)) trip(`fetch ${url.hostname}`)
    return realFetch(input, init)
  }
}
