// @vitest-environment node
//
// What the rig's compose file must say before Docker is ever asked to start
// it. These run in CI with no Docker: they read the rendered file. Whether
// Docker then does what the file says is what the Docker suite is for.
import { describe, expect, it } from 'vitest'
import { PROJECT_NAME, RefusingToRun } from '../../guards/preflight.ts'
import { assertSealed, renderRig, rigEnv, RIG_VARIANTS, type RigOptions } from '../compose.ts'

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
    expect(RIG_VARIANTS).toEqual(['good', 'route-out', 'open', 'leaks-env', 'writable'])
    for (const variant of RIG_VARIANTS.filter((v) => v !== 'good')) {
      expect(() => assertSealed(rig({ variant })), variant).toThrow(RefusingToRun)
    }
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

  it('[U:rig-compose] refuses a nonce or a cell token that is not shaped like one', () => {
    expect(() => rig({ nonce: 'DEADBEEF' })).toThrow(RefusingToRun)
    expect(() => rig({ brainToken: 'hunter2' })).toThrow(RefusingToRun)
  })
})
