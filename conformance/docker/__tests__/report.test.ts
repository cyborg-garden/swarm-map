// @vitest-environment node
//
// How a probe report is judged. The probe itself only runs in a container;
// what counts as a problem is decided here and can be tested anywhere.
import { describe, expect, it } from 'vitest'
import { mountProblems, netProblems, parseReport, secretProblems, writeProblems, type ProbeReport } from '../report.ts'

const closed = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`way out ${i}`, 'ENETUNREACH']))
const sealed: ProbeReport = {
  who: 'cell', uid: 1000, door: 'open', doorRoute: 'open', net: closed, wrongToken: 'refused',
  secrets: [], searched: { files: 20000, procs: 4 },
  writes: { a: 'EROFS', b: 'EACCES', c: 'EACCES', d: 'EROFS', e: 'EACCES', f: 'EROFS' },
  dockerSocket: false, mounts: ['/tmp/smlab ext4'], noNewPrivs: '1', capEff: '0000000000000000', ipv6: [],
}

describe('judging a probe report', () => {
  it('[U:probe-report] a sealed cell has no problems', () => {
    expect([...netProblems(sealed), ...secretProblems(sealed), ...writeProblems(sealed), ...mountProblems(sealed)]).toEqual([])
  })

  it('[U:probe-report] one way out that is open is a problem, and so is one that was not tried', () => {
    expect(netProblems({ ...sealed, net: { ...closed, 'a public address': 'open' } })).toEqual(['reached a public address'])
    expect(netProblems({ ...sealed, net: { ...closed, 'a public address': 'not-tried' } })[0]).toContain('did not try a public address')
    // A probe that tried only a few ways out proves little.
    expect(netProblems({ ...sealed, net: { one: 'ENETUNREACH' } })[0]).toContain('fewer ways out')
  })

  it('[U:probe-report] a probe that could not reach the door says nothing about the rest', () => {
    expect(netProblems({ ...sealed, door: 'ENETUNREACH' })[0]).toContain('could not reach the door')
    expect(netProblems({ ...sealed, doorRoute: 'timeout' })[0]).toContain('could not reach the door')
  })

  it('[U:probe-report] a door that keeps a wrong token on the line, an IPv6 address and a Docker socket are problems', () => {
    expect(netProblems({ ...sealed, wrongToken: 'kept-open' })[0]).toContain('wrong cell token')
    expect(netProblems({ ...sealed, ipv6: ['2001:db8::2'] })).toEqual(['the container has an IPv6 address'])
    expect(netProblems({ ...sealed, dockerSocket: true })).toEqual(['a Docker socket is in the container'])
  })

  it('[U:probe-report] a secret found anywhere is a problem, and a search that covered almost nothing is not a pass', () => {
    expect(secretProblems({ ...sealed, secrets: ['/proc/1/environ'] })).toEqual(['a secret of this run is readable at /proc/1/environ'])
    expect(secretProblems({ ...sealed, searched: { files: 3, procs: 4 } })[0]).toContain('nothing was checked')
    expect(secretProblems({ ...sealed, searched: { files: 20000, procs: 0 } })[0]).toContain('nothing was checked')
  })

  it('[U:probe-report] anything written, root, lost no-new-privileges or a held capability is a problem', () => {
    expect(writeProblems({ ...sealed, writes: { ...sealed.writes, a: 'written' } })).toEqual(['a could be written from inside'])
    expect(writeProblems({ ...sealed, uid: 0 })).toEqual(['the container runs as root'])
    expect(writeProblems({ ...sealed, noNewPrivs: '0' })).toEqual(['no-new-privileges is off'])
    expect(writeProblems({ ...sealed, capEff: '0000000000000002' })[0]).toContain('holds capabilities')
    expect(writeProblems({ ...sealed, writes: { a: 'EROFS' } })[0]).toContain('fewer places')
  })

  it('[U:probe-report] any mount but the shared folder is a problem, and so is no shared folder', () => {
    expect(mountProblems({ ...sealed, mounts: ['/tmp/smlab ext4', '/mnt/host fuse'] })[0]).toContain('/mnt/host')
    expect(mountProblems({ ...sealed, mounts: [] })[0]).toContain('not even the shared folder')
  })

  it('[U:probe-report] output that is not a report is no report', () => {
    expect(parseReport('Error: boom')).toBeUndefined()
    expect(parseReport('')).toBeUndefined()
    expect(parseReport(`noise\n${JSON.stringify(sealed)}\n`)?.who).toBe('cell')
  })
})
