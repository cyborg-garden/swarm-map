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
