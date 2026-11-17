// @vitest-environment node
//
// How a probe report is judged. The probe itself only runs in a container;
// what counts as a problem is decided here and can be tested anywhere.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostConfigProblems, mountProblems, mountsSeen, netProblems, networkProblems, parseReport, readReport, secretProblems, tmpProblems, tmpSeen, tmpSeenProblems, writeProblems, type DockerNetwork, type HostConfig, type ProbeReport } from '../report.ts'

const closed = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`way out ${i}`, 'ENETUNREACH']))
const sealed: ProbeReport = {
  who: 'cell', uid: 1000, door: 'open', doorRoute: 'open', net: closed, wrongToken: 'refused',
  secrets: [], searched: { files: 20000, procs: 4 },
  writes: { a: 'EROFS', b: 'EACCES', c: 'EACCES', d: 'EROFS', e: 'EACCES', f: 'EROFS' },
  dockerSocket: false, mounts: ['/tmp/smlab ext4'], tmp: 'tmpfs rw,nosuid,nodev,noexec,relatime,rw,size=32768k,mode=1777', noNewPrivs: '1', capEff: '0000000000000000', ipv6: [], defaultRoutes: [],
}

describe('judging a probe report', () => {
  it('[U:probe-report] a sealed cell has no problems', () => {
    expect([...netProblems(sealed), ...secretProblems(sealed), ...writeProblems(sealed), ...mountProblems(sealed), ...tmpSeenProblems(sealed)]).toEqual([])
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

  it('[U:probe-report] a route off the container\'s own network is a problem, and so is a probe that did not read the routes', () => {
    expect(netProblems({ ...sealed, defaultRoutes: ['to 0.0.0.0 via 10.213.0.1 on eth0'] })).toEqual(['the container has a route off its own network (to 0.0.0.0 via 10.213.0.1 on eth0)'])
    expect(netProblems({ ...sealed, defaultRoutes: ['the routes could not be read'] })).toHaveLength(1)
    const older: Partial<ProbeReport> = { ...sealed }
    delete older.defaultRoutes
    expect(netProblems(older as ProbeReport)).toEqual(['the probe did not read the container\'s routes'])
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

  it('[U:probe-report] the mounts a probe reports: every one but those in memory or Docker\'s own, and the shared folder whatever it is', () => {
    const line = (at: string, type: string): string => `36 25 0:1 / ${at} rw,relatime - ${type} ${type} rw`
    const seen = mountsSeen([line('/', 'overlay'), line('/proc', 'proc'), line('/tmp', 'tmpfs'), line('/etc/hosts', 'ext4'), line('/tmp/smlab/work', 'tmpfs'), line('/mnt/host', 'fuse')])
    expect(seen).toEqual(['/mnt/host fuse'])
    // The shared folder is reported on Docker's disk, and in memory too: the launcher's cell keeps it in memory with a size.
    expect(mountsSeen([line('/tmp/smlab', 'ext4')])).toEqual(['/tmp/smlab ext4'])
    expect(mountsSeen([line('/tmp/smlab', 'tmpfs'), line('/tmp/smlab/work', 'tmpfs')])).toEqual(['/tmp/smlab tmpfs'])
    expect(mountProblems({ ...sealed, mounts: mountsSeen([line('/tmp/smlab', 'tmpfs')]) })).toEqual([])
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

// What Docker itself says a network is, read from outside with `docker network inspect`.
describe('judging the network Docker made against the one written down', () => {
  const written = { internal: true, subnet: '10.213.0.16/28' }
  // As Docker 29 reports a network that compose made from a file naming one block.
  const made: DockerNetwork = {
    Driver: 'bridge', Internal: true, EnableIPv6: false, IPAM: { Config: [{ Subnet: '10.213.0.16/28', Gateway: '10.213.0.17' }] },
    Options: { 'com.docker.network.enable_ipv4': 'true' },
  }
  const judge = (over: Partial<DockerNetwork>, w = written): string[] => networkProblems('smlab-deadbeef_cell', w, { ...made, ...over })

  it('[U:docker-network] the network that was written has no problems', () => {
    expect(judge({})).toEqual([])
    expect(judge({ Options: null })).toEqual([])
    expect(judge({ Options: { 'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false' } })).toEqual([])
    expect(judge({ Internal: false }, { internal: false, subnet: written.subnet })).toEqual([])
  })

  it('[U:docker-network] a network on another block, on two, or on none is not the one written', () => {
    expect(judge({ IPAM: { Config: [{ Subnet: '172.22.0.0/16', Gateway: '172.22.0.1' }] } })).toEqual([
      'network smlab-deadbeef_cell was made on 172.22.0.0/16, not on 10.213.0.16/28 as written',
      'network smlab-deadbeef_cell has a gateway outside its block (172.22.0.1)',
    ])
    expect(judge({ IPAM: { Config: [{ Subnet: '10.213.0.32/28', Gateway: '10.213.0.33' }] } })[0]).toContain('was made on 10.213.0.32/28, not on 10.213.0.16/28')
    expect(judge({ IPAM: { Config: [{ Subnet: '10.213.0.16/28' }, { Subnet: '10.213.0.64/28' }] } })[0]).toContain('was made on 10.213.0.16/28 and 10.213.0.64/28')
    expect(judge({ IPAM: { Config: null } })[0]).toContain('was made on no block')
    expect(judge({ IPAM: null })[0]).toContain('was made on no block')
    expect(networkProblems('smlab-deadbeef_cell', written, undefined)).toEqual(['network smlab-deadbeef_cell is not there, so it was not compared with what was written'])
  })

  it('[U:docker-network] a way out that was not written, a gateway from elsewhere, IPv6, another driver or an option is a problem', () => {
    expect(judge({ Internal: false })).toEqual(['network smlab-deadbeef_cell is not internal'])
    expect(judge({}, { internal: false, subnet: written.subnet })).toEqual(['network smlab-deadbeef_cell is internal, and was written with a way out'])
    expect(judge({ IPAM: { Config: [{ Subnet: '10.213.0.16/28', Gateway: '192.168.65.1' }] } })).toEqual(['network smlab-deadbeef_cell has a gateway outside its block (192.168.65.1)'])
    expect(judge({ IPAM: { Config: [{ Subnet: '10.213.0.16/28', IPRange: '10.213.0.24/29' }] } })[0]).toContain('a range of its own')
    expect(judge({ IPAM: { Config: [{ Subnet: '10.213.0.16/28', AuxiliaryAddresses: { host: '10.213.0.20' } }] } })[0]).toContain('sets aside addresses')
    expect(judge({ EnableIPv6: true })).toEqual(['network smlab-deadbeef_cell has IPv6 switched on'])
    expect(judge({ Driver: 'macvlan' })).toEqual(['network smlab-deadbeef_cell is made by another driver (macvlan)'])
    expect(judge({ Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'routed' } })).toEqual(['network smlab-deadbeef_cell was given an option (com.docker.network.bridge.gateway_mode_ipv4=routed)'])
    expect(judge({ Options: { 'com.docker.network.enable_ipv6': 'true' } })[0]).toContain('was given an option')
  })
})

describe('judging a container\'s /tmp', () => {
  const line = (where: string, mountOptions: string, type: string, superOptions: string) => `36 35 0:30 / ${where} ${mountOptions} - ${type} ${type} ${superOptions}`

  it('[U:tmp] reads /tmp out of mountinfo: its type, its own options and the file system\'s', () => {
    const lines = [line('/', 'ro,relatime', 'overlay', 'rw'), line('/tmp', 'rw,nosuid,nodev,noexec,relatime', 'tmpfs', 'rw,size=32768k,mode=1777'), line('/tmp/smlab', 'rw', 'tmpfs', 'rw,size=262144k')]
    expect(tmpSeen(lines)).toBe('tmpfs rw,nosuid,nodev,noexec,relatime,rw,size=32768k,mode=1777')
    expect(tmpSeen([line('/', 'ro', 'overlay', 'rw')])).toBe('')
  })

  it('[U:tmp] a /tmp in memory, at its size or smaller, that runs nothing, has no problems, whichever way its size is written', () => {
    for (const o of ['size=32m,mode=1777,noexec,nosuid,nodev', 'rw,nosuid,nodev,noexec,size=32768k', 'size=33554432,noexec,nosuid,nodev', 'size=8m,noexec,nosuid,nodev']) {
      expect(tmpProblems(o, 'x', 'kernel'), o).toEqual([])
      expect(tmpProblems(o, 'x', 'docker'), o).toEqual([])
    }
    // Docker mounts a tmpfs noexec, nosuid and nodev unless asked otherwise, and writes only what it was asked.
    expect(tmpProblems('size=32m,mode=1777', 'x', 'docker')).toEqual([])
  })

  it('[U:tmp] a /tmp with no size, a bigger one, or one that can run a file, be setuid or hold a device, is a problem', () => {
    expect(tmpProblems(undefined, 'as Docker made it', 'docker')).toEqual(['as Docker made it: /tmp is not a mount of its own'])
    // What Docker writes for a tmpfs it was asked for with no options at all.
    expect(tmpProblems('', 'x', 'docker')).toEqual(['x: /tmp has no size'])
    expect(tmpProblems('rw,noexec,nosuid,nodev', 'x', 'kernel')).toEqual(['x: /tmp has no size'])
    expect(tmpProblems('size=33m,noexec,nosuid,nodev', 'x', 'kernel')).toEqual(['x: /tmp is 33 MB, more than its 32 MB'])
    expect(tmpProblems('size=1g,noexec,nosuid,nodev', 'x', 'docker')).toEqual(['x: /tmp is 1024 MB, more than its 32 MB'])
    expect(tmpProblems('size=32m,nosuid,nodev', 'x', 'kernel')).toEqual(['x: /tmp is not noexec'])
    expect(tmpProblems('size=32m,noexec,nodev', 'x', 'kernel')).toEqual(['x: /tmp is not nosuid'])
    expect(tmpProblems('size=32m,noexec,nosuid', 'x', 'kernel')).toEqual(['x: /tmp is not nodev'])
    expect(tmpProblems('size=32m,exec', 'x', 'docker')).toEqual(['x: /tmp is not noexec'])
    expect(tmpProblems('size=32m,suid,dev', 'x', 'docker')).toEqual(['x: /tmp is not nosuid', 'x: /tmp is not nodev'])
    // A size in a word that only looks like one is no size.
    expect(tmpProblems('xsize=1m,noexec,nosuid,nodev', 'x', 'kernel')).toEqual(['x: /tmp has no size'])
  })

  it('[U:tmp] from inside: /tmp on a disk, not in memory, or not reported at all, is a problem', () => {
    expect(tmpSeenProblems({ ...sealed, tmp: 'ext4 rw,noexec,nosuid,nodev,size=1m' })).toEqual(['inside the container: /tmp is not in memory (ext4)'])
    expect(tmpSeenProblems({ ...sealed, tmp: '' })).toEqual(['inside the container: /tmp is not a mount of its own'])
    expect(tmpSeenProblems({ ...sealed, tmp: undefined as never })).toEqual(['inside the container: the probe did not report /tmp, so it was not checked'])
    expect(tmpSeenProblems({ ...sealed, tmp: 'tmpfs rw,nosuid,nodev,noexec,relatime,rw,size=8126464k,mode=1777' })).toEqual(['inside the container: /tmp is 7936 MB, more than its 32 MB'])
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
