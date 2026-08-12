// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../docker')

describe('Local build compose generation', () => {
  let tmpDir: string
  let fakeHermesDir: string
  let storage: Storage
  let config: ConfigService
  let service: HarnessService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-localbuild-'))
    fakeHermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-swarm-fake-'))
    // Create a Dockerfile so resolveImageOrBuild detects it
    fs.writeFileSync(path.join(fakeHermesDir, 'Dockerfile'), 'FROM debian:13\n')

    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
    storage = new Storage(tmpDir)
    const docker = new DockerService()
    const audit = new AuditService(storage)
    config = new ConfigService(storage)
    // Set dataDir to tmpDir so compose files go into test-controlled directory
    config.updateSettings({ dataDir: tmpDir })
    service = new HarnessService(storage, docker, audit, config)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(fakeHermesDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('defaults useLocalBuild to false so a fresh install pulls the published image', () => {
    // Local build requires a hermes source checkout on the host, which a fresh
    // install (e.g. a new machine) does not have — deploy then fails with
    // "no Dockerfile found". The correct default is to pull the published
    // hermes-agent-mt image; local build is an opt-in dev toggle.
    const settings = config.getSettings()
    expect(settings.useLocalBuild).toBe(false)
  })

  it('generates compose with build directive when useLocalBuild is true', async () => {
    // Configure settings with local build enabled and our fake dir
    config.updateSettings({
      useLocalBuild: true,
      hermesDir: fakeHermesDir,
    })

    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'build-test' })

    // Read the generated compose file
    const composeFile = result.composeFile!
    expect(fs.existsSync(composeFile)).toBe(true)
    const content = fs.readFileSync(composeFile, 'utf-8')

    // Should have build: directive, NOT image:
    expect(content).toContain('build:')
    expect(content).toContain(`context: ${fakeHermesDir}`)
    expect(content).toContain('dockerfile: Dockerfile')
    expect(content).not.toContain('image: nousresearch/hermes-agent')
  })

  it('generates compose with image directive when useLocalBuild is false', async () => {
    config.updateSettings({
      useLocalBuild: false,
      hermesDir: fakeHermesDir,
    })

    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'image-test' })

    const composeFile = result.composeFile!
    expect(fs.existsSync(composeFile)).toBe(true)
    const content = fs.readFileSync(composeFile, 'utf-8')

    expect(content).toContain('image: ghcr.io/cyborg-garden/hermes-agent-mt:latest')
    expect(content).not.toContain('build:')
  })

  it('falls back to image when hermesDir has no Dockerfile', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-empty-'))
    config.updateSettings({
      useLocalBuild: true,
      hermesDir: emptyDir,
    })

    storage.write('harnesses.json', [])
    const result = await service.createOverlay({ name: 'fallback-test' })

    const composeFile = result.composeFile!
    const content = fs.readFileSync(composeFile, 'utf-8')

    // No Dockerfile found, should fall back to image
    expect(content).toContain('image: ghcr.io/cyborg-garden/hermes-agent-mt:latest')
    expect(content).not.toContain('build:')

    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it('uses local build for duplicated harnesses too', async () => {
    config.updateSettings({
      useLocalBuild: true,
      hermesDir: fakeHermesDir,
    })

    storage.write('harnesses.json', [])
    // Create source harness
    const source = await service.createOverlay({ name: 'source-agent' })

    // Duplicate it
    const duplicate = await service.duplicateOverlay(source.id!, 'cloned-agent')
    expect(duplicate).toBeDefined()

    const composeFile = duplicate!.composeFile!
    expect(fs.existsSync(composeFile)).toBe(true)
    const content = fs.readFileSync(composeFile, 'utf-8')

    expect(content).toContain('build:')
    expect(content).toContain(`context: ${fakeHermesDir}`)
    expect(content).not.toContain('image: nousresearch/hermes-agent')
  })
})
