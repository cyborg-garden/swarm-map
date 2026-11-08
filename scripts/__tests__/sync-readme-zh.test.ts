// @vitest-environment node
/**
 * scripts/sync-readme-zh.mjs keeps README.zh-CN.md in step with README.md
 * without a human. Everything except the model call is tested here: marker
 * parsing, drift detection against a real git history, prompt assembly, and the
 * validation that must refuse a model reply that would damage the README.
 *
 * The validation tests run against the REAL README pair, so a check that is too
 * strict to pass the translation we actually ship fails here, not in CI at 3am.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseMarker, stripMarker, withMarker, markerLines, buildPrompt, extractReadme,
  validate, readState, translate,
} from '../sync-readme-zh.mjs'

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'sync-readme-zh.mjs')
const EN = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const ZH = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8')
const BODY = stripMarker(ZH)

type Problems = string[]
const check = (zhBody: string, extra: Record<string, unknown> = {}): Problems =>
  validate({ newEn: EN, zhBody, prevZhBody: BODY, ...extra }) as Problems

describe('marker', () => {
  it('parses the shipped marker', () => {
    expect(parseMarker(ZH)).toMatch(/^[0-9a-f]{7,40}$/)
  })
  it('rejects a missing, malformed or self-contradicting marker', () => {
    expect(parseMarker(BODY)).toBeNull()
    expect(parseMarker('<!-- 译自 README.md @ zzz；如有出入，以英文版为准。 -->\n' + markerLines('abc1234')[1])).toBeNull()
    const [a] = markerLines('abc1234')
    const [, b] = markerLines('def5678')
    expect(parseMarker(`${a}\n${b}\n`)).toBeNull()
  })
  it('strip + re-add is the identity on the shipped file', () => {
    expect(withMarker(BODY, parseMarker(ZH))).toBe(ZH)
  })
  it('bumps both marker lines', () => {
    const out = withMarker(BODY, '1234abc')
    expect(parseMarker(out)).toBe('1234abc')
    expect(out).not.toContain(`@ ${parseMarker(ZH)}`)
  })
})

describe('validate', () => {
  it('accepts the translation we ship', () => {
    expect(check(BODY)).toEqual([])
  })
  it('rejects a dropped image', () => {
    const img = BODY.match(/<img [^\n]*\/>/)![0]
    expect(check(BODY.replace(img, '')).join()).toMatch(/image dropped/)
  })
  it('rejects a dropped code block', () => {
    const block = BODY.match(/```bash\n[\s\S]*?```\n/)![0]
    expect(check(BODY.replace(block, '')).join()).toMatch(/code block count/)
  })
  it('rejects a rewritten command but allows a translated comment', () => {
    expect(check(BODY.replace('pnpm install', 'npm install')).join()).toMatch(/code block 1 differs/)
    expect(check(BODY.replace('# 示例', '# 例子'))).toEqual([])
  })
  it('rejects a dropped link target', () => {
    expect(check(BODY.replaceAll('docs/runtimes.md', 'docs/runtime.md')).join()).toMatch(/link target dropped: docs\/runtimes\.md/)
  })
  it('rejects a truncated reply', () => {
    expect(check(BODY.slice(0, Math.floor(BODY.length / 2))).join()).toMatch(/shrank/)
  })
  it('rejects English passed back as the translation', () => {
    const en = EN.replace('# Swarm Map\n', '# Swarm Map\n\n[English](README.md) | **简体中文**\n')
    expect(check(en).join()).toMatch(/too little Chinese/)
  })
  it('rejects re-added API route tables', () => {
    const table = '\n| 方法 | 路径 | 说明 |\n|---|---|---|\n| `GET` | `/api/harnesses` | 列出 |\n'
    expect(check(BODY.replace('## 配置', `${table}\n## 配置`)).join()).toMatch(/route table/)
  })
  it('rejects a marker or tag leaking into the body, and a missing switcher', () => {
    expect(check(`${markerLines('abc1234')[0]}\n${BODY}`).join()).toMatch(/first line|marker/)
    expect(check(BODY + '\n</readme>').join()).toMatch(/readme> tag/)
    expect(check(BODY.replace('[English](README.md) | **简体中文**', '**简体中文**')).join()).toMatch(/switcher/)
  })
  it('rejects a dropped section', () => {
    expect(check(BODY.replace('## 许可证', '### 许可证')).join()).toMatch(/section count/)
  })
  it('rejects rewriting text the English did not change', () => {
    const smallDiff = '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n'
    const reworded = BODY.split("\n").map((l: string) => (/[一-鿿]/.test(l) && !l.startsWith('#') ? l.replace(/。/g, '．') : l)).join('\n')
    expect(check(reworded, { diff: smallDiff }).join()).toMatch(/unchanged Chinese lines/)
    expect(check(BODY, { diff: smallDiff })).toEqual([])
  })
})

describe('extractReadme', () => {
  it('takes the tagged body, tolerating a markdown fence and stray markers', () => {
    expect(extractReadme(`sure\n<readme>\n${BODY}</readme>\n`)!.trim()).toBe(BODY.trim())
    expect(extractReadme(`<readme>\n\`\`\`markdown\n${BODY}\`\`\`\n</readme>`)!.trim()).toBe(BODY.trim())
    expect(extractReadme(`<readme>\n${ZH}</readme>`)!.trim()).toBe(BODY.trim())
  })
  it('returns null without tags', () => {
    expect(extractReadme(BODY)).toBeNull()
    expect(extractReadme(undefined as unknown as string)).toBeNull()
  })
})

describe('buildPrompt', () => {
  it('carries old English, new English, the diff and the current Chinese', () => {
    const p = buildPrompt({ oldEn: 'OLD-EN', newEn: 'NEW-EN', diff: 'THE-DIFF', zhBody: 'ZH-BODY' })
    for (const s of ['<old_english>\nOLD-EN', '<new_english>\nNEW-EN', '<english_diff>\nTHE-DIFF', '<current_chinese>\nZH-BODY']) {
      expect(p.user).toContain(s)
    }
    expect(p.system).toMatch(/README\.md#api-reference/)
    expect(p.system).toMatch(/智能体/)
  })
  it('falls back to a minimal-change brief when the source commit is gone', () => {
    const p = buildPrompt({ oldEn: null, newEn: 'N', diff: null, zhBody: 'Z' })
    expect(p.user).toMatch(/could not be found/)
  })
})

// A throwaway repo with a real history, so drift detection is tested against git.
describe('drift detection (real git)', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = '' })

  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  function repo() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-sync-'))
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'test')
    g('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(dir, 'README.md'), EN)
    g('add', '.'); g('commit', '-qm', 'en')
    const sha = g('rev-parse', '--short=7', 'HEAD')
    fs.writeFileSync(path.join(dir, 'README.zh-CN.md'), withMarker(BODY, sha))
    g('add', '.'); g('commit', '-qm', 'zh')
    return sha
  }
  const run = (mode: string) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, mode], { cwd: dir, encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } }) }
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: err.stdout + err.stderr }
    }
  }
  const inDir = <T>(fn: () => T): T => { const cwd = process.cwd(); process.chdir(dir); try { return fn() } finally { process.chdir(cwd) } }

  it('is in sync when README.md has not changed since the marker', () => {
    repo()
    expect(run('--check').code).toBe(0)
    // A commit that touches only the translation is not drift either.
    fs.appendFileSync(path.join(dir, 'README.zh-CN.md'), '\n')
    g('commit', '-qam', 'zh tweak')
    expect(run('--check').code).toBe(0)
    expect(run('--dry-run').out).toMatch(/in sync/)
  })

  it('reports drift after an English change and targets the commit that made it', () => {
    const base = repo()
    fs.writeFileSync(path.join(dir, 'README.md'), EN.replace('## Quick Start', '## Quick Start\n\nNew paragraph.'))
    g('commit', '-qam', 'en change')
    const head = g('rev-parse', '--short=7', 'HEAD')
    expect(run('--check')).toMatchObject({ code: 3 })
    const st = inDir(() => readState())
    expect(st.sha).toBe(base)
    expect(st.headSha).toBe(head)
    expect(st.diff).toContain('+New paragraph.')
    const dry = run('--dry-run').out
    expect(dry).toContain('+New paragraph.')
    expect(dry).toContain('<current_chinese>')
    expect(dry).not.toContain('<!-- 译自')
    // --write refuses without a key rather than calling out.
    expect(run('--write').code).toBe(2)
  })

  it('treats an unknown marker commit as drift with no old English', () => {
    repo()
    fs.writeFileSync(path.join(dir, 'README.zh-CN.md'), withMarker(BODY, 'deadbee'))
    g('commit', '-qam', 'bad marker')
    expect(run('--check').code).toBe(3)
    const st = inDir(() => readState())
    expect(st.oldEn).toBeNull()
    expect(st.inSync).toBe(false)
  })
})

describe('translate (fake model)', () => {
  const state = { zh: ZH, newEn: EN, oldEn: EN, diff: '', headSha: 'abc1234', sha: parseMarker(ZH), inSync: false }
  const reply = (text: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 })

  it('writes the validated reply with a bumped marker', async () => {
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl: reply(`<readme>\n${BODY}</readme>`), log: () => {} })
    expect(parseMarker(out)).toBe('abc1234')
    expect(stripMarker(out)).toBe(BODY)
  })

  it('retries with the problems listed, then accepts', async () => {
    const seen: string[] = []
    let n = 0
    const fetchImpl = async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).messages[1].content)
      return reply(n++ === 0 ? '<readme>\nno</readme>' : `<readme>\n${BODY}</readme>`)()
    }
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl, log: () => {} })
    expect(parseMarker(out)).toBe('abc1234')
    expect(seen[1]).toMatch(/previous answer was rejected/)
  })

  it('throws, writing nothing, when every attempt fails validation or the API errors', async () => {
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl: reply('no tags'), log: () => {} })).rejects.toThrow(/rejected after 2 attempts/)
    const apiErr = async () => new Response(JSON.stringify({ error: { message: 'no credit' } }), { status: 402 })
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl: apiErr, log: () => {} })).rejects.toThrow(/OpenRouter 402/)
  })
})
