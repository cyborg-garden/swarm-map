import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { installPackToDir } from '../pack-install'
import { loadBasePackage, STAMP_FILE } from '../base-package'
import { parseGitSource, type GitSource } from '../artifacts-manifest'

const REPO = process.cwd()
let tmp: string
let agentDir: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-pack-'))
  agentDir = path.join(tmp, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'model:\n  default: x\nplugins:\n  enabled:\n    - person_memory\n')
  fs.writeFileSync(path.join(agentDir, STAMP_FILE), JSON.stringify({ version: '1.1.0', surface: 'private', packs: [] }))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

// A stand-in for the pinned repo: one benign file per subdir.
function fakeFetch(seen: GitSource[]) {
  return (src: GitSource) => {
    seen.push(src)
    const d = path.join(tmp, 'fetched', String(seen.length))
    fs.mkdirSync(d, { recursive: true })
    if (src.subdir === 'hermes-plugin') {
      fs.writeFileSync(path.join(d, 'plugin.yaml'), 'name: papareo_transcribe\n')
      fs.writeFileSync(path.join(d, '__init__.py'), 'def register(ctx):\n    pass\n')
    } else {
      fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: papareo-transcribe\n---\nTranscribe recordings.\n')
    }
    return d
  }
}

describe('papareo-transcription pack', () => {
  it('is in the registry, private-only, pinned to a cyborg-garden tag', () => {
    const pkg = loadBasePackage(REPO)
    expect(pkg.packs['papareo-transcription']?.public).toBe(false)
    const entries = [...pkg.manifest.plugins, ...pkg.manifest.skills].filter(
      (e) => (e as { pack?: string }).pack === 'papareo-transcription',
    )
    expect(entries.map((e) => e.name).sort()).toEqual(['papareo-transcribe', 'papareo_transcribe'])
    for (const e of entries) {
      const g = parseGitSource(e.source)
      expect(`${g?.org}/${g?.repo}`).toBe('cyborg-garden/papareo-transcribe')
      expect(g?.ref).toMatch(/^v\d+\.\d+\.\d+$/)
    }
  })

  it('installs git-sourced plugin + skill, enables the plugin and stamps the pack', async () => {
    const seen: GitSource[] = []
    const r = await installPackToDir(agentDir, 'papareo-transcription', { repoRoot: REPO, gitFetch: fakeFetch(seen) })
    expect(r.installed).toBe(true)
    expect(seen.map((s) => s.subdir).sort()).toEqual(['hermes-plugin', 'hermes-skill'])
    expect(fs.existsSync(path.join(agentDir, 'plugins', 'papareo_transcribe', 'plugin.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'skills', 'papareo-transcribe', 'SKILL.md'))).toBe(true)
    const cfg = fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf-8')
    expect(cfg).toMatch(/- person_memory\n/)
    expect(cfg).toMatch(/- papareo_transcribe\n/)
    expect(r.pluginsEnabled).toEqual(['papareo_transcribe'])
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, STAMP_FILE), 'utf-8')).packs).toEqual(['papareo-transcription'])
  })

  it('is idempotent: a second run fetches nothing and changes nothing', async () => {
    const seen: GitSource[] = []
    await installPackToDir(agentDir, 'papareo-transcription', { repoRoot: REPO, gitFetch: fakeFetch(seen) })
    const cfg = fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf-8')
    const again = await installPackToDir(agentDir, 'papareo-transcription', { repoRoot: REPO, gitFetch: fakeFetch(seen) })
    expect(seen).toHaveLength(2)
    expect(again.results.every((x) => x.skipped)).toBe(true)
    expect(again.pluginsEnabled).toEqual([])
    expect(fs.readFileSync(path.join(agentDir, 'config.yaml'), 'utf-8')).toBe(cfg)
  })

  it('refuses on a public agent and writes nothing', async () => {
    fs.writeFileSync(path.join(agentDir, STAMP_FILE), JSON.stringify({ version: '1.1.0', surface: 'public', packs: [] }))
    await expect(
      installPackToDir(agentDir, 'papareo-transcription', { repoRoot: REPO, gitFetch: fakeFetch([]) }),
    ).rejects.toThrow(/not allowed on a public surface/)
    expect(fs.existsSync(path.join(agentDir, 'plugins'))).toBe(false)
  })

  it('refuses an unknown pack', async () => {
    await expect(installPackToDir(agentDir, 'nope', { repoRoot: REPO })).rejects.toThrow(/Unknown pack/)
  })
})
