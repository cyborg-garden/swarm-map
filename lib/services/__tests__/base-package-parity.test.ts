// @vitest-environment node
//
// Parity: every way an agent comes into being — create (scaffold), import
// ("connect" an existing data dir), duplicate — ends up with the SAME base
// package for the same selection. The deploy route is covered by
// deploy-route.integration.test.ts (it calls the same installBaselineTemplates).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HarnessService } from '../harness'
import { Storage } from '../storage'
import { DockerService } from '../docker'
import { AuditService } from '../audit'
import { ConfigService } from '../config'
import { readBlockList } from '../../yaml-block-list'
import { loadBasePackage, readStamp, ORIENTATION_START, type Selection } from '../base-package'
import { generateDefaultConfig } from '../../templates/config-yaml'

vi.mock('../docker')

const pkg = loadBasePackage(process.cwd())

let tmpDir: string
let srcDir: string
let storage: Storage
let service: HarnessService

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-parity-'))
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-parity-src-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir)
  storage = new Storage(tmpDir)
  storage.write('harnesses.json', [])
  service = new HarnessService(storage, new DockerService(), new AuditService(storage), new ConfigService(storage))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(srcDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Everything the base package is responsible for, normalised for comparison. */
function fingerprint(dir: string) {
  const config = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8')
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf-8')
  const soul = fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf-8')
  const sorted = (x: string[] | null) => [...(x ?? [])].sort()
  const enabled = new Set(readBlockList(config, 'plugins', 'enabled') ?? [])
  return {
    stamp: readStamp(dir),
    // package-owned plugins only (a source agent may enable extras of its own)
    corePluginsEnabled: [...pkg.imagePlugins, 'person_memory', 'swarm_map_policy', 'credential_redactor'].filter((n) => enabled.has(n)).sort(),
    inlinePlugins: /^\s+enabled:\s*\[/m.test(config.slice(config.search(/^plugins:/m))),
    disabledToolsets: sorted(readBlockList(config, 'agent', 'disabled_toolsets')),
    disabledSkills: sorted(readBlockList(config, 'skills', 'disabled')),
    orientation: soul.includes(ORIENTATION_START),
    dmsOff: /^DISCORD_ALLOW_ALL_USERS=false$/m.test(env),
    deadKeys: pkg.deadEnvKeys.filter((k) => new RegExp(`^${k}=`, 'm').test(env)),
    coreDirs: ['plugins/credential_redactor', 'plugins/person_memory', 'plugins/swarm_map_policy', 'skills/garden-orientation', 'skills/session-handoff', 'hooks/lifecycle-notify']
      .filter((d) => fs.existsSync(path.join(dir, d))),
    captcha: fs.existsSync(path.join(dir, 'plugins', 'captcha_cascade')),
    browserBackend: /^CAMOFOX_URL=./m.test(env),
    browserDisabled: (readBlockList(config, 'agent', 'disabled_toolsets') ?? []).includes('browser'),
  }
}

async function viaCreate(sel: Selection) {
  await service.createOverlay({ name: 'made', selection: sel })
  return path.join(tmpDir, '.hermes-made')
}
async function viaImport(sel: Selection) {
  // A pre-package agent: inline plugins list, own persona, old dead keys.
  fs.writeFileSync(path.join(srcDir, 'config.yaml'), 'model:\n  provider: zai\n  default: glm-5.3\nplugins:\n  enabled: []\n')
  fs.writeFileSync(path.join(srcDir, '.env'), 'GLM_API_KEY=x\n')
  fs.writeFileSync(path.join(srcDir, 'SOUL.md'), '# connected\n\nOwn persona.\n')
  const r = await service.importFromDir(srcDir, 'connected', sel)
  return r.destDir
}
async function viaDuplicate(sel: Selection) {
  // Source made before the package existed (plain template config, no stamp).
  const src = path.join(tmpDir, '.hermes-source')
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'config.yaml'), generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.3' }))
  fs.writeFileSync(path.join(src, '.env'), 'GLM_API_KEY=x\nAPI_SERVER_PORT=8642\nHERMES_AGENT_NAME=source\n')
  fs.writeFileSync(path.join(src, 'SOUL.md'), '# source\n')
  fs.writeFileSync(path.join(src, '.hsm-base-package'), JSON.stringify({ version: '0.0.1', surface: sel.surface, packs: sel.packs }))
  storage.write('harnesses.json', [{ id: 'h_source', name: 'source', tier: 'individual', platform: 'hermes', channel: ':8642', tools: [], models: [] }])
  await service.duplicateOverlay('h_source', 'copy')
  return path.join(tmpDir, '.hermes-copy')
}

describe('base package parity across creation paths', () => {
  for (const surface of ['team', 'public'] as const) {
    it(`create, import and duplicate produce the same ${surface} package`, async () => {
      const sel: Selection = { surface, packs: [] }
      const created = fingerprint(await viaCreate(sel))
      const imported = fingerprint(await viaImport(sel))
      const duplicated = fingerprint(await viaDuplicate(sel))

      expect(created.stamp).toEqual({ version: pkg.version, surface, packs: [] })
      expect(created.inlinePlugins).toBe(false)
      expect(created.orientation).toBe(true)
      expect(created.deadKeys).toEqual([])
      expect(created.captcha).toBe(false)
      expect(created.browserBackend).toBe(true)
      expect(created.browserDisabled).toBe(false)
      expect(created.dmsOff).toBe(surface === 'public')

      expect(imported).toEqual(created)
      expect(duplicated).toEqual(created)
    })
  }

  it('import refuses a public agent with the browser-ops pack before copying anything', async () => {
    fs.writeFileSync(path.join(srcDir, '.env'), 'X=1\n')
    await expect(service.importFromDir(srcDir, 'nope', { surface: 'public', packs: ['browser-ops'] })).rejects.toThrow(/public/)
    expect(fs.existsSync(path.join(tmpDir, '.hermes-nope'))).toBe(false)
  })

  it('scaffold writes no dead guard keys and the template search backend', async () => {
    await service.createOverlay({ name: 'nokey', searchBackend: 'ddgs' })
    const env = fs.readFileSync(path.join(tmpDir, '.hermes-nokey', '.env'), 'utf-8')
    for (const k of pkg.deadEnvKeys) expect(env).not.toContain(`${k}=`)
    expect(fs.readFileSync(path.join(tmpDir, '.hermes-nokey', 'config.yaml'), 'utf-8')).toMatch(/^  search_backend: ddgs$/m)
  })
})
