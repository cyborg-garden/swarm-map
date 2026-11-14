// @vitest-environment node
//
// What the rig's compose file must say before Docker is ever asked to start
// it. These run in CI with no Docker: they read the rendered file. Whether
// Docker then does what the file says is what the Docker suite is for.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PROJECT_NAME, RefusingToRun } from '../../guards/preflight.ts'
import { LETTA_CODE_CELL } from '../cells.ts'
import {
  assertSealed, contextFiles, labImages, probeArgs, readSource, renderRig, rigEnv, RIG_VARIANTS, RUN_LABEL, sourceProblems,
  type RigOptions,
} from '../compose.ts'

const nonce = 'deadbeef'
const base: RigOptions = { nonce, brainToken: `BRAIN-${nonce}-0123456789abcdef`, check: 'C1', variant: 'good', sinkIp: '10.0.0.9', hostPort: 4444 }
const rig = (over: Partial<RigOptions> = {}) => renderRig({ ...base, ...over })

describe('the sealed rig', () => {
  const { project, file } = rig()

  it('[U:rig-compose] is a lab project, and every image is a lab image that is never pulled', () => {
    expect(project).toMatch(PROJECT_NAME)
    expect(file.name).toBe(project)
    for (const [name, service] of Object.entries(file.services)) {
      expect(service.image, name).toMatch(/^smlab-(cell:pi-[0-9.]+-|rig:)[0-9a-f]{12}$/)
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
})

describe('the images are named for the code they were built from', () => {
  const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
  const made: string[] = []
  afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
  /** A copy of what the builder is sent, somewhere it can be changed. */
  const copy = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'smlab-source-'))
    made.push(dir)
    for (const rel of contextFiles(REPO)) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      cpSync(path.join(REPO, rel), path.join(dir, rel))
    }
    return dir
  }

  it('[U:rig-source] the source is what the builder is sent: the lab\'s folders, less tests, installs and output', () => {
    const files = contextFiles(REPO)
    expect(files).toEqual([...files].sort())
    for (const must of ['conformance/docker/Dockerfile', 'conformance/docker/Dockerfile.dockerignore', 'conformance/docker/pi/package-lock.json',
      'conformance/docker/cell-main.ts', 'lib/core/decide.ts', 'lib/door/door.ts', 'lib/runtimes/pi/caps.ts']) expect(files, must).toContain(must)
    for (const rel of files) {
      expect(rel).toMatch(/^(lib\/(core|door|runtimes)|conformance)\//)
      expect(rel).not.toMatch(/(^|\/)(__tests__|node_modules)\//)
      expect(rel).not.toMatch(/^conformance\/(matrix|out)\//)
    }
  })

  it('[U:rig-source] both names carry the hash of that source, and the same source gives the same names', () => {
    const dir = copy()
    const here = labImages({}, REPO)
    expect(here.source).toMatch(/^[0-9a-f]{12}$/)
    expect(here.source).toBe(readSource(REPO).hash)
    expect(here.cell).toBe(`smlab-cell:pi-1.5.2-${here.source}`)
    expect(here.rig).toBe(`smlab-rig:${here.source}`)
    expect(labImages({}, dir)).toEqual(here)
    expect(rig().file.services.cell.image).toBe(here.cell)
    for (const name of ['door', 'sink', 'control'] as const) expect(rig().file.services[name].image, name).toBe(here.rig)
  })

  it('[U:rig-source] one changed line, one new file or one renamed file gives other names', () => {
    const before = labImages({}, REPO)
    const changed = copy()
    appendFileSync(path.join(changed, 'lib/core/decide.ts'), '\n// changed\n')
    const added = copy()
    writeFileSync(path.join(added, 'lib/door/extra.ts'), '')
    const dockerfile = copy()
    appendFileSync(path.join(dockerfile, 'conformance/docker/Dockerfile'), '\n# changed\n')
    const seen = new Set([before.source])
    for (const dir of [changed, added, dockerfile]) {
      const after = labImages({}, dir)
      expect(after.cell).not.toBe(before.cell)
      expect(after.rig).not.toBe(before.rig)
      seen.add(after.source)
    }
    expect(seen.size).toBe(4)
  })

  it('[U:rig-source] what the builder is never sent does not change the names', () => {
    const dir = copy()
    mkdirSync(path.join(dir, 'conformance/matrix'), { recursive: true })
    mkdirSync(path.join(dir, 'conformance/out'), { recursive: true })
    mkdirSync(path.join(dir, 'lib/core/__tests__'), { recursive: true })
    mkdirSync(path.join(dir, 'lib/other'), { recursive: true })
    for (const rel of ['conformance/matrix/x.json', 'conformance/out/ledger', 'lib/core/__tests__/x.test.ts', 'lib/other/x.ts', 'README.md']) writeFileSync(path.join(dir, rel), 'x')
    expect(labImages({}, dir)).toEqual(labImages({}, REPO))
  })

  it('[U:rig-source] the prefix can be set for a run, and only to a plain short word', () => {
    const mine = labImages({ SWARMLAB_DOCKER_PREFIX: 'smlabv' }, REPO)
    expect(mine.cell).toBe(`smlabv-cell:pi-1.5.2-${mine.source}`)
    expect(mine.rig).toBe(`smlabv-rig:${mine.source}`)
    const { project, file } = rig({ prefix: 'smlabv', images: mine })
    expect(project).toBe('smlabv-deadbeef')
    expect(file.services.cell.image).toBe(mine.cell)
    for (const bad of ['', 'Smlab', 'sm lab', 'sm-lab', 'x', 'a'.repeat(17), 'smlab;rm', '../x', '9lab']) {
      expect(() => labImages({ SWARMLAB_DOCKER_PREFIX: bad }, REPO), bad).toThrow(/^REFUSING TO RUN: F5 /)
    }
  })

  it('[U:rig-source] everything a rig makes carries the id of the run that made it, when it is given one', () => {
    const { file } = rig({ runId: '0123456789abcdef' })
    const label = { [RUN_LABEL]: '0123456789abcdef' }
    for (const [name, service] of Object.entries(file.services)) expect(service.labels, name).toEqual(label)
    for (const [name, network] of Object.entries(file.networks)) expect(network.labels, name).toEqual(label)
    expect(file.volumes.lab.labels).toEqual(label)
    expect(() => rig({ runId: 'not hex' })).toThrow(/^REFUSING TO RUN: F5 /)
    expect(() => assertSealed(rig({ runId: '0123456789abcdef' }))).not.toThrow()
  })
})

describe('an image is only used if it holds the code under test', () => {
  const expected = { hash: 'aaaaaaaaaaaa', files: { 'lib/core/decide.ts': '1'.repeat(64), 'conformance/docker/cell-main.ts': '2'.repeat(64), 'conformance/docker/sink.ts': '3'.repeat(64) } }
  const listing = (files: Record<string, string>): string => Object.entries(files).map(([rel, sum]) => `${sum}  ./${rel}\n`).join('')
  const cellFiles = { 'lib/core/decide.ts': '1'.repeat(64), 'conformance/docker/cell-main.ts': '2'.repeat(64) }

  it('[U:rig-source] passes an image that says it is from this source and holds its files', () => {
    expect(sourceProblems('rig', 'i', { label: expected.hash, listing: listing(expected.files) }, expected)).toEqual([])
    // The cell holds a part of the source, by design.
    expect(sourceProblems('cell', 'i', { label: expected.hash, listing: listing(cellFiles) }, expected)).toEqual([])
  })

  it('[U:rig-source] goes red on an image that names another source, or none', () => {
    for (const label of ['bbbbbbbbbbbb', '', '<no value>']) {
      const problems = sourceProblems('rig', 'smlab-rig:x', { label, listing: listing(expected.files) }, expected)
      expect(problems.join('; '), label).toMatch(/smlab-rig:x was built from other code/)
    }
  })

  it('[U:rig-source] goes red on a file that differs, a file this code does not have, and a file the rig lacks, whatever the label says', () => {
    const differs = sourceProblems('cell', 'i', { label: expected.hash, listing: listing({ ...cellFiles, 'lib/core/decide.ts': '9'.repeat(64) }) }, expected)
    expect(differs.join('; ')).toContain('lib/core/decide.ts differs')
    const foreign = sourceProblems('cell', 'i', { label: expected.hash, listing: listing({ ...cellFiles, 'lib/runtimes/other/shim.ts': '4'.repeat(64) }) }, expected)
    expect(foreign.join('; ')).toContain('lib/runtimes/other/shim.ts is not in this code')
    const lacks = sourceProblems('rig', 'i', { label: expected.hash, listing: listing(cellFiles) }, expected)
    expect(lacks.join('; ')).toContain('conformance/docker/sink.ts is missing')
    // The cell may lack files, but not its own entry.
    expect(sourceProblems('cell', 'i', { label: expected.hash, listing: listing({ 'lib/core/decide.ts': '1'.repeat(64) }) }, expected).join('; ')).toContain('conformance/docker/cell-main.ts is missing')
  })

  it('[U:rig-source] goes red when the files could not be listed', () => {
    for (const text of ['', 'sh: not found\n', 'docker: Error response from daemon\n']) {
      expect(sourceProblems('rig', 'i', { label: expected.hash, listing: text }, expected).join('; '), text).toContain('its files could not be read')
    }
  })

  it('[U:compose] a cell of another harness has its own image name and entry, and is sealed the same way', () => {
    const first = renderRig({ ...base, check: 'hold' })
    const second = renderRig({ ...base, check: 'hold', cell: LETTA_CODE_CELL })
    // Same code, same rig image; the cell image says which harness and version it holds.
    expect(second.file.services.door.image).toBe(first.file.services.door.image)
    expect(first.file.services.cell.image).toMatch(/-cell:pi-[0-9.]+-[0-9a-f]{12}$/)
    expect(second.file.services.cell.image).toMatch(/-cell:letta-code-[0-9.]+-[0-9a-f]{12}$/)
    expect(second.file.services.cell.command).toEqual(['node', '/opt/swarm/conformance/docker/letta-code/cell-main.ts'])
    expect(first.file.services.door.environment.SMLAB_HARNESS).toBe('pi')
    expect(second.file.services.door.environment.SMLAB_HARNESS).toBe('letta-code')
    expect(() => assertSealed(second, LETTA_CODE_CELL)).not.toThrow()
    // Held to the other harness, it is not that harness's sealed rig.
    expect(() => assertSealed(second)).toThrow(/the cell runs another command than its entry/)
    expect(() => assertSealed(first, LETTA_CODE_CELL)).toThrow(/the cell runs another command than its entry/)
    // The file a cell image must hold to be this code's is its own entry.
    const source = readSource()
    const listing = Object.entries(source.files).filter(([rel]) => rel !== 'conformance/docker/letta-code/cell-main.ts').map(([rel, sum]) => `${sum}  ./${rel}`).join('\n')
    expect(sourceProblems('cell', 'x', { label: source.hash, listing }, source)).toEqual([])
    expect(sourceProblems('cell', 'x', { label: source.hash, listing }, source, LETTA_CODE_CELL.entry).join(' ')).toContain('conformance/docker/letta-code/cell-main.ts is missing')
  })
})
