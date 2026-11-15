// Which addresses a lab network gets.
//
// A network that names no addresses is given some from Docker's own pools,
// and a machine with many networks has none left to give: every start then
// fails. So each lab network names a small block of its own, from a range
// Docker's pools do not use. The block is picked for each rig from what is
// free on this Docker at that moment, and picked again if another run took it
// first.
//
// Naming a block changes which addresses a network has and nothing else. No
// gateway, driver or option is ever written: a network with no way out is
// still made by `internal: true`, and the checks still prove it from inside.
import { randomInt } from 'node:crypto'
import os from 'node:os'
import { RefusingToRun } from '../guards/preflight.ts'

/** Names another range for a run to take its networks from. A block of 10.0.0.0/8, /8 to /24. */
export const SUBNET_BASE_ENV = 'SWARMLAB_SUBNET_BASE'
/** Docker's own pools are 172.17.0.0/16 to 172.31.0.0/16 and 192.168.0.0/16. This is in neither. */
export const DEFAULT_SUBNET_BASE = '10.213.0.0/16'
/** Sixteen addresses: room for the four containers of a rig and Docker's own three. */
export const BLOCK_BITS = 28
const BLOCK_SIZE = 2 ** (32 - BLOCK_BITS)

interface Block { start: number; size: number; bits: number; exact: boolean }

function address(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)) return undefined
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}
const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** An IPv4 block. `exact` is false when the address given is not the block's first, as an interface's is not. */
function block(cidr: unknown): Block | undefined {
  if (typeof cidr !== 'string') return undefined
  const m = /^([0-9.]+)\/(\d{1,2})$/.exec(cidr)
  const at = m ? address(m[1]) : undefined
  const bits = m ? Number(m[2]) : 99
  if (at === undefined || bits > 32) return undefined
  const size = 2 ** (32 - bits)
  const start = at - (at % size)
  return { start, size, bits, exact: start === at }
}
const shares = (a: Block, b: Block): boolean => a.start < b.start + b.size && b.start < a.start + a.size

/** Whether two blocks share an address. Something that is not an IPv4 block shares none. */
export function subnetsOverlap(a: string, b: string): boolean {
  const [x, y] = [block(a), block(b)]
  return x !== undefined && y !== undefined && shares(x, y)
}

export function inSubnet(ip: string, subnet: string): boolean {
  const [at, within] = [address(ip), block(subnet)]
  return at !== undefined && within !== undefined && at >= within.start && at < within.start + within.size
}

/** The range this run takes its networks from. */
export function labSubnetBase(env: Record<string, string | undefined> = process.env): string {
  const base = env[SUBNET_BASE_ENV] ?? DEFAULT_SUBNET_BASE
  const b = block(base)
  if (!b || !b.exact || b.bits < 8 || b.bits > 24 || !shares(b, block('10.0.0.0/8')!)) {
    throw new RefusingToRun('F5', `${SUBNET_BASE_ENV} is not a block of 10.0.0.0/8 between /8 and /24`)
  }
  return base
}

/** Whether `subnet` is one of the blocks the lab hands out from `base`. */
function isLabBlock(subnet: unknown, base: string): boolean {
  const [b, within] = [block(subnet), block(base)]
  return b !== undefined && within !== undefined && b.exact && b.bits === BLOCK_BITS && b.start >= within.start && b.start + b.size <= within.start + within.size
}

/**
 * `count` blocks of `base` that share no address with anything in `used` or
 * with each other. The search starts at `offset`, which is random unless it
 * is given, so two runs that start together seldom ask for the same block.
 */
export function pickSubnets(count: number, used: string[], base: string = labSubnetBase(), offset?: number): string[] {
  const within = block(base)!
  const blocks = within.size / BLOCK_SIZE
  const taken = used.map(block).filter((b): b is Block => b !== undefined)
  const from = offset ?? randomInt(blocks)
  const picked: string[] = []
  for (let i = 0; i < blocks && picked.length < count; i++) {
    const candidate: Block = { start: within.start + ((from + i) % blocks) * BLOCK_SIZE, size: BLOCK_SIZE, bits: BLOCK_BITS, exact: true }
    if (taken.some((t) => shares(t, candidate))) continue
    picked.push(`${dotted(candidate.start)}/${BLOCK_BITS}`)
  }
  if (picked.length < count) throw new RefusingToRun('S0', `no free /${BLOCK_BITS} is left in ${base} for a lab network: set ${SUBNET_BASE_ENV} to another block of 10.0.0.0/8`)
  return picked
}

/** The IPv4 blocks of this machine's own interfaces. */
const hostSubnets = (): string[] =>
  Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal && a.cidr).map((a) => a!.cidr!)

/**
 * Every IPv4 block in use: those of every network this Docker has, and those
 * of this machine's own interfaces. `docker` runs the docker CLI. Read-only.
 */
export function usedSubnets(docker: (args: string[]) => { ok: boolean; out: string }, host: string[] = hostSubnets()): string[] {
  const listed = docker(['network', 'ls', '--quiet'])
  if (!listed.ok) throw new RefusingToRun('S0', 'Docker did not list its networks, so no free block could be picked')
  const ids = listed.out.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]+$/.test(l))
  // A network removed since it was listed makes this fail for that one alone: the others are still printed.
  const seen = ids.length === 0 ? '' : docker(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{println .Subnet}}{{end}}', ...ids]).out
  return [...seen.split('\n').map((l) => l.trim()), ...host].filter((s) => block(s) !== undefined)
}

/** What Docker says when it is asked for addresses another network already has. */
const POOL_OVERLAP = /pool overlaps/i

/**
 * Start something on `count` free blocks. `start` is handed blocks that were
 * free when it was called. If Docker then says another network has them,
 * `undo` removes whatever was made, and it is tried again with others.
 */
export function onFreeSubnets<T>(
  o: { count: number; used: () => string[]; base?: string; offset?: () => number; attempts?: number },
  start: (subnets: string[]) => T, undo: () => void,
): T {
  const attempts = o.attempts ?? 5
  for (let attempt = 1; ; attempt++) {
    const subnets = pickSubnets(o.count, o.used(), o.base ?? labSubnetBase(), o.offset?.())
    try { return start(subnets) } catch (err) {
      const said = `${(err as Error).message ?? ''} ${String((err as { stderr?: unknown }).stderr ?? '')}`
      if (!POOL_OVERLAP.test(said) || attempt >= attempts) throw err
      undo()
    }
  }
}

/** A lab network as a compose file writes it. */
export interface LabNetwork {
  internal: boolean
  enable_ipv6: false
  ipam: { config: [{ subnet: string }] }
  labels?: Record<string, string>
}
export const labNetwork = (internal: boolean, subnet: string): LabNetwork => ({ internal, enable_ipv6: false, ipam: { config: [{ subnet }] } })

const NETWORK_KEYS = ['internal', 'enable_ipv6', 'ipam', 'labels']

/**
 * What is wrong with the networks of a compose file, as written. Each must
 * name one block the lab hands out and nothing more: no gateway, no driver,
 * no option. Whether each is internal is for the caller, who knows which may
 * have a way out.
 */
export function writtenNetworkProblems(networks: Record<string, unknown>, base: string = labSubnetBase()): string[] {
  const p: string[] = []
  const blocks: [string, string][] = []
  for (const [name, value] of Object.entries(networks)) {
    const network = (value ?? {}) as Record<string, unknown>
    for (const key of Object.keys(network)) if (!NETWORK_KEYS.includes(key)) p.push(`network ${name} sets ${key}`)
    if (network.enable_ipv6 !== false) p.push(`network ${name} does not have IPv6 switched off`)
    const subnet = (network.ipam as { config?: { subnet?: unknown }[] } | undefined)?.config?.[0]?.subnet
    if (typeof subnet !== 'string' || JSON.stringify(network.ipam) !== JSON.stringify({ config: [{ subnet }] })) {
      p.push(`network ${name} does not name one block of its own, and only that`)
      continue
    }
    if (!isLabBlock(subnet, base)) p.push(`network ${name} is on ${subnet}, which is not a /${BLOCK_BITS} of ${base}`)
    blocks.push([name, subnet])
  }
  for (const [i, [a, x]] of blocks.entries()) for (const [b, y] of blocks.slice(i + 1)) if (subnetsOverlap(x, y)) p.push(`networks ${a} and ${b} share addresses`)
  return p
}
