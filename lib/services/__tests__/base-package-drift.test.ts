// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkBasePackageDrift } from '../base-package-drift'
import { loadBasePackage, applyBasePackageToDir } from '../base-package'
import { generateDefaultConfig } from '../../templates/config-yaml'
import type { Key } from '@/lib/types'

const repoRoot = process.cwd()
const pkg = loadBasePackage(repoRoot)
let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-drift-'))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function seed(files: Record<string, string>) {
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dataDir, rel), c)
  }
}
function snapshot(): string {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const n of fs.readdirSync(path.join(dataDir, rel)).sort()) {
      const r = path.join(rel, n)
      if (fs.statSync(path.join(dataDir, r)).isDirectory()) walk(r)
      else out.push(`${r}:${fs.readFileSync(path.join(dataDir, r), 'utf-8')}`)
    }
  }
  walk('')
  return out.join('\n')
}
const ids = (r: ReturnType<typeof checkBasePackageDrift>) => r.findings.map((f) => f.id)

const brave = (assignedTo: string[]): Key => ({ id: 'k_brave', provider: 'brave', maskedValue: 'BSA…', assignedTo, health: 'healthy' } as unknown as Key)

describe('checkBasePackageDrift', () => {
  it('a cyborg-public-shaped agent: reports every problem class and writes nothing', () => {
    seed({
      'config.yaml': [
        'model:', '  provider: zai', '  default: glm-5.3',
        'fallback_providers:', '  - provider: anthropic', '    model: claude-sonnet-4-6',
        'plugins:', '  enabled: []',
        'web:', '  search_backend: brave-free',
      ].join('\n') + '\n',
      '.env': 'GLM_API_KEY=x\nDISCORD_ALLOWED_CHANNELS=1\nHERMES_DM_POLICY=approved-only\nCAPSOLVER_API_KEY=x\n',
      'SOUL.md': '# cyborg-public\n',
      'plugins/captcha_cascade/__init__.py': 'x',
      '.hsm-base-package': JSON.stringify({ version: '0.9.0', surface: 'public', packs: [] }),
    })
    const before = snapshot()
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_cyborg_public', keys: [brave(['h_other'])] })
    expect(snapshot()).toBe(before)
    expect(r.surface).toBe('public')
    expect(ids(r)).toEqual(expect.arrayContaining([
      'version-behind',
      'inline-plugins-enabled',
      'core-plugin-missing',
      'core-plugin-not-enabled',
      'required-key-missing',
      'dead-env-key',
      'fallback-without-key',
      'search-without-key',
      'orientation-missing',
      'public-dms-reachable',
      'public-toolset-enabled',
      'public-forbidden-artifact',
      'public-forbidden-env',
    ]))
    expect(r.ok).toBe(false)
  })

  it('flags key-store vs .env disagreement (matilde: Brave in .env, not in assignedTo)', () => {
    seed({ '.env': 'BRAVE_SEARCH_API_KEY=x\n', 'config.yaml': 'model:\n  provider: zai\n' })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_matilde', keys: [brave(['h_other'])] })
    expect(ids(r)).toContain('key-assignment-mismatch')
  })

  it('never prints a secret value', () => {
    seed({ '.env': 'BRAVE_SEARCH_API_KEY=BSAsupersecretvalue\nHERMES_DM_POLICY=approved-only\n', 'config.yaml': 'x: 1\n' })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_x', keys: [brave([])] })
    expect(JSON.stringify(r)).not.toContain('supersecret')
  })

  it('an agent freshly given the package (with its key) is clean', () => {
    seed({
      'config.yaml': generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.3' }),
      '.env': 'GLM_API_KEY=x\nBRAVE_SEARCH_API_KEY=x\n',
      'SOUL.md': '# a\n',
    })
    applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_a', keys: [brave(['h_a'])] })
    expect(r.findings.filter((f) => f.severity !== 'info')).toEqual([])
    expect(r.ok).toBe(true)
  })
})

describe('browser in the research layer', () => {
  it('flags a missing browser backend and a disabled browser toolset', () => {
    seed({
      'config.yaml': 'model:\n  provider: zai\nagent:\n  disabled_toolsets:\n    - browser\n',
      '.env': 'GLM_API_KEY=x\n',
      '.hsm-base-package': JSON.stringify({ version: pkg.version, surface: 'team', packs: [] }),
    })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_x' })
    expect(ids(r)).toEqual(expect.arrayContaining(['browser-backend-missing', 'browser-toolset-disabled']))
  })

  it('a public agent with a shared browser profile or browser login is flagged', () => {
    seed({
      'config.yaml': 'model:\n  provider: zai\n',
      '.env': 'CAMOFOX_URL=http://x:9377\nCAMOFOX_USER_ID=shared\nBROWSER_LOGIN_DESCRIPTORS=x\n',
      '.hsm-base-package': JSON.stringify({ version: pkg.version, surface: 'public', packs: [] }),
    })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_x' })
    const forbidden = r.findings.filter((f) => f.id === 'public-forbidden-env').map((f) => f.message).join('\n')
    expect(forbidden).toContain('CAMOFOX_USER_ID')
    expect(forbidden).toContain('BROWSER_LOGIN_DESCRIPTORS')
    expect(forbidden).not.toContain('CAMOFOX_URL')
    expect(ids(r)).not.toContain('browser-backend-missing')
  })
})

describe('public reachability + dead top-level toolsets (review fixes)', () => {
  it('flags a public Discord agent that the public cannot reach, and a top-level disabled_toolsets', () => {
    seed({
      'config.yaml': 'disabled_toolsets:\n  - discord_admin\nplugins:\n  enabled: []\n',
      // cyborg-public shape: allow-all was its only grant; no channel-scoped access.
      '.env': 'DISCORD_BOT_TOKEN=x\nDISCORD_ALLOW_ALL_USERS=false\nDISCORD_ALLOWED_USERS=\nDISCORD_ALLOWED_CHANNELS=111,222\n',
      '.hsm-base-package': JSON.stringify({ version: pkg.version, surface: 'public', packs: [] }),
    })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_pub' })
    const unreachable = r.findings.filter((f) => f.id === 'public-unreachable')
    expect(unreachable.map((f) => f.message).join('\n')).toMatch(/DISCORD_CHANNEL_SCOPED_ACCESS/)
    expect(ids(r)).toContain('dead-toplevel-disabled-toolsets')
    // names keys, never values
    expect(JSON.stringify(r)).not.toMatch(/111|222/)
  })

  it('is quiet when channel-scoped access and real channel ids are set', () => {
    seed({
      'config.yaml': 'plugins:\n  enabled:\n    - person_memory\n',
      '.env': 'DISCORD_BOT_TOKEN=x\nDISCORD_ALLOW_ALL_USERS=false\nDISCORD_CHANNEL_SCOPED_ACCESS=true\nDISCORD_ALLOWED_CHANNELS=111\n',
      '.hsm-base-package': JSON.stringify({ version: pkg.version, surface: 'public', packs: [] }),
    })
    const r = checkBasePackageDrift(dataDir, pkg, { harnessId: 'h_pub' })
    expect(ids(r)).not.toContain('public-unreachable')
    expect(ids(r)).not.toContain('dead-toplevel-disabled-toolsets')
  })

  it('apply warns (does not silently ship) a public agent nobody can talk to', () => {
    seed({
      'config.yaml': 'plugins:\n  enabled: []\n',
      '.env': 'DISCORD_BOT_TOKEN=x\nDISCORD_ALLOW_ALL_USERS=true\nDISCORD_ALLOWED_CHANNELS=0\nDISCORD_ALLOWED_USERS=*\n',
      'SOUL.md': '# p\n',
    })
    const rep = applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot, { dryRun: true })
    const w = rep.warnings.join('\n')
    expect(w).toMatch(/DISCORD_ALLOWED_CHANNELS has no real channel ids/)
    expect(w).toMatch(/re-opens DMs/)
  })
})
