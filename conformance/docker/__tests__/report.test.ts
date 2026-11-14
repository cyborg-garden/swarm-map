// @vitest-environment node
//
// How a probe report is judged. The probe itself only runs in a container;
// what counts as a problem is decided here and can be tested anywhere.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostConfigProblems, mountProblems, netProblems, parseReport, readReport, secretProblems, writeProblems, type HostConfig, type ProbeReport } from '../report.ts'

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

  it('[U:probe-report] a probe file is read only if it is a plain file: a link the cell left there is not followed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-report-'))
    try {
      writeFileSync(path.join(dir, 'real.json'), JSON.stringify(sealed) + '\n')
      symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'link.json'))
      expect(readReport(path.join(dir, 'real.json'))?.who).toBe('cell')
      expect(readReport(path.join(dir, 'link.json'))).toBeUndefined()
      expect(readReport(path.join(dir, 'missing.json'))).toBeUndefined()
      expect(readReport(dir)).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// What Docker itself says it gave the container, read from outside with `docker inspect`.
describe('judging what Docker says a container was given', () => {
  const given: HostConfig = {
    NetworkMode: 'smlab-deadbeef_cell', PidMode: '', IpcMode: 'private', UsernsMode: '', UTSMode: '', Privileged: false, PublishAllPorts: false,
    PortBindings: {}, ExtraHosts: null, Dns: null, Links: null, VolumesFrom: null, Devices: null, CapAdd: null, CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'], Binds: null,
  }
  const judge = (over: Partial<HostConfig>) => hostConfigProblems({ ...given, ...over }, 'smlab-deadbeef_cell')

  it('[U:host-config] a sealed cell has no problems', () => {
    expect(judge({})).toEqual({ net: [], privilege: [], mounts: [] })
    // Docker reports "nothing" as null, as an empty list or as an empty map, depending on the field and the version.
    expect(judge({ PortBindings: null, ExtraHosts: [], CapAdd: [], Devices: [] })).toEqual({ net: [], privilege: [], mounts: [] })
  })

  it('[U:host-config] a published port, another network mode, an added host name or resolver is a way out', () => {
    expect(judge({ PortBindings: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } }).net).toEqual(['a port is published (8080/tcp)'])
    expect(judge({ PublishAllPorts: true }).net).toEqual(['every exposed port is published'])
    expect(judge({ NetworkMode: 'host' }).net).toEqual(['the network mode is host'])
    expect(judge({ NetworkMode: 'container:abc' }).net[0]).toContain('container:abc')
    expect(judge({ ExtraHosts: ['h:192.0.2.1'] }).net).toEqual(['a host name was added (h:192.0.2.1)'])
    expect(judge({ Dns: ['192.0.2.1'] }).net).toEqual(['a resolver was set (192.0.2.1)'])
    expect(judge({ Links: ['/a:/b'] }).net[0]).toContain('linked')
  })

  it('[U:host-config] a shared namespace, an added capability, a lost hardening setting or a device is a privilege', () => {
    expect(judge({ PidMode: 'host' }).privilege).toEqual(['the process namespace is shared (host)'])
    expect(judge({ PidMode: 'container:abc' }).privilege[0]).toContain('container:abc')
    expect(judge({ IpcMode: 'host' }).privilege).toEqual(['the IPC namespace is shared (host)'])
    expect(judge({ IpcMode: 'shareable' }).privilege[0]).toContain('shareable')
    expect(judge({ UsernsMode: 'host' }).privilege[0]).toContain('user namespace')
    expect(judge({ UTSMode: 'host' }).privilege[0]).toContain('host name namespace')
    expect(judge({ Privileged: true }).privilege).toEqual(['the container is privileged'])
    expect(judge({ CapAdd: ['NET_RAW'] }).privilege).toEqual(['capabilities were added (NET_RAW)'])
    expect(judge({ CapDrop: [] }).privilege).toEqual(['not every capability was dropped'])
    expect(judge({ CapDrop: null }).privilege).toEqual(['not every capability was dropped'])
    expect(judge({ SecurityOpt: null }).privilege).toEqual(['no-new-privileges is not set'])
    expect(judge({ SecurityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] }).privilege).toEqual(['a security option was changed (seccomp=unconfined)'])
    expect(judge({ Devices: [{ PathOnHost: '/dev/kmsg' }] }).privilege[0]).toContain('device')
  })

  it('[U:host-config] a host folder or another container\'s volumes are mounts', () => {
    expect(judge({ Binds: ['/home/x:/mnt/host:ro'] }).mounts).toEqual(['a host path is bound (/home/x:/mnt/host:ro)'])
    expect(judge({ VolumesFrom: ['other'] }).mounts).toEqual(['volumes are taken from another container (other)'])
    // The rig's own named volume is not a host path.
    expect(judge({ Binds: ['smlab-deadbeef_lab:/tmp/smlab:rw'] }).mounts).toEqual([])
  })
})
