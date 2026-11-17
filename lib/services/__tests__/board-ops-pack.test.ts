// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadBasePackage, selectArtifacts, validateSelection, applyBasePackageToDir } from '../base-package'
import { generateDefaultConfig } from '../../templates/config-yaml'

const repoRoot = process.cwd()
const pkg = loadBasePackage(repoRoot)
const skillDir = path.join(repoRoot, 'infra', 'templates', 'skills', 'garden-board')

let dataDir: string
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-board-pack-'))
  fs.writeFileSync(path.join(dataDir, 'config.yaml'), generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.3' }))
  fs.writeFileSync(path.join(dataDir, 'SOUL.md'), '# me\n')
  fs.writeFileSync(path.join(dataDir, '.env'), 'HERMES_AGENT_NAME=me\n')
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('board-ops pack', () => {
  it('is opt-in', () => {
    const names = selectArtifacts(pkg, { surface: 'team', packs: [] }).skills.map((s) => s.name)
    expect(names).not.toContain('garden-board')
  })

  it('is refused on public and allowed on private and team', () => {
    expect(pkg.packs['board-ops'].public).toBe(false)
    expect(pkg.surfaces.public.forbiddenPacks).toContain('board-ops')
    expect(() => validateSelection(pkg, { surface: 'public', packs: ['board-ops'] })).toThrow(/public/)
    expect(() => validateSelection(pkg, { surface: 'team', packs: ['board-ops'] })).not.toThrow()
  })

  it('ships the script and an example config, never a live config', () => {
    expect(fs.existsSync(path.join(skillDir, 'scripts', 'garden_board.py'))).toBe(true)
    expect(fs.existsSync(path.join(skillDir, 'config.example.json'))).toBe(true)
    expect(fs.existsSync(path.join(skillDir, 'config.json'))).toBe(false)
  })

  it('installs the whole skill directory', () => {
    applyBasePackageToDir(dataDir, pkg, { surface: 'team', packs: ['board-ops'] }, repoRoot)
    expect(fs.existsSync(path.join(dataDir, 'skills', 'garden-board', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(dataDir, 'skills', 'garden-board', 'scripts', 'garden_board.py'))).toBe(true)
  })
})
