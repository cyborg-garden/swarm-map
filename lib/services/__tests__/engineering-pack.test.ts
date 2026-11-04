// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadBasePackage,
  selectArtifacts,
  validateSelection,
  applyBasePackageToDir,
  readStamp,
} from '../base-package'
import { checkBasePackageDrift } from '../base-package-drift'
import { generateDefaultConfig } from '../../templates/config-yaml'

const repoRoot = process.cwd()
const pkg = loadBasePackage(repoRoot)
const SKILLS = ['engineering-multiplayer', 'engineering-process']
const skillText = (name: string) =>
  fs.readFileSync(path.join(repoRoot, 'infra', 'templates', 'skills', name, 'SKILL.md'), 'utf-8')

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-eng-pack-'))
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.3' }))
  fs.writeFileSync(path.join(dataDir, 'SOUL.md'), '# me\n\nMy own persona.\n')
  fs.writeFileSync(path.join(dataDir, '.env'), 'HERMES_AGENT_NAME=me\n')
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('engineering pack', () => {
  it('is opt-in: a default selection has none of it', () => {
    const names = selectArtifacts(pkg, { surface: 'team', packs: [] }).skills.map((s) => s.name)
    for (const s of SKILLS) expect(names).not.toContain(s)
    applyBasePackageToDir(dataDir, pkg, { surface: 'team', packs: [] }, repoRoot)
    for (const s of SKILLS) expect(fs.existsSync(path.join(dataDir, 'skills', s))).toBe(false)
  })

  it('is two local skills and nothing else: no plugin, no hook', () => {
    const owned = <T extends { pack?: string }>(list: T[]) => list.filter((e) => e.pack === 'engineering')
    expect(owned(pkg.manifest.plugins)).toEqual([])
    expect(owned(pkg.manifest.hooks)).toEqual([])
    const skills = owned(pkg.manifest.skills)
    expect(skills.map((s) => s.name).sort()).toEqual(SKILLS)
    for (const s of skills) expect(s.source).toBe('local')
  })

  it('is refused on public and allowed on private and team', () => {
    expect(pkg.packs.engineering.public).toBe(false)
    expect(pkg.surfaces.public.forbiddenPacks).toContain('engineering')
    expect(() => validateSelection(pkg, { surface: 'public', packs: ['engineering'] })).toThrow(/public/)
    expect(() => validateSelection(pkg, { surface: 'private', packs: ['engineering'] })).not.toThrow()
    expect(() => validateSelection(pkg, { surface: 'team', packs: ['engineering'] })).not.toThrow()
  })

  it('an existing agent adopts it through sync, and a second run changes nothing', () => {
    const sel = { surface: 'team' as const, packs: ['engineering'] }
    applyBasePackageToDir(dataDir, pkg, sel, repoRoot)
    for (const s of SKILLS) expect(fs.existsSync(path.join(dataDir, 'skills', s, 'SKILL.md'))).toBe(true)
    expect(readStamp(dataDir)?.packs).toEqual(['engineering'])
    expect(applyBasePackageToDir(dataDir, pkg, sel, repoRoot).changed).toBe(false)
  })

  it('drift flags it when an agent later turns public', () => {
    applyBasePackageToDir(dataDir, pkg, { surface: 'team', packs: ['engineering'] }, repoRoot)
    const stampPath = path.join(dataDir, '.hsm-base-package')
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf-8'))
    fs.writeFileSync(stampPath, JSON.stringify({ ...stamp, surface: 'public' }))
    const report = checkBasePackageDrift(dataDir, pkg, { harnessId: 'x', repoRoot })
    expect(report.findings.filter((f) => f.id === 'public-forbidden-artifact').map((f) => f.message).join()).toMatch(/engineering pack/)
  })
})

describe('engineering skills text', () => {
  it.each(SKILLS)('%s has frontmatter naming its own directory and a description', (name) => {
    const text = skillText(name)
    expect(text.startsWith(`---\nname: ${name}\ndescription: `)).toBe(true)
  })

  // The runtime's skills index cuts descriptions to 57 characters, so the
  // trigger has to come first or the model never sees when to load the skill.
  it.each([
    ['engineering-process', 'Read before changing code, opening a PR, or saying done.'],
    ['engineering-multiplayer', 'Read before coding in a thread or shared checkout.'],
  ])('%s puts its whole trigger inside what the skills index shows', (name, trigger) => {
    const description = skillText(name).match(/^description: (.*)$/m)?.[1] ?? ''
    expect(description.slice(0, 57)).toContain(trigger)
    expect(description).not.toMatch(/: /) // would break the YAML frontmatter
  })

  it.each(SKILLS)('%s stays short and plain', (name) => {
    const text = skillText(name)
    expect(text.split('\n').length).toBeLessThanOrEqual(60)
    expect(text).not.toMatch(/[–—]/)
  })

  it.each(SKILLS)('%s says it grants no access', (name) => {
    expect(skillText(name)).toMatch(/grants no access/)
  })

  it.each(SKILLS)('%s handles no credentials: it never names a secret env var', (name) => {
    expect(skillText(name)).not.toMatch(/[A-Z][A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY)\b/)
    expect(skillText(name)).not.toMatch(/required_environment_variables|prerequisites:/)
  })
})
