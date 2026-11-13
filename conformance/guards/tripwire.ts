// F6: the tripwire for lab tests that run without Docker.
//
// Once armed, any attempt by THIS PROCESS to reach something that is not this
// machine throws and is recorded: a TCP connect, a UDP send, a DNS lookup or
// query, a fetch. A prompt or a comment saying "tests use fakes" is not a
// guard; this is. Lab test files arm it at the top and fail if anything was
// recorded.
//
// What it cannot see: another process. A harness is a child process, so it
// carries its own copy (child-tripwire.ts). Neither copy sees a program the
// harness starts in turn (a shell tool running curl), or code that is not
// JavaScript. Only the Docker cell closes those.
import dgram from 'node:dgram'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'

export class TripwireError extends Error {
  constructor(what: string) {
    super(`TRIPWIRE: a lab test tried to leave this machine (${what})`)
    this.name = 'TripwireError'
  }
}

const attempts: string[] = []
let armed = false
let report: ((what: string) => void) | undefined

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
  try { report?.(what) } catch { /* the record above stands, and the throw below still stops it */ }
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

type AnyFn = (...args: unknown[]) => unknown

/** Swap `holder[name]` for a version that trips when its first argument is not this machine. */
function guardHost(holder: Record<string, unknown>, name: string, label: string, reject: boolean): void {
  const real = holder[name] as AnyFn | undefined
  if (typeof real !== 'function') return
  holder[name] = function tripwired(this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'string' && !isLoopback(args[0])) {
      // The promise forms report a refusal the way they report any failure.
      if (reject) { try { trip(`${label} ${args[0]}`) } catch (err) { return Promise.reject(err) } }
      trip(`${label} ${args[0]}`)
    }
    return real.apply(this, args)
  }
}

/** Every DNS query function: resolve, resolve4, resolveTxt, ..., and reverse. */
const isQuery = (name: string): boolean => /^resolve([A-Z0-9]\w*)?$/.test(name) || name === 'reverse'
const queriesOf = (holder: object): string[] => Object.getOwnPropertyNames(holder).filter(isQuery)

/** Where a UDP send() is going. Its port sits after an optional offset and length. */
function udpTarget(args: unknown[]): ConnectTarget {
  const at = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number' ? 3 : 1
  if (typeof args[at] !== 'number') return {} // a connected socket: its connect() was already checked
  return { port: args[at] as number, host: typeof args[at + 1] === 'string' ? (args[at + 1] as string) : undefined }
}

/**
 * Arm the tripwire in this process. `onTrip` is told about each attempt as it
 * happens, for a process whose record has to be read from outside it.
 */
export function armTripwire(opts: { onTrip?: (what: string) => void } = {}): void {
  if (opts.onTrip) report = opts.onTrip
  if (armed) return
  armed = true

  const realConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function tripwiredConnect(this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args)
    if (target.path === undefined && !isLoopback(target.host)) trip(`net.connect ${target.host}:${target.port}`)
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args)
  } as typeof net.Socket.prototype.connect

  const udp = dgram.Socket.prototype as unknown as Record<string, AnyFn>
  const realSend = udp.send
  udp.send = function tripwiredSend(this: unknown, ...args: unknown[]) {
    const target = udpTarget(args)
    if (target.port !== undefined && !isLoopback(target.host)) trip(`udp.send ${target.host}:${target.port}`)
    return realSend.apply(this, args)
  }
  const realUdpConnect = udp.connect
  udp.connect = function tripwiredUdpConnect(this: unknown, ...args: unknown[]) {
    const host = typeof args[1] === 'string' ? args[1] : undefined
    if (!isLoopback(host)) trip(`udp.connect ${host}:${args[0]}`)
    return realUdpConnect.apply(this, args)
  }

  // DNS, every way Node offers it: lookup (the system resolver) and the
  // resolve* family (queries sent straight to a name server), as callbacks
  // and as promises, on the module and on a Resolver of one's own.
  const dnsModule = dns as unknown as Record<string, unknown>
  const dnsPromises = dns.promises as unknown as Record<string, unknown>
  guardHost(dnsModule, 'lookup', 'dns.lookup', false)
  guardHost(dnsPromises, 'lookup', 'dns.promises.lookup', true)
  for (const name of queriesOf(dns)) guardHost(dnsModule, name, `dns.${name}`, false)
  for (const name of queriesOf(dns.promises)) guardHost(dnsPromises, name, `dns.promises.${name}`, true)
  const resolver = dns.Resolver.prototype as unknown as Record<string, unknown>
  for (const name of queriesOf(resolver)) guardHost(resolver, name, `dns.Resolver.${name}`, false)
  const promiseResolver = dns.promises.Resolver.prototype as unknown as Record<string, unknown>
  for (const name of queriesOf(promiseResolver)) guardHost(promiseResolver, name, `dns.promises.Resolver.${name}`, true)

  const realFetch = globalThis.fetch
  globalThis.fetch = async function tripwiredFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!isLoopback(url.hostname)) trip(`fetch ${url.hostname}`)
    return realFetch(input, init)
  }

  // Code that did `import { lookup } from 'node:dns'` holds a copy made when
  // it loaded. This refreshes those copies so they are the guarded ones.
  syncBuiltinESMExports()
}
