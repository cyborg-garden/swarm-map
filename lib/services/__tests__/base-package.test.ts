// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadBasePackage,
  selectArtifacts,
  basePluginNames,
  validateSelection,
  upsertOrientation,
  orientationBlock,
  applyBasePackageToDir,
  readStamp,
  STAMP_FILE,
  ORIENTATION_START,
  ORIENTATION_END,
} from '../base-package'
import { installBaselineTemplates } from '../templates'
import { readBlockList } from '../../yaml-block-list'
import { generateDefaultConfig } from '../../templates/config-yaml'

const repoRoot = process.cwd()
const pkg = loadBasePackage(repoRoot)

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-base-'))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function seedAgent(opts: { config?: string; soul?: string; env?: string } = {}) {
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), opts.config ?? generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.3' }))
  fs.writeFileSync(path.join(dataDir, 'SOUL.md'), opts.soul ?? '# me\n\nMy own persona.\n')
  fs.writeFileSync(path.join(dataDir, '.env'), opts.env ?? 'HERMES_AGENT_NAME=me\nDISCORD_ALLOWED_CHANNELS=123\n')
}
const read = (f: string) => fs.readFileSync(path.join(dataDir, f), 'utf-8')

describe('base package definition (infra/artifacts.json)', () => {
  it('is versioned semver and every entry carries a tier', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const t of ['plugins', 'skills', 'hooks'] as const) {
      for (const e of pkg.manifest[t]) {
        expect(['core', 'pack'], `${t}/${e.name}`).toContain(e.tier)
        if (e.tier === 'pack') expect(pkg.packs[e.pack!], `${t}/${e.name} pack`).toBeDefined()
      }
    }
  })

  it('core = person_memory, swarm_map_policy, credential_redactor + image plugins; captcha is a pack', () => {
    const core = basePluginNames(pkg, { surface: 'team', packs: [] })
    expect(core).toEqual(expect.arrayContaining(['person_memory', 'swarm_map_policy', 'credential_redactor', 'observability', 'intelligent_routing']))
    expect(core).not.toContain('captcha_cascade')
    expect(core).not.toContain('boot_md') // shipped, off by default
    const sel = selectArtifacts(pkg, { surface: 'team', packs: [] })
    expect(sel.plugins.map((p) => p.name)).not.toContain('captcha_cascade')
    expect(sel.skills.map((s) => s.name)).not.toContain('captcha-escalation')
    expect(sel.skills.map((s) => s.name)).toContain('garden-orientation')
  })

  it('a pack is installed only when selected', () => {
    const sel = selectArtifacts(pkg, { surface: 'private', packs: ['browser-ops'] })
    expect(sel.plugins.map((p) => p.name)).toContain('captcha_cascade')
    expect(basePluginNames(pkg, { surface: 'private', packs: ['browser-ops'] })).toContain('captcha_cascade')
  })

  it('public refuses browser-ops (captcha / browser login never on a public bot)', () => {
    expect(() => validateSelection(pkg, { surface: 'public', packs: ['browser-ops'] })).toThrow(/public/)
    expect(() => validateSelection(pkg, { surface: 'team', packs: ['no-such-pack'] })).toThrow(/Unknown pack/)
  })

  it('no dead guard key is ever written by a profile', () => {
    for (const s of Object.values(pkg.surfaces)) {
      for (const k of Object.keys(s.env)) expect(pkg.deadEnvKeys).not.toContain(k)
    }
  })

  it('every manifest template exists in the repo', () => {
    for (const t of ['plugins', 'skills', 'hooks'] as const) {
      for (const e of pkg.manifest[t]) {
        expect(fs.existsSync(path.join(repoRoot, 'infra', 'templates', t, e.name)), `${t}/${e.name}`).toBe(true)
      }
    }
  })
})

describe('orientation block', () => {
  const block = orientationBlock(repoRoot)

  it('is short and bounded by markers', () => {
    expect(block.startsWith(ORIENTATION_START)).toBe(true)
    expect(block.trimEnd().endsWith(ORIENTATION_END)).toBe(true)
    expect(block.trim().split('\n').length).toBeLessThanOrEqual(14)
  })

  it('appends below an existing persona without touching it', () => {
    const soul = '# cyborg-public\n\nHand-written persona, 2026-08-11.\n'
    const { content, changed } = upsertOrientation(soul, block)
    expect(changed).toBe(true)
    expect(content.startsWith(soul)).toBe(true)
    expect(content).toContain(ORIENTATION_START)
  })

  it('is idempotent and replaces only between the markers', () => {
    const soul = `# x\n\nbefore\n\n${ORIENTATION_START}\nstale v0 text\n${ORIENTATION_END}\n\nafter\n`
    const once = upsertOrientation(soul, block)
    expect(once.content).toContain('before')
    expect(once.content).toContain('after')
    expect(once.content).not.toContain('stale v0 text')
    const twice = upsertOrientation(once.content, block)
    expect(twice.changed).toBe(false)
    expect(twice.content).toBe(once.content)
  })

  it('leaves a SOUL with a broken (unterminated) marker alone', () => {
    const soul = `# x\n${ORIENTATION_START}\nhalf\n`
    const r = upsertOrientation(soul, block)
    expect(r.changed).toBe(false)
    expect(r.content).toBe(soul)
  })
})

describe('applyBasePackageToDir — create-time injection', () => {
  it('writes the stamp, enables core plugins as a block list, adds orientation', async () => {
    seedAgent()
    await installBaselineTemplates(dataDir, { surface: 'team', packs: [] })
    const stamp = readStamp(dataDir)
    expect(stamp).toMatchObject({ version: pkg.version, surface: 'team', packs: [] })
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'credential_redactor', '__init__.py'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'captcha_cascade'))).toBe(false)
    expect(readBlockList(read('config.yaml'), 'plugins', 'enabled')).toEqual(
      expect.arrayContaining(['person_memory', 'swarm_map_policy', 'credential_redactor', 'observability', 'intelligent_routing']),
    )
    expect(read('config.yaml')).not.toMatch(/^\s+enabled:\s*\[/m)
    expect(read('SOUL.md')).toContain(ORIENTATION_START)
  })

  it('public surface: DMs off, terminal/code/file/discord toolsets off, pruned skills, no captcha', async () => {
    seedAgent()
    await installBaselineTemplates(dataDir, { surface: 'public', packs: [] })
    expect(read('.env')).toMatch(/^DISCORD_ALLOW_ALL_USERS=false$/m)
    expect(read('.env')).toMatch(/^DISCORD_ALLOWED_CHANNELS=123$/m) // kept
    const disabled = readBlockList(read('config.yaml'), 'agent', 'disabled_toolsets')
    expect(disabled).toEqual(expect.arrayContaining(['terminal', 'code_execution', 'file', 'discord']))
    const skills = readBlockList(read('config.yaml'), 'skills', 'disabled')
    expect(skills).toEqual(expect.arrayContaining(['captcha-escalation', 'himalaya', 'github-auth']))
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'captcha_cascade'))).toBe(false)
    expect(readStamp(dataDir)?.surface).toBe('public')
  })

  it('never writes the dead guard keys', async () => {
    seedAgent()
    await installBaselineTemplates(dataDir, { surface: 'public', packs: [] })
    for (const k of pkg.deadEnvKeys) expect(read('.env')).not.toContain(`${k}=`)
  })
})

describe('applyBasePackageToDir — adopting an existing agent (idempotent, no clobber)', () => {
  // The cyborg-public shape: inline [] plugins, hand-written persona, captcha
  // installed, its own skill, a customised plugin copy, people cards.
  function seedCyborgPublic() {
    seedAgent({
      config: 'model:\n  provider: zai\n  default: glm-5.3\nplugins:\n  enabled: []\nagent:\n  max_turns: 30\n  disabled_toolsets: [kanban]\ndiscord:\n  platforms:\n    enabled: []\n',
      soul: '# cyborg-public\n\nThe 2026-08-11 persona.\n',
      env: 'HERMES_AGENT_NAME=cyborg-public\nDISCORD_ALLOWED_CHANNELS=1,2\nHERMES_DM_POLICY=approved-only\n',
    })
    fs.mkdirSync(path.join(dataDir, 'plugins', 'captcha_cascade'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'plugins', 'captcha_cascade', '__init__.py'), 'legacy')
    fs.mkdirSync(path.join(dataDir, 'plugins', 'person_memory'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'plugins', 'person_memory', '__init__.py'), '# customised by the agent owner')
    fs.mkdirSync(path.join(dataDir, 'skills', 'garden-postcard'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'skills', 'garden-postcard', 'SKILL.md'), 'mine')
    fs.mkdirSync(path.join(dataDir, 'memories', 'people'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'memories', 'MEMORY.md'), 'memory')
    fs.writeFileSync(path.join(dataDir, 'memories', 'people', 'discord:1.md'), 'card')
  }

  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (rel: string) => {
      for (const n of fs.readdirSync(path.join(dir, rel))) {
        const r = path.join(rel, n)
        const st = fs.statSync(path.join(dir, r))
        if (st.isDirectory()) walk(r)
        else out[r] = fs.readFileSync(path.join(dir, r), 'utf-8')
      }
    }
    walk('')
    return out
  }

  it('adds what is missing and keeps every customisation', () => {
    seedCyborgPublic()
    const report = applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    expect(report.changed).toBe(true)
    // plugins: inline [] → block list with the core set
    const enabled = readBlockList(read('config.yaml'), 'plugins', 'enabled')!
    expect(enabled).toEqual(expect.arrayContaining(['person_memory', 'swarm_map_policy', 'credential_redactor', 'observability', 'intelligent_routing']))
    // the nested discord.platforms trap is untouched
    expect(read('config.yaml')).toContain('discord:\n  platforms:\n    enabled: []\n')
    // existing disabled toolset kept, public ones added
    expect(readBlockList(read('config.yaml'), 'agent', 'disabled_toolsets')).toEqual(
      expect.arrayContaining(['kanban', 'terminal', 'code_execution']),
    )
    expect(read('config.yaml')).toContain('max_turns: 30')
    // customised plugin copy, own skill, legacy captcha, memory: untouched
    expect(read('plugins/person_memory/__init__.py')).toBe('# customised by the agent owner')
    expect(read('skills/garden-postcard/SKILL.md')).toBe('mine')
    expect(read('plugins/captcha_cascade/__init__.py')).toBe('legacy')
    expect(read('memories/MEMORY.md')).toBe('memory')
    expect(read('memories/people/discord:1.md')).toBe('card')
    // persona kept, orientation below it
    expect(read('SOUL.md').startsWith('# cyborg-public\n\nThe 2026-08-11 persona.\n')).toBe(true)
    expect(read('SOUL.md')).toContain(ORIENTATION_START)
    // .env: DMs off added; dead key NOT removed (apply never removes) but reported
    expect(read('.env')).toMatch(/^DISCORD_ALLOW_ALL_USERS=false$/m)
    expect(read('.env')).toContain('HERMES_DM_POLICY=approved-only')
    // missing core artifacts installed
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'credential_redactor', '__init__.py'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'skills', 'garden-orientation', 'SKILL.md'))).toBe(true)
  })

  it('a second run changes nothing', () => {
    seedCyborgPublic()
    applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    const before = snapshot(dataDir)
    const again = applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    expect(again.changed).toBe(false)
    expect(snapshot(dataDir)).toEqual(before)
  })

  it('dryRun reports the plan and writes nothing', () => {
    seedCyborgPublic()
    const before = snapshot(dataDir)
    const plan = applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot, { dryRun: true })
    expect(plan.changed).toBe(true)
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(snapshot(dataDir)).toEqual(before)
    expect(fs.existsSync(path.join(dataDir, STAMP_FILE))).toBe(false)
  })

  it('does not install a pack the agent did not select', () => {
    seedAgent()
    applyBasePackageToDir(dataDir, pkg, { surface: 'team', packs: [] }, repoRoot)
    expect(fs.existsSync(path.join(dataDir, 'plugins', 'captcha_cascade'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'skills', 'captcha-escalation'))).toBe(false)
  })

  it('wires the browser backend (research layer) on every surface, without a shared profile', () => {
    for (const surface of ['team', 'public'] as const) {
      fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir)
      seedAgent()
      const r = applyBasePackageToDir(dataDir, pkg, { surface, packs: [] }, repoRoot)
      expect(read('.env')).toContain(`CAMOFOX_URL=${pkg.research.browser!.defaultUrl}\n`)
      expect(read('.env')).not.toContain('CAMOFOX_USER_ID=')
      expect(r.steps.some((s) => s.kind === 'browser')).toBe(true)
    }
  })

  it('never overwrites an agent\'s own browser backend', () => {
    seedAgent({ env: 'HERMES_AGENT_NAME=me\nCAMOFOX_URL=http://camofox-own:9380\n' })
    applyBasePackageToDir(dataDir, pkg, { surface: 'team', packs: [] }, repoRoot)
    expect(read('.env').match(/^CAMOFOX_URL=.*$/gm)).toEqual(['CAMOFOX_URL=http://camofox-own:9380'])
  })

  it('warns (does not silently ship) when the browser toolset is disabled', () => {
    seedAgent({ config: 'model:\n  provider: zai\nagent:\n  disabled_toolsets:\n    - browser\n' })
    const r = applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    expect(r.warnings.join('\n')).toMatch(/browser toolset is disabled/)
    // add-only: apply never re-enables it on its own
    expect(readBlockList(read('config.yaml'), 'agent', 'disabled_toolsets')).toContain('browser')
  })

  it('tightens a public agent that had DMs open (surface contract)', () => {
    seedAgent({ env: 'DISCORD_ALLOW_ALL_USERS=true\n' })
    applyBasePackageToDir(dataDir, pkg, { surface: 'public', packs: [] }, repoRoot)
    expect(read('.env')).toMatch(/^DISCORD_ALLOW_ALL_USERS=false$/m)
    expect(read('.env').match(/DISCORD_ALLOW_ALL_USERS=/g)!.length).toBe(1)
  })
})
