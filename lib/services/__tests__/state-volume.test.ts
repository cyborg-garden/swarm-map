// @vitest-environment node
//
// The state-volume layout (named volume at /state + state-init, #204 PR2) is
// chosen per agent from the Docker ENGINE, not from where Node runs: on for an
// engine in a VM (bind mounts cross a file-sharing layer that can tear SQLite
// writes) or one that cannot be identified, off for native Linux (#273).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  agentHasStateVolumeLayout,
  stateVolumeLayout,
  composeMountsStateVolume,
  engineNeedsStateVolume,
  resolveUseStateVolume,
  type DockerHostInfo,
} from '../state-volume'

const NATIVE: DockerHostInfo = {
  operatingSystem: 'Ubuntu 24.04.1 LTS',
  kernelVersion: '6.8.0-45-generic',
  osType: 'linux',
  endpoint: 'unix:///var/run/docker.sock',
}

describe('engineNeedsStateVolume', () => {
  it('macOS and Windows: always on, without asking the engine (every engine there is a VM)', () => {
    expect(engineNeedsStateVolume('darwin', null)).toEqual({ use: true, reason: 'vm-engine' })
    expect(engineNeedsStateVolume('win32', null)).toEqual({ use: true, reason: 'vm-engine' })
    // Even if the engine it reaches looks like native Linux: that engine is
    // not on this machine's kernel.
    expect(engineNeedsStateVolume('darwin', NATIVE).use).toBe(true)
  })

  it('any other non-Linux platform: on, as unknown', () => {
    expect(engineNeedsStateVolume('freebsd', NATIVE)).toEqual({ use: true, reason: 'unknown-engine' })
  })

  it('Linux with a native engine on the local socket: off', () => {
    expect(engineNeedsStateVolume('linux', NATIVE)).toEqual({ use: false, reason: 'native-linux' })
    for (const os of ['Debian GNU/Linux 12 (bookworm)', 'Fedora Linux 40 (Server Edition)', 'Arch Linux', 'Alpine Linux v3.20']) {
      expect(engineNeedsStateVolume('linux', { ...NATIVE, operatingSystem: os }).use).toBe(false)
    }
    // A CLI with no context support and no DOCKER_HOST can only be using its
    // built-in default, the local socket.
    expect(engineNeedsStateVolume('linux', { ...NATIVE, endpoint: '' }).use).toBe(false)
    // Rootless / per-user sockets are still local.
    expect(engineNeedsStateVolume('linux', { ...NATIVE, endpoint: 'unix:///run/user/1000/docker.sock' }).use).toBe(false)
  })

  // Node reports "linux" in all of these, and the engine is still a VM.
  it.each([
    ['Docker Desktop for Linux', { operatingSystem: 'Docker Desktop', kernelVersion: '6.10.14-linuxkit' }],
    ['inside a container on a Docker Desktop host (socket mounted)', { operatingSystem: 'Docker Desktop', kernelVersion: '6.10.14-linuxkit' }],
    ['a linuxkit kernel under another name', { operatingSystem: 'Some Engine', kernelVersion: '6.6.12-linuxkit' }],
    ['OrbStack', { operatingSystem: 'OrbStack', kernelVersion: '6.9.6-orbstack-00147-g7ecfc3d5ca4e' }],
    ['Rancher Desktop', { operatingSystem: 'Rancher Desktop WSL Distribution', kernelVersion: '5.15.153.1-microsoft-standard-WSL2' }],
    ['WSL2', { operatingSystem: 'Ubuntu 22.04.4 LTS', kernelVersion: '5.15.153.1-microsoft-standard-WSL2' }],
    // The operating-system name alone is enough; the kernel need not say linuxkit.
    ['Docker Desktop with a kernel string that names nothing (fixture)', { operatingSystem: 'Docker Desktop', kernelVersion: '6.12.0' }],
  ])('Linux process, VM engine (%s): on', (_label, engine) => {
    expect(engineNeedsStateVolume('linux', { ...NATIVE, ...engine })).toEqual({ use: true, reason: 'vm-engine' })
  })

  it.each([
    ['the engine did not answer', null],
    ['the probe returned nothing', undefined],
    ['a remote engine over tcp', { ...NATIVE, endpoint: 'tcp://10.0.0.5:2376' }],
    ['a remote engine over ssh', { ...NATIVE, endpoint: 'ssh://user@remote-host' }],
    ['a Windows-container engine', { ...NATIVE, osType: 'windows' }],
    ['no OSType reported', { ...NATIVE, osType: '' }],
    ['no operating system or kernel reported', { ...NATIVE, operatingSystem: '', kernelVersion: '' }],
  ])('Linux process, engine unknown (%s): on, the safe side', (_label, info) => {
    expect(engineNeedsStateVolume('linux', info)).toEqual({ use: true, reason: 'unknown-engine' })
  })
})

// These engines run in a VM but report the guest distro, so OperatingSystem
// and KernelVersion look native. They are recognised from the docker context
// name and the socket path. The strings below are FIXTURES written from each
// tool's naming conventions, not output captured from those engines.
describe('engineNeedsStateVolume: VM engines that look native, and containerised processes', () => {
  const GUEST = { ...NATIVE, operatingSystem: 'Ubuntu 24.04.1 LTS', kernelVersion: '6.8.0-45-generic', contextName: 'default' }

  it.each([
    ['Colima, by context name (fixture)', { contextName: 'colima' }],
    ['Colima profile, by context name (fixture)', { contextName: 'colima-work' }],
    ['Colima, capitalised context name (fixture)', { contextName: 'Colima' }],
    ['Colima, by socket path (fixture)', { endpoint: 'unix:///home/u/.colima/default/docker.sock' }],
    ['Lima, by context name (fixture)', { contextName: 'lima-default' }],
    ['Lima, capitalised context name (fixture)', { contextName: 'Lima-default' }],
    ['Lima, bare context name (fixture)', { contextName: 'lima' }],
    ['Lima, by socket path (fixture)', { endpoint: 'unix:///home/u/.lima/docker/sock/docker.sock' }],
    ['Rancher Desktop, by context name (fixture)', { contextName: 'rancher-desktop' }],
    ['Rancher Desktop, by socket path (fixture)', { endpoint: 'unix:///home/u/.rd/rancher/docker.sock' }],
    ['Podman machine, by context name (fixture)', { contextName: 'podman-machine-default' }],
    ['Podman, by socket path (fixture)', { endpoint: 'unix:///run/user/1000/podman/podman.sock' }],
  ])('Linux process, %s: on, as unknown', (_label, engine) => {
    expect(engineNeedsStateVolume('linux', { ...GUEST, ...engine })).toEqual({ use: true, reason: 'unknown-engine' })
  })

  // The tool name must be a whole word. These are ordinary context names and
  // socket paths that merely contain one (fixtures).
  it.each([
    ['lima01'], ['limassol'], ['ranchero'], ['podmanager'], ['sublimate'], ['climate-lab'], ['mycolimax'], ['default'],
    // preceded by a letter, then ending or followed by a separator
    ['mycolima'], ['antipodman'], ['prelima-1'], ['xrancher-desktop'],
  ])('native Linux with a context called "%s" stays off', (contextName) => {
    expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName })).toEqual({ use: false, reason: 'native-linux' })
    expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName: 'default', endpoint: `unix:///srv/${contextName}/docker.sock` }))
      .toEqual({ use: false, reason: 'native-linux' })
  })

  // Reached through the default context and the standard socket path, these
  // engines show only in the VM's own hostname (`docker info` .Name), or, for
  // Rancher Desktop's own socket, in the ~/.rd/ directory. CONSTRUCTED
  // fixtures, not captured output.
  it.each([
    ['Colima behind /var/run/docker.sock, default context (constructed)', { name: 'colima' }],
    ['Lima behind /var/run/docker.sock, default context (constructed)', { name: 'lima-default' }],
    ['Rancher Desktop on Lima behind /var/run/docker.sock, default context (constructed)', { name: 'lima-rancher-desktop' }],
    ['Rancher Desktop through DOCKER_HOST at its own socket (constructed)', { contextName: '', endpoint: 'unix:///home/u/.rd/docker.sock', name: 'build-box' }],
    ['a Colima profile, capitalised (constructed)', { name: 'Colima-work' }],
  ])('Linux process, %s: on, as unknown', (_label, engine) => {
    expect(engineNeedsStateVolume('linux', { ...GUEST, endpoint: 'unix:///var/run/docker.sock', ...engine }))
      .toEqual({ use: true, reason: 'unknown-engine' })
  })

  // A native host's own name is not evidence unless it is exactly a form
  // those tools give their VMs (constructed).
  it.each([['rancher-node1'], ['podman-host'], ['lima01'], ['limassol'], ['colima2'], ['lima'], ['my-colima'], ['rancher'], ['build-box']])(
    'native Linux host named "%s" stays off', (name) => {
      expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName: 'default', name })).toEqual({ use: false, reason: 'native-linux' })
    })

  it('a socket path that merely contains "rd" is not Rancher Desktop', () => {
    for (const endpoint of ['unix:///srv/rd/docker.sock', 'unix:///home/u/.rdx/docker.sock', 'unix:///home/u/x.rd/docker.sock']) {
      expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName: 'default', endpoint }).use).toBe(false)
    }
  })

  it('Linux process inside a container: on, as unknown, even when the engine reads as native', () => {
    expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName: 'default', containerised: true }))
      .toEqual({ use: true, reason: 'unknown-engine' })
  })

  it('native Debian/Ubuntu on a local socket stays off', () => {
    expect(engineNeedsStateVolume('linux', { ...NATIVE, contextName: 'default', containerised: false })).toEqual({ use: false, reason: 'native-linux' })
    expect(engineNeedsStateVolume('linux', { ...NATIVE, operatingSystem: 'Debian GNU/Linux 12 (bookworm)', contextName: 'default', containerised: false }).use).toBe(false)
  })
})

describe('agentHasStateVolumeLayout / resolveUseStateVolume', () => {
  let dataDir: string
  const native = () => NATIVE

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-volume-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** What state-init leaves behind: host-dangling symlinks into /state. */
  const migrate = (db = 'state.db') => fs.symlinkSync(`/state/${db}`, path.join(dataDir, db))

  it('reads the layout from the data dir: a DB symlink into /state means migrated', () => {
    expect(agentHasStateVolumeLayout(dataDir)).toBe(false)
    expect(agentHasStateVolumeLayout(path.join(dataDir, 'missing'))).toBe(false)
    fs.writeFileSync(path.join(dataDir, 'state.db'), 'a real database')
    expect(agentHasStateVolumeLayout(dataDir)).toBe(false)
    // A symlink that is not ours does not count.
    fs.symlinkSync('/somewhere/else.db', path.join(dataDir, 'kanban.db'))
    expect(agentHasStateVolumeLayout(dataDir)).toBe(false)
    migrate('response_store.db')
    expect(agentHasStateVolumeLayout(dataDir)).toBe(true)
  })

  it('a data dir that cannot be read: layout on, under its own reason, with a log line that says what happened', () => {
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP']) {
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(stateVolumeLayout(dataDir)).toBe('unreadable')
      expect(agentHasStateVolumeLayout(dataDir)).toBe(true)
      for (const setting of [undefined, true, false]) {
        expect(resolveUseStateVolume({ setting, dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'layout-unknown' })
      }
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not read/))
      // It must not claim the databases are on the volume: that is not known.
      expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/databases are on its named volume/))
      spy.mockRestore()
      warn.mockRestore()
    }
  })

  it('only "not there" counts as absent', () => {
    for (const code of ['ENOENT', 'ENOTDIR']) {
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      expect(stateVolumeLayout(dataDir)).toBe('not-on-volume')
      expect(agentHasStateVolumeLayout(dataDir)).toBe(false)
      spy.mockRestore()
    }
    expect(stateVolumeLayout(dataDir)).toBe('not-on-volume')
    migrate()
    expect(stateVolumeLayout(dataDir)).toBe('on-volume')
  })

  it('composeMountsStateVolume: reads the /state mount from a compose file', () => {
    expect(composeMountsStateVolume('    volumes:\n      - /d:/opt/data\n      - hermes-state-sci:/state\n    command: gateway\n')).toBe(true)
    expect(composeMountsStateVolume('    volumes:\n      - /d:/opt/data\n    command: gateway\n')).toBe(false)
    // A bind mount of some host dir at /state, or a comment, is not the volume.
    expect(composeMountsStateVolume('      - /srv/state:/state\n')).toBe(false)
    expect(composeMountsStateVolume('      # - hermes-state-sci:/state\n')).toBe(false)
    // The mount point must be exactly /state.
    expect(composeMountsStateVolume('      - hermes-state-x:/state-old\n')).toBe(false)
    expect(composeMountsStateVolume('      - hermes-state-x:/state/sub\n')).toBe(false)
    expect(composeMountsStateVolume('')).toBe(false)
  })

  describe('regeneration over a compose file that already mounts the volume', () => {
    const existingCompose = '    volumes:\n      - /d:/opt/data\n      - hermes-state-sci:/state\n'

    it('interrupted state-init (state.db absent from the data dir): keeps the layout', () => {
      // state-init removed state.db from the data dir and stopped before
      // writing the symlink: the database is on the volume.
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolveUseStateVolume({ setting: false, dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/may be on the volume/))
      // Other databases left as plain files do not change that: state-init
      // handles state.db first.
      fs.writeFileSync(path.join(dataDir, 'kanban.db'), 'not yet moved')
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native }).reason).toBe('existing-layout')
    })

    it('symlinks removed by hand and real files written since (regular state.db): follows the engine and the setting', () => {
      // The data dir holds the live database; the old compose file's mount
      // says nothing about where the data is.
      fs.writeFileSync(path.join(dataDir, 'state.db'), 'the live database')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: false, reason: 'native-linux' })
      expect(resolveUseStateVolume({ setting: false, dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: false, reason: 'setting' })
      expect(resolveUseStateVolume({ setting: false, dataDir, existingCompose, platform: 'darwin', hostInfo: native })).toEqual({ use: false, reason: 'setting' })
      expect(warn).not.toHaveBeenCalled()
      // The engine still decides when nothing is forced.
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'darwin', hostInfo: native }).use).toBe(true)
    })

    it('says once that the volume is left in place when the regenerated file stops mounting it', () => {
      fs.writeFileSync(path.join(dataDir, 'state.db'), 'the live database')
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native })
      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line).toContain('hermes-state-sci')
      expect(line).toMatch(/no longer mounts/)
      expect(line).toMatch(/left in place/)
      // Not when the layout stays on, and not when there was no mount to drop.
      info.mockClear()
      resolveUseStateVolume({ dataDir, existingCompose, platform: 'darwin', hostInfo: native })
      resolveUseStateVolume({ setting: true, dataDir, existingCompose, platform: 'linux', hostInfo: native })
      resolveUseStateVolume({ dataDir, existingCompose: '      - /d:/opt/data\n', platform: 'linux', hostInfo: native })
      resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo: native })
      expect(info).not.toHaveBeenCalled()
    })

    it('only a REGULAR state.db counts as live data in the data dir', () => {
      // Something else at that path (a link that is not ours, a directory) is
      // not a database the agent has been writing: the mount still counts.
      fs.symlinkSync('/somewhere/else.db', path.join(dataDir, 'state.db'))
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
      fs.rmSync(path.join(dataDir, 'state.db'))
      fs.mkdirSync(path.join(dataDir, 'state.db'))
      expect(resolveUseStateVolume({ dataDir, existingCompose, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
    })

    it('a compose file without the mount decides nothing', () => {
      expect(resolveUseStateVolume({ dataDir, existingCompose: '      - /d:/opt/data\n', platform: 'linux', hostInfo: native }).use).toBe(false)
      expect(resolveUseStateVolume({ dataDir, existingCompose: null, platform: 'linux', hostInfo: native }).use).toBe(false)
    })
  })

  it('automatic: follows the engine', () => {
    expect(resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: false, reason: 'native-linux' })
    expect(resolveUseStateVolume({ dataDir, platform: 'darwin', hostInfo: native })).toEqual({ use: true, reason: 'vm-engine' })
    expect(resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo: () => null })).toEqual({ use: true, reason: 'unknown-engine' })
    // null in settings is the same as unset.
    expect(resolveUseStateVolume({ setting: null, dataDir, platform: 'linux', hostInfo: native }).use).toBe(false)
  })

  it('a probe that throws leaves the engine unknown: on', () => {
    const hostInfo = () => { throw new Error('docker: command not found') }
    expect(resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo })).toEqual({ use: true, reason: 'unknown-engine' })
  })

  it('the setting overrides the engine in both directions', () => {
    expect(resolveUseStateVolume({ setting: true, dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'setting' })
    expect(resolveUseStateVolume({ setting: false, dataDir, platform: 'darwin', hostInfo: native })).toEqual({ use: false, reason: 'setting' })
  })

  it('asks the engine only when it has to', () => {
    const hostInfo = vi.fn(() => NATIVE)
    resolveUseStateVolume({ setting: true, dataDir, platform: 'linux', hostInfo })
    resolveUseStateVolume({ setting: false, dataDir, platform: 'linux', hostInfo })
    resolveUseStateVolume({ dataDir, platform: 'darwin', hostInfo })
    migrate()
    resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo })
    expect(hostInfo).not.toHaveBeenCalled()
  })

  it('an agent already on the volume keeps the layout on native Linux', () => {
    migrate()
    expect(resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
  })

  it('an agent already on the volume keeps the layout even when the setting is off, and says why', () => {
    migrate()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveUseStateVolume({ setting: false, dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: true, reason: 'existing-layout' })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/keeping the layout/))
  })

  it('after the runbook rollback (symlinks replaced by real files) the agent follows the engine again', () => {
    migrate()
    fs.rmSync(path.join(dataDir, 'state.db'))
    fs.writeFileSync(path.join(dataDir, 'state.db'), 'copied back from the volume')
    expect(resolveUseStateVolume({ dataDir, platform: 'linux', hostInfo: native })).toEqual({ use: false, reason: 'native-linux' })
  })

  it('an agent with plain database files gets the layout when it turns on (state-init then moves them)', () => {
    fs.writeFileSync(path.join(dataDir, 'state.db'), 'a real database')
    expect(resolveUseStateVolume({ dataDir, platform: 'darwin', hostInfo: native }).use).toBe(true)
    expect(resolveUseStateVolume({ setting: true, dataDir, platform: 'linux', hostInfo: native }).use).toBe(true)
  })
})
