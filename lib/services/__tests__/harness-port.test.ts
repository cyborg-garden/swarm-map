// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { collectUsedPorts, nextAvailablePort, parseDockerPublishedPorts } from '../harness'
import fs from 'fs'
import path from 'path'
import os from 'os'

// These tests exercise the port-assignment scan in isolation, mocking the
// docker call and pointing the agent-dir scan at a temp "home" so no real
// daemon or ~/.hermes* dirs are touched.

describe('collectUsedPorts', () => {
  let tmpRoot: string
  let composeBaseDir: string
  let homeDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-port-'))
    composeBaseDir = path.join(tmpRoot, 'compose')
    homeDir = path.join(tmpRoot, 'home')
    fs.mkdirSync(composeBaseDir, { recursive: true })
    fs.mkdirSync(homeDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeCompose(name: string, port: number) {
    const dir = path.join(composeBaseDir, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      `services:\n  hermes-${name}:\n    ports:\n      - published: ${port}\n        target: ${port}\n`,
    )
  }

  function writeAgentEnv(dirName: string, port: number) {
    const dir = path.join(homeDir, dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), `ANTHROPIC_API_KEY=\nAPI_SERVER_PORT=${port}\n`)
  }

  it('honors compose-file published ports', () => {
    writeCompose('alpha', 8652)
    const used = collectUsedPorts({ composeBaseDir, homeDir, dockerPorts: () => [] })
    expect(used.has(8652)).toBe(true)
  })

  it('honors docker-reported published ports', () => {
    const used = collectUsedPorts({ composeBaseDir, homeDir, dockerPorts: () => [8662] })
    expect(used.has(8662)).toBe(true)
  })

  // THE ember-vs-personal bug: the monolithic `personal` agent lives at
  // ~/.hermes with API_SERVER_PORT=8642 in its .env and NO compose file under
  // composeBaseDir, and if it's stopped `docker ps` won't report it either.
  // Its port MUST still be treated as used.
  it('honors a port present ONLY in an agent .env (personal at ~/.hermes)', () => {
    writeAgentEnv('.hermes', 8642) // personal agent, no compose, not running
    const used = collectUsedPorts({ composeBaseDir, homeDir, dockerPorts: () => [] })
    expect(used.has(8642)).toBe(true)
  })

  it('scans .hermes-<name> sibling agent dirs too', () => {
    writeAgentEnv('.hermes-ledger', 8672)
    const used = collectUsedPorts({ composeBaseDir, homeDir, dockerPorts: () => [] })
    expect(used.has(8672)).toBe(true)
  })

  it('is defensive about missing dirs and unreadable .env files', () => {
    // No compose dir, no home dir entries — must not throw, returns empty.
    fs.rmSync(composeBaseDir, { recursive: true, force: true })
    const used = collectUsedPorts({
      composeBaseDir,
      homeDir,
      dockerPorts: () => { throw new Error('docker down') },
    })
    expect(used.size).toBe(0)
  })
})

describe('nextAvailablePort', () => {
  let tmpRoot: string
  let composeBaseDir: string
  let homeDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-nextport-'))
    composeBaseDir = path.join(tmpRoot, 'compose')
    homeDir = path.join(tmpRoot, 'home')
    fs.mkdirSync(composeBaseDir, { recursive: true })
    fs.mkdirSync(homeDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeAgentEnv(dirName: string, port: number) {
    const dir = path.join(homeDir, dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), `API_SERVER_PORT=${port}\n`)
  }

  it('returns BASE_PORT when nothing is used', () => {
    expect(nextAvailablePort({ composeBaseDir, homeDir, dockerPorts: () => [] })).toBe(8642)
  })

  it('steps by PORT_STEP over used ports', () => {
    // 8642 and 8652 taken → next free is 8662
    writeAgentEnv('.hermes', 8642)
    writeAgentEnv('.hermes-a', 8652)
    expect(nextAvailablePort({ composeBaseDir, homeDir, dockerPorts: () => [] })).toBe(8662)
  })

  // Regression for the actual incident: ember must NOT be handed 8642 when the
  // stopped/monolithic personal agent already owns it via .env only.
  it('does not reassign a port owned only by another agent .env', () => {
    writeAgentEnv('.hermes', 8642) // personal, .env-only
    const assigned = nextAvailablePort({ composeBaseDir, homeDir, dockerPorts: () => [] })
    expect(assigned).not.toBe(8642)
    expect(assigned).toBe(8652)
  })
})

describe('parseDockerPublishedPorts', () => {
  it('reads ports published on every interface', () => {
    expect(parseDockerPublishedPorts('0.0.0.0:8642->8642/tcp, [::]:8642->8642/tcp\n0.0.0.0:8652->8642/tcp')).toEqual(
      expect.arrayContaining([8642, 8652]),
    )
  })

  it('reads ports published on one address, loopback included', () => {
    const out = '127.0.0.1:8662->8642/tcp\n100.64.0.5:8672->8642/tcp, 127.0.0.1:10672->6080/tcp\n[::1]:8682->8642/tcp'
    expect(parseDockerPublishedPorts(out).sort()).toEqual([10672, 8662, 8672, 8682])
  })

  it('ignores ports a container exposes but does not publish', () => {
    expect(parseDockerPublishedPorts('8642/tcp, 11434/tcp\n')).toEqual([])
  })
})
