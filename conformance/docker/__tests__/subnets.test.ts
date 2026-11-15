// @vitest-environment node
//
// Which addresses a lab network is given. Docker is never asked here: the
// answers it would give are handed in.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBNET_BASE, inSubnet, labSubnetBase, onFreeSubnets, pickSubnets, SUBNET_BASE_ENV, subnetsOverlap, usedSubnets, writtenNetworkProblems,
} from '../subnets.ts'

const net = (subnet: string, internal = true): Record<string, unknown> => ({ internal, enable_ipv6: false, ipam: { config: [{ subnet }] } })

describe('the range the lab takes its networks from', () => {
  it('[U:lab-subnets] is inside 10.0.0.0/8, where Docker\'s own pools are not, unless a run names another', () => {
    expect(DEFAULT_SUBNET_BASE).toBe('10.213.0.0/16')
    expect(labSubnetBase({})).toBe(DEFAULT_SUBNET_BASE)
    expect(labSubnetBase({ [SUBNET_BASE_ENV]: '10.99.128.0/20' })).toBe('10.99.128.0/20')
    for (const pool of ['172.17.0.0/16', '172.31.0.0/16', '192.168.0.0/16']) expect(subnetsOverlap(DEFAULT_SUBNET_BASE, pool), pool).toBe(false)
  })

  it('[U:lab-subnets] refuses a range that is not a private block of 10.0.0.0/8, written exactly', () => {
    for (const bad of ['', '10.213.0.0', '172.20.0.0/16', '192.168.0.0/16', '203.0.113.0/24', '0.0.0.0/0', '10.0.0.0/7', '10.213.0.0/26', '10.213.0.1/16', '10.213.0.0/16;x', '10.213.0.0/16 ', '10.213.00.0/16', '10.256.0.0/16', 'fd00::/64']) {
      expect(() => labSubnetBase({ [SUBNET_BASE_ENV]: bad }), bad).toThrow(/^REFUSING TO RUN: F5 /)
    }
  })
})

describe('picking blocks for one rig', () => {
  it('[U:lab-subnets] gives /28 blocks of the range that share no address with each other', () => {
    const picked = pickSubnets(3, [], DEFAULT_SUBNET_BASE, 0)
    expect(picked).toEqual(['10.213.0.0/28', '10.213.0.16/28', '10.213.0.32/28'])
    const many = pickSubnets(40, [], DEFAULT_SUBNET_BASE, 4090)
    expect(new Set(many).size).toBe(40)
    for (const s of many) expect(s).toMatch(/^10\.213\.\d+\.\d+\/28$/)
    for (const [i, a] of many.entries()) for (const b of many.slice(i + 1)) expect(subnetsOverlap(a, b), `${a} ${b}`).toBe(false)
    // It wraps round the end of the range.
    expect(many.slice(0, 7)).toEqual(['10.213.255.160/28', '10.213.255.176/28', '10.213.255.192/28', '10.213.255.208/28', '10.213.255.224/28', '10.213.255.240/28', '10.213.0.0/28'])
  })

  it('[U:lab-subnets] never gives a block that shares an address with one already in use, whatever its size', () => {
    const used = ['10.213.0.0/28', '10.213.0.40/29', '10.213.1.0/24', '10.0.0.0/9', '172.18.0.0/16', '192.168.65.3/24', 'fd00::/64', 'nonsense']
    const picked = pickSubnets(4, used, '10.213.0.0/22', 0)
    expect(picked).toEqual(['10.213.0.16/28', '10.213.0.48/28', '10.213.0.64/28', '10.213.0.80/28'])
    for (const p of picked) for (const u of used) expect(subnetsOverlap(p, u), `${p} ${u}`).toBe(false)
    // A network that covers the whole range leaves nothing.
    expect(() => pickSubnets(1, ['10.128.0.0/9'], DEFAULT_SUBNET_BASE, 0)).toThrow(/^REFUSING TO RUN: S0 .*no free/)
    // Fifteen of sixteen blocks taken: one can be had, two cannot.
    const fifteen = pickSubnets(15, [], '10.213.0.0/24', 0)
    expect(pickSubnets(1, fifteen, '10.213.0.0/24', 7)).toEqual(['10.213.0.240/28'])
    expect(() => pickSubnets(2, fifteen, '10.213.0.0/24', 7)).toThrow(/^REFUSING TO RUN: S0 .*SWARMLAB_SUBNET_BASE/)
  })

  it('[U:lab-subnets] two runs do not start from the same place', () => {
    const starts = new Set(Array.from({ length: 30 }, () => pickSubnets(1, [], DEFAULT_SUBNET_BASE)[0]))
    expect(starts.size).toBeGreaterThan(20)
  })

  it('[U:lab-subnets] says whether an address is in a block', () => {
    expect(inSubnet('10.213.0.18', '10.213.0.16/28')).toBe(true)
    expect(inSubnet('10.213.0.32', '10.213.0.16/28')).toBe(false)
    expect(inSubnet('172.20.0.3', '10.213.0.16/28')).toBe(false)
    expect(inSubnet('', '10.213.0.16/28')).toBe(false)
  })
})

describe('what is already in use on this Docker', () => {
  it('[U:lab-subnets] is every IPv4 block of every network Docker lists, and those of this machine\'s own interfaces', () => {
    const asked: string[][] = []
    const docker = (args: string[]): { ok: boolean; out: string } => {
      asked.push(args)
      if (args[1] === 'ls') return { ok: true, out: 'aaa\nbbb\nccc\n' }
      // One network went away between the two questions: Docker says so, and still answers for the others.
      return { ok: false, out: '172.17.0.0/16\n\n10.213.0.16/28\nfd00:1::/64\nError response from daemon: network ccc not found\n' }
    }
    expect(usedSubnets(docker, ['192.168.1.20/24'])).toEqual(['172.17.0.0/16', '10.213.0.16/28', '192.168.1.20/24'])
    expect(asked[0]).toEqual(['network', 'ls', '--quiet'])
    expect(asked[1].slice(0, 2)).toEqual(['network', 'inspect'])
    expect(asked[1].slice(-3)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('[U:lab-subnets] a Docker that cannot list its networks is not taken to have none', () => {
    expect(() => usedSubnets(() => ({ ok: false, out: 'Cannot connect to the Docker daemon' }), [])).toThrow(/^REFUSING TO RUN: S0 /)
  })
})

describe('starting on blocks that are free', () => {
  const overlap = new Error('Command failed: docker compose up\n failed to create network smlab-deadbeef_cell: Error response from daemon: invalid pool request: Pool overlaps with other one on this address space')

  it('[U:lab-subnets] picks from what is free at that moment and starts once', () => {
    const calls: string[][] = []
    const got = onFreeSubnets({ count: 2, used: () => ['10.213.0.0/28'], base: '10.213.0.0/24', offset: () => 0 }, (subnets) => { calls.push(subnets); return 'up' }, () => { throw new Error('nothing to undo') })
    expect(got).toBe('up')
    expect(calls).toEqual([['10.213.0.16/28', '10.213.0.32/28']])
  })

  it('[U:lab-subnets] when another run took a block first, it undoes what it made, reads again and picks others', () => {
    const used = ['10.213.0.0/28']
    const calls: string[][] = []
    let undone = 0
    const got = onFreeSubnets({ count: 2, used: () => [...used], base: '10.213.0.0/24', offset: () => 0 }, (subnets) => {
      calls.push(subnets)
      if (calls.length === 1) { used.push('10.213.0.16/28'); throw overlap }
      return subnets
    }, () => { undone++ })
    expect(undone).toBe(1)
    expect(calls).toEqual([['10.213.0.16/28', '10.213.0.32/28'], ['10.213.0.32/28', '10.213.0.48/28']])
    expect(got).toEqual(['10.213.0.32/28', '10.213.0.48/28'])
  })

  it('[U:lab-subnets] gives up after a few tries, and any other failure is not retried', () => {
    let tries = 0
    let undone = 0
    expect(() => onFreeSubnets({ count: 1, used: () => [], base: '10.213.0.0/24' }, () => { tries++; throw overlap }, () => { undone++ })).toThrow(/Pool overlaps/)
    expect([tries, undone]).toEqual([5, 4])
    tries = 0
    expect(() => onFreeSubnets({ count: 1, used: () => [], base: '10.213.0.0/24' }, () => { tries++; throw new Error('no such image') }, () => { undone++ })).toThrow('no such image')
    expect([tries, undone]).toEqual([1, 4])
  })
})

describe('a network as it is written down', () => {
  const good = { cell: net('10.213.0.0/28'), outside: net('10.213.0.16/28') }

  it('[U:lab-subnets] passes networks that each name one /28 of the lab\'s range and nothing else', () => {
    expect(writtenNetworkProblems(good, DEFAULT_SUBNET_BASE)).toEqual([])
    expect(writtenNetworkProblems({ ...good, egress: { ...net('10.213.9.240/28', false), labels: { a: 'b' } } }, DEFAULT_SUBNET_BASE)).toEqual([])
  })

  it.each([
    ['no block named', { internal: true, enable_ipv6: false }, /network cell does not name one block of its own/],
    ['two blocks', { ...net('10.213.0.0/28'), ipam: { config: [{ subnet: '10.213.0.0/28' }, { subnet: '10.213.0.64/28' }] } }, /does not name one block/],
    ['a gateway of its own choosing', { ...net('10.213.0.0/28'), ipam: { config: [{ subnet: '10.213.0.0/28', gateway: '10.213.0.1' }] } }, /does not name one block/],
    ['another address driver', { ...net('10.213.0.0/28'), ipam: { driver: 'x', config: [{ subnet: '10.213.0.0/28' }] } }, /does not name one block/],
    ['one of Docker\'s own pools', net('172.20.0.0/28'), /network cell is on 172\.20\.0\.0\/28, which is not a \/28 of 10\.213\.0\.0\/16/],
    ['a block outside the range', net('10.214.0.0/28'), /not a \/28 of/],
    ['a block that is too big', net('10.213.0.0/24'), /not a \/28 of/],
    ['a block that does not start where a /28 starts', net('10.213.0.8/28'), /not a \/28 of/],
    ['IPv6 switched on', { ...net('10.213.0.0/28'), enable_ipv6: true }, /network cell does not have IPv6 switched off/],
    ['driver options', { ...net('10.213.0.0/28'), driver_opts: { 'com.docker.network.bridge.gateway_mode_ipv4': 'routed' } }, /network cell sets driver_opts/],
    ['another driver', { ...net('10.213.0.0/28'), driver: 'macvlan' }, /network cell sets driver/],
    ['a network made elsewhere', { ...net('10.213.0.0/28'), external: true }, /network cell sets external/],
  ] as [string, Record<string, unknown>, RegExp][])('[U:lab-subnets] refuses %s', (_what, cell, why) => {
    expect(writtenNetworkProblems({ ...good, cell }, DEFAULT_SUBNET_BASE).join('; ')).toMatch(why)
  })

  it('[U:lab-subnets] refuses two networks that share addresses', () => {
    expect(writtenNetworkProblems({ cell: net('10.213.0.0/28'), outside: net('10.213.0.0/28') }, DEFAULT_SUBNET_BASE)).toEqual(['networks cell and outside share addresses'])
  })
})
