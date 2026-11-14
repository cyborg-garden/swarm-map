// @vitest-environment node
//
// What the rig's compose file must say before Docker is ever asked to start
// it. These run in CI with no Docker: they read the rendered file. Whether
// Docker then does what the file says is what the Docker suite is for.
import { describe, expect, it } from 'vitest'
import { PROJECT_NAME, RefusingToRun } from '../../guards/preflight.ts'
import { LETTA_CODE_CELL } from '../cells.ts'
import { assertSealed, probeArgs, renderRig, rigEnv, RIG_VARIANTS, type RigOptions } from '../compose.ts'

const nonce = 'deadbeef'
const base: RigOptions = { nonce, brainToken: `BRAIN-${nonce}-0123456789abcdef`, check: 'C1', variant: 'good', sinkIp: '10.0.0.9', hostPort: 4444 }
const rig = (over: Partial<RigOptions> = {}) => renderRig({ ...base, ...over })

describe('the sealed rig', () => {
  const { project, file } = rig()

  it('[U:rig-compose] is a lab project, and every image is a lab image that is never pulled', () => {
    expect(project).toMatch(PROJECT_NAME)
    expect(file.name).toBe(project)
    for (const [name, service] of Object.entries(file.services)) {
      expect(service.image, name).toMatch(/^smlab-(cell|rig):/)
      expect(service.pull_policy, name).toBe('never')
      expect(service.restart, name).toBe('no')
    }
  })

  it('[U:rig-compose] has no network with a route out, and the cell is on one network only', () => {
    expect(Object.keys(file.networks).sort()).toEqual(['cell', 'outside'])
    for (const [name, network] of Object.entries(file.networks)) {
      expect(network.internal, name).toBe(true)
      expect(network.enable_ipv6, name).toBe(false)
    }
    expect(file.services.cell.networks).toEqual(['cell'])
    expect(file.services.door.networks).toEqual(['cell'])
    // The sink stands in for the internet. Only the control can reach it.
    expect(file.services.sink.networks).toEqual(['outside'])
    expect(file.services.control.networks).toEqual(['outside'])
  })

  it('[U:rig-compose] publishes no port, mounts nothing from the host, and names no Docker socket', () => {
    const text = JSON.stringify(file)
    expect(text).not.toContain('docker.sock')
    for (const [name, service] of Object.entries(file.services)) {
      expect(Object.keys(service), name).not.toContain('ports')
      expect(Object.keys(service), name).not.toContain('extra_hosts')
      expect(Object.keys(service), name).not.toContain('network_mode')
      expect(Object.keys(service), name).not.toContain('privileged')
      expect(Object.keys(service), name).not.toContain('cap_add')
      expect(Object.keys(service), name).not.toContain('env_file')
      for (const mount of service.volumes ?? []) expect(mount, name).toMatch(/^lab:\/tmp\/smlab(:ro)?$/)
    }
    // The one shared folder: the cell writes it, the sidecar only reads it.
    expect(file.services.cell.volumes).toEqual(['lab:/tmp/smlab'])
    expect(file.services.door.volumes).toEqual(['lab:/tmp/smlab:ro'])
    expect(file.services.sink.volumes).toBeUndefined()
  })

  it('[U:rig-compose] hardens the cell', () => {
    const cell = file.services.cell
    expect(cell.read_only).toBe(true)
    expect(cell.cap_drop).toEqual(['ALL'])
    expect(cell.security_opt).toEqual(['no-new-privileges:true'])
    expect(cell.user).toBe('node')
    expect(cell.sysctls).toMatchObject({ 'net.ipv6.conf.all.disable_ipv6': '1' })
    expect(cell.pids_limit).toBeGreaterThan(0)
    expect(cell.mem_limit).toBe('1g')
  })

  it('[U:rig-compose] gives the cell a cell token and nothing else that is secret', () => {
    const env = file.services.cell.environment
    expect(Object.keys(env).sort()).toEqual(['SMLAB_GATE', 'SMLAB_VERDICT_MS', 'SMLAB_VETO_MS', 'SWARMLAB_BRAIN', 'SWARMLAB_NONCE'])
    expect(JSON.stringify(file.services.cell)).not.toContain(`UPSTREAM-${nonce}`)
    expect(JSON.stringify(file)).not.toContain(`FAKECHAT-${nonce}`)
    // The model key and the chat token are minted inside the sidecar. Nothing hands them to any container.
    expect(JSON.stringify(file)).not.toContain(`UPSTREAM-${nonce}`)
  })

  it('[U:rig-compose] passes its own seal check, and so does no broken variant', () => {
    expect(() => assertSealed(rig())).not.toThrow()
    expect(RIG_VARIANTS).toEqual(['good', 'route-out', 'open', 'leaks-env', 'leaks-file', 'writable', 'host-mount', 'socket', 'blind-sink', 'door-out'])
    for (const variant of RIG_VARIANTS.filter((v) => v !== 'good')) {
      expect(() => assertSealed(rig({ variant })), variant).toThrow(RefusingToRun)
    }
  })

  it('[U:rig-compose] the seal check refuses every setting that shares something with the host or another container', () => {
    const settings: Record<string, unknown> = {
      ports: ['8080:8080'], privileged: true, network_mode: 'host', pid: 'host', ipc: 'host', userns_mode: 'host', uts: 'host', cgroup: 'host',
      volumes_from: ['door'], links: ['sink'], external_links: ['x'], extra_hosts: ['h:192.0.2.1'], dns: ['192.0.2.1'], devices: ['/dev/null:/dev/x'],
      cap_add: ['NET_RAW'], group_add: ['0'], env_file: ['x'], runtime: 'x', secrets: ['x'], configs: ['x'],
    }
    for (const [key, value] of Object.entries(settings)) {
      for (const service of ['cell', 'door'] as const) {
        const broken = rig()
        Object.assign(broken.file.services[service], { [key]: value })
        expect(() => assertSealed(broken), `${service} ${key}`).toThrow(new RegExp(`service ${service} sets ${key}`))
      }
    }
  })

  it('[U:rig-compose] the seal check refuses a cell that lost a hardening setting, or runs another command', () => {
    const edits: [string, (cell: Record<string, unknown>) => void][] = [
      ['capabilities', (cell) => { cell.cap_drop = [] }],
      ['no-new-privileges', (cell) => { cell.security_opt = ['seccomp:unconfined'] }],
      ['no-new-privileges', (cell) => { cell.security_opt = ['no-new-privileges:true', 'seccomp:unconfined'] }],
      ['IPv6', (cell) => { cell.sysctls = {} }],
      ['command', (cell) => { cell.command = ['sh', '-c', 'true'] }],
    ]
    for (const [what, edit] of edits) {
      const broken = rig()
      edit(broken.file.services.cell as unknown as Record<string, unknown>)
      expect(() => assertSealed(broken), what).toThrow(new RegExp(what))
    }
    // The sidecar's side has no route out in the rig either, and only reads the shared folder.
    const out = rig(); out.file.services.door.networks.push('outside')
    expect(() => assertSealed(out)).toThrow(/the sidecar is on cell and outside/)
    const rw = rig(); rw.file.services.door.volumes = ['lab:/tmp/smlab']
    expect(() => assertSealed(rw)).toThrow(/the sidecar can write the shared folder/)
  })
})

describe('each broken rig is broken in one named way', () => {
  it('[U:rig-compose] route-out: the cell is also put on the network the sink is on', () => {
    expect(rig({ variant: 'route-out' }).file.services.cell.networks).toEqual(['cell', 'outside'])
  })

  it('[U:rig-compose] open: the cell is also put on an ordinary network, the only one that is not internal', () => {
    const { file } = rig({ variant: 'open' })
    expect(file.services.cell.networks).toEqual(['cell', 'open'])
    expect(file.networks.open.internal).toBe(false)
    expect(file.services.door.networks).toEqual(['cell'])
  })

  it('[U:rig-compose] leaks-env: the model key of this run is planted in the cell', () => {
    expect(rig({ variant: 'leaks-env' }).file.services.cell.environment.SWARMLAB_LEAK).toBe(`UPSTREAM-${nonce}`)
  })

  it('[U:rig-compose] writable: the cell runs as root on a disk it can write', () => {
    const cell = rig({ variant: 'writable' }).file.services.cell
    expect(cell.user).toBe('0')
    expect(cell.read_only).toBe(false)
    expect(cell.cap_add).toEqual(['DAC_OVERRIDE'])
  })

  it('[U:rig-compose] host-mount: a folder of this machine is mounted into the cell', () => {
    expect(rig({ variant: 'host-mount', hostDir: '/tmp/x' }).file.services.cell.volumes).toEqual(['lab:/tmp/smlab', '/tmp/x:/mnt/host:ro'])
  })

  it('[U:rig-compose] leaks-file: the model key is written to a file in the cell, and is in no environment and no command line', () => {
    const { file } = rig({ variant: 'leaks-file' })
    const cell = file.services.cell
    expect(cell.command[0]).toBe('sh')
    expect(cell.command.join(' ')).toContain(`> /tmp/leak-${nonce}`)
    // Written in two halves, so the key is not in the command line of any process: only the file holds it.
    expect(JSON.stringify(file)).not.toContain(`UPSTREAM-${nonce}`)
    expect(cell.environment).toEqual(rig().file.services.cell.environment)
    expect(cell.command.join(' ')).toContain('exec node /opt/swarm/conformance/docker/cell-main.ts')
  })

  it('[U:rig-compose] socket: something is mounted where a Docker socket would be', () => {
    expect(rig({ variant: 'socket', hostDir: '/tmp/x' }).file.services.cell.volumes).toEqual(['lab:/tmp/smlab', '/tmp/x/docker.sock:/var/run/docker.sock:ro'])
  })

  it('[U:rig-compose] door-out: the sidecar is also put on the network the sink is on, and the cell is not', () => {
    const { file } = rig({ variant: 'door-out' })
    expect(file.services.door.networks).toEqual(['cell', 'outside'])
    expect(file.services.cell).toEqual(rig().file.services.cell)
  })

  it('[U:rig-compose] blind-sink: the control is put where it cannot reach the sink', () => {
    expect(rig({ variant: 'blind-sink' }).file.services.control.networks).toEqual(['cell'])
  })

  it('[U:rig-compose] removing the gate changes nothing about the wall: only what is loaded inside differs', () => {
    const { file } = rig({ gate: 'allows-all' })
    expect(rig().file.services.cell.environment.SMLAB_GATE).toBe('real')
    expect(file.services.cell.environment.SMLAB_GATE).toBe('allows-all')
    expect({ ...file.services.cell, environment: {} }).toEqual({ ...rig().file.services.cell, environment: {} })
    expect(file.networks).toEqual(rig().file.networks)
    expect(() => assertSealed({ project: 'x', file })).not.toThrow()
  })
})

describe('F2 for a rig: what every container is handed', () => {
  it('[U:rig-compose] lists the environment of every service, by service', () => {
    const env = rigEnv(rig().file)
    expect(Object.keys(env).sort()).toEqual(['cell', 'control', 'door', 'sink'])
    expect(env.cell.SWARMLAB_NONCE).toBe(nonce)
  })

  it('[U:rig-compose] a rig handed a real-looking key is refused before a file is rendered', () => {
    // Minted here so no key-shaped string is ever committed.
    const shaped = ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-')
    expect(() => rig({ extraCellEnv: { NOTES: shaped } })).toThrow(/^REFUSING TO RUN: F2 .*NOTES/)
    expect(() => rig({ extraCellEnv: { OPENAI_API_KEY: 'x' } })).toThrow(/^REFUSING TO RUN: F2 .*OPENAI_API_KEY/)
    // A fake of another run is not this run's fake.
    expect(() => rig({ extraCellEnv: { SWARMLAB_LEAK: 'UPSTREAM-0badf00d' } })).toThrow(RefusingToRun)
  })

  it('[U:rig-compose] the probe is handed addresses and a port, and nothing that is not one', () => {
    const targets = { hostIp: '192.0.2.1', publicIp: '192.0.2.2', resolverIp: '192.0.2.3', resolverIp6: '2001:db8::1' }
    expect(rig({ targets }).file.services.door.environment.SMLAB_PROBE_ARGS)
      .toBe('nonce=deadbeef sink=10.0.0.9 hostport=4444 hostip=192.0.2.1 public=192.0.2.2 resolver=192.0.2.3 resolver6=2001:db8::1')
    // The harness runs this as a command line, so nothing else may ride along.
    expect(() => rig({ targets: { ...targets, publicIp: '192.0.2.2; touch x' } })).toThrow(RefusingToRun)
    expect(() => probeArgs(nonce, '$(id)', 1)).toThrow(RefusingToRun)
  })

  it('[U:rig-compose] refuses a nonce or a cell token that is not shaped like one', () => {
    expect(() => rig({ nonce: 'DEADBEEF' })).toThrow(RefusingToRun)
    expect(() => rig({ brainToken: 'hunter2' })).toThrow(RefusingToRun)
  })

  it('[U:compose] a cell of another harness gets its own images and its own project names, and is sealed the same way', () => {
    const o: RigOptions = { ...base, check: 'hold', cell: LETTA_CODE_CELL }
    const rig = renderRig(o)
    expect(rig.project).toBe('smlab-lc-deadbeef')
    expect(rig.project).toMatch(PROJECT_NAME)
    expect(Object.fromEntries(Object.entries(rig.file.services).map(([name, s]) => [name, s.image]))).toEqual({
      door: 'smlab-lc-rig:local', sink: 'smlab-lc-rig:local', control: 'smlab-lc-rig:local', cell: LETTA_CODE_CELL.image,
    })
    expect(LETTA_CODE_CELL.image).toMatch(/^smlab-lc-cell:letta-code-\d/)
    expect(rig.file.services.cell.command).toEqual(['node', '/opt/swarm/conformance/docker/letta-code/cell-main.ts'])
    expect(rig.file.services.door.environment.SMLAB_HARNESS).toBe('letta-code')
    expect(() => assertSealed(rig, LETTA_CODE_CELL)).not.toThrow()
    // Held to the wrong harness, or built from the other lab's images, it is not a sealed rig of this lab.
    expect(() => assertSealed(rig)).toThrow(/the cell runs another command than its entry.*the cell is not the image of its harness.*not this lab's rig image/)
    expect(() => assertSealed(renderRig({ ...o, cell: undefined }), LETTA_CODE_CELL)).toThrow(/REFUSING TO RUN: S0/)
    // The default is unchanged.
    const first = renderRig({ ...o, cell: undefined })
    expect(first.project).toBe('smlab-deadbeef')
    expect(first.file.services.door.environment.SMLAB_HARNESS).toBe('pi')
  })
})
