// @vitest-environment node
/**
 * scripts/sync-readme-zh.mjs keeps README.zh-CN.md in step with README.md
 * without a human. Everything except the model call is tested here: marker
 * parsing, drift detection against a real git history, prompt assembly, and the
 * validation that must refuse a model reply that would damage the README.
 *
 * The validation tests run against a REAL README pair, so a check that is too
 * strict to pass the translation we actually ship fails here, not in CI at 3am.
 *
 * That pair is the snapshot in fixtures/readme-pair/, not the files at the repo
 * root. The root files are only in step on main: a pull request that changes
 * README.md (say, a new link) is ahead of the translations until the sync runs
 * after the merge, and tests reading the root files failed every such PR with
 * "link target dropped". The sync refreshes the snapshot in the same commit as
 * the translations, and the 'snapshot' tests below hold it to the shipped files.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseMarker, stripMarker, withMarker, markerLines, buildPrompt, extractReadme,
  validate, readState, translate, parseArgs, LOCALES, SNAPSHOT_DIR, refreshSnapshot,
  htmlUrls, normalizeUrl, renderedUrlKeys, renderedLinkProblems, githubRenderer,
} from '../sync-readme-zh.mjs'
// Real POST /markdown responses (gfm, context cyborg-garden/swarm-map), captured
// 2026-11-09. The per-render image jwt is redacted; normalizeUrl drops it anyway.
import RENDERS from './fixtures/readme-zh-render.json'

const ROOT = path.resolve(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'sync-readme-zh.mjs')
const SNAP = path.join(ROOT, SNAPSHOT_DIR)
const EN = fs.readFileSync(path.join(SNAP, 'README.md'), 'utf8')
const ZH = fs.readFileSync(path.join(SNAP, 'README.zh-CN.md'), 'utf8')
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
  it('rejects a link or image URL that is in neither the English nor the current translation', () => {
    const link = check(BODY.replace('## 许可证', '## 许可证\n\n详见 [这里](https://evil.example.net/x)。'))
    expect(link.join()).toMatch(/not in the English or current translation: evil\.example\.net\/x/)
    const img = check(BODY.replace('## 许可证', '## 许可证\n\n<img alt="x" src="https://evil.example.net/p.png" />'))
    expect(img.join()).toMatch(/not in the English or current translation: evil\.example\.net\/p\.png/)
    const rel = check(BODY.replace('## 许可证', '## 许可证\n\n[文档](docs/invented.md)'))
    expect(rel.join()).toMatch(/not in the English or current translation: docs\/invented\.md/)
    // A URL the current translation already carries (README.md#api-reference) stays allowed.
    expect(check(BODY)).toEqual([])
  })
  // One case per URL form a model could slip a new target through.
  it.each([
    ['HTML <a href>', '<a href="https://evil.example.net/a">这里</a>', 'evil.example.net/a'],
    ['relative HTML href', '<a href="docs/invented.md">这里</a>', 'docs/invented.md'],
    ['protocol-relative HTML src', '<img alt="x" src="//evil.example.net/s.png" />', 'evil.example.net/s.png'],
    ['single-quoted href', "<a href='https://evil.example.net/q'>这里</a>", 'evil.example.net/q'],
    ['reference definition', '详见 [这里][r]。\n\n[r]: https://evil.example.net/ref', 'evil.example.net/ref'],
    ['protocol-relative reference', '[r]: //evil.example.net/pr', 'evil.example.net/pr'],
    ['protocol-relative inline', '详见 [这里](//evil.example.net/pi)。', 'evil.example.net/pi'],
    ['bare protocol-relative', '访问 //evil.example.net/bp 即可。', 'evil.example.net/bp'],
    ['bare www.', '访问 www.evil-example.net/w。', 'evil-example.net/w'],
    ['autolink', '<https://evil.example.net/auto>', 'evil.example.net/auto'],
    ['www autolink', '<www.evil-example.net/wa>', 'evil-example.net/wa'],
    ['inline link with title', '[这里](https://evil.example.net/t "标题")', 'evil.example.net/t'],
    ['new path on a known host', '[这里](https://github.com/cyborg-garden/not-a-repo)', 'github.com/cyborg-garden/not-a-repo'],
    ['image in markdown form', '![x](https://evil.example.net/i.png)', 'evil.example.net/i.png'],
  ])('rejects an added URL written as %s', (_form, snippet, key) => {
    const problems = check(BODY.replace('## 许可证', `## 许可证\n\n${snippet}\n`)).join('\n')
    expect(problems).toContain(`not in the English or current translation: ${key}`)
  })
  // Forms the link-syntax extractor cannot see; only the token backstop catches these.
  it.each([
    ['underscore-wrapped URL', '详见 _https://evil.com_。', 'evil.com'],
    ['underscore-wrapped www', '详见 _www.evil.com_。', 'www.evil.com'],
    ['underscore in a host label', '访问 www.a_b.evil.com 即可。', 'www.a_b.evil.com'],
    ['bare mailto', '联系 mailto:a@example.org。', 'example.org'],
    ['bare email', '联系 a@example.com。', 'example.com'],
    ['host inside a code span', '运行 `curl evil.example.org/x`。', 'evil.example.org'],
    ['punycode host', '访问 xn--80ak6aa92e.xn--p1ai 即可。', 'xn--80ak6aa92e.xn--p1ai'],
    ['subdomain of a known host', '访问 evil.github.com 即可。', 'evil.github.com'],
  ])('backstop rejects a new host written as %s', (_form, snippet, token) => {
    const problems = check(BODY.replace('## 许可证', `## 许可证\n\n${snippet}\n`)).join('\n')
    expect(problems).toContain(`domain-like token not in the English or current translation: ${token}`)
  })
  it('backstop allows filenames and hosts the sources already carry', () => {
    // Each of these is in the snapshot README pair; `SOUL.md` is the agent's
    // persona file, which the README names wherever it describes an agent.
    const known = '见 `README.md`、`SOUL.md`、Next.js 和 github.com。'
    expect(check(BODY.replace('## 许可证', `## 许可证\n\n${known}\n`))).toEqual([])
  })
  it("main's real README pair passes the whole validation, backstop included", () => {
    expect(check(BODY)).toEqual([])
    expect(check(BODY, { diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n' })).toEqual([])
  })
  it('treats the same target written another way as known', () => {
    // Targets come from the snapshot English, not from a hard-coded URL: the
    // README's links change, and the snapshot follows them.
    const www = EN.match(/\]\(https:\/\/(www\.[^)\s]+?)\/?\)/)?.[1]
    const gh = EN.match(/\]\(https:(\/\/github\.com\/[^)\s#]+?)\/?\)/)![1]
    const same = `${gh}/ ` + (www ? `<a href="https://${www}">x</a> ${www}` : '')
    expect(check(BODY.replace('## 许可证', `## 许可证\n\n${same}\n`))).toEqual([])
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

// Traditional Chinese (Taiwan). README.zh-TW.md is new, so the synthetic body
// (the zh-CN body with the zh-TW switcher) keeps these tests independent of it;
// the shipped file (its snapshot) is checked too when present.
const TW_PATH = path.join(SNAP, 'README.zh-TW.md')
const TW = fs.existsSync(TW_PATH) ? fs.readFileSync(TW_PATH, 'utf8') : null
const TW_SYNTH = BODY.replace(/^\[English\]\(README\.md\).*$/m, LOCALES['zh-TW'].switcher)

describe('zh-TW', () => {
  it('builds, parses and strips its own marker, and not the zh-CN one', () => {
    const [l1] = markerLines('abc1234', 'zh-TW')
    expect(l1).toBe('<!-- 譯自 README.md @ abc1234；如有出入，以英文版為準。 -->')
    const out = withMarker(TW_SYNTH, 'abc1234', 'zh-TW')
    expect(parseMarker(out, 'zh-TW')).toBe('abc1234')
    expect(parseMarker(out)).toBeNull()
    expect(parseMarker(withMarker(BODY, 'abc1234'), 'zh-TW')).toBeNull()
    expect(stripMarker(out, 'zh-TW')).toBe(TW_SYNTH)
    expect(withMarker(stripMarker(out, 'zh-TW'), 'abc1234', 'zh-TW')).toBe(out)
  })
  it.skipIf(!TW)('strip + re-add is the identity on the shipped README.zh-TW.md', () => {
    const sha = parseMarker(TW as string, 'zh-TW')
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(withMarker(stripMarker(TW as string, 'zh-TW'), sha as string, 'zh-TW')).toBe(TW)
  })
  it('prompt asks for Taiwan usage and terminology, zh-CN prompt unchanged', () => {
    const p = buildPrompt({ oldEn: 'O', newEn: 'N', diff: 'D', zhBody: 'Z' }, 'zh-TW')
    expect(p.system).toMatch(/Traditional Chinese/)
    expect(p.system).toMatch(/Taiwan/)
    for (const w of ['軟體', '程式碼', '預設', '伺服器', '儲存庫', '連接埠', '快取', '代理', '執行環境', '模型級聯', '多租戶', 'API 參考', '「」', '（英文）', LOCALES['zh-TW'].switcher]) {
      expect(p.system).toContain(w)
    }
    expect(p.system).not.toMatch(/智能体/)
    const cn = buildPrompt({ oldEn: 'O', newEn: 'N', diff: 'D', zhBody: 'Z' })
    expect(cn.system).toMatch(/Simplified Chinese/)
    expect(cn.system).toContain(LOCALES['zh-CN'].switcher)
  })
  it('validate accepts a valid zh-TW body', () => {
    expect(validate({ newEn: EN, zhBody: TW_SYNTH, prevZhBody: TW_SYNTH })).toEqual([])
  })
  it.skipIf(!TW)('validate accepts the shipped README.zh-TW.md', () => {
    const body = stripMarker(TW as string, 'zh-TW')
    expect(validate({ newEn: EN, zhBody: body, prevZhBody: body })).toEqual([])
  })
  it('validate rejects a 譯自 marker leaking into the body', () => {
    const leaked = TW_SYNTH.replace('## 许可证', `${markerLines('abc1234', 'zh-TW')[0]}\n\n## 许可证`)
    expect(validate({ newEn: EN, zhBody: leaked, prevZhBody: TW_SYNTH }).join()).toMatch(/marker comment/)
  })
  it('extractReadme strips a zh-TW marker the model echoed', () => {
    expect(extractReadme(`<readme>\n${withMarker(TW_SYNTH, 'abc1234', 'zh-TW')}</readme>`, 'zh-TW')!.trim()).toBe(TW_SYNTH.trim())
  })
})

describe('parseArgs', () => {
  it('defaults to --check zh-CN and accepts --locale in either position', () => {
    expect(parseArgs([])).toEqual({ mode: '--check', locale: 'zh-CN' })
    expect(parseArgs(['--write', '--locale', 'zh-TW'])).toEqual({ mode: '--write', locale: 'zh-TW' })
    expect(parseArgs(['--locale=zh-TW', '--dry-run'])).toEqual({ mode: '--dry-run', locale: 'zh-TW' })
    expect(parseArgs(['--check', '--locale', 'all'])).toEqual({ mode: '--check', locale: 'all' })
  })
  it('rejects an unknown locale, a missing value and all outside --check', () => {
    expect(parseArgs(['--locale', 'zh-HK']).error).toMatch(/unknown locale/)
    expect(parseArgs(['--check', '--locale']).error).toMatch(/needs a value/)
    expect(parseArgs(['--write', '--locale', 'all']).error).toMatch(/--check only/)
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
  const run = (mode: string, ...extra: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, mode, ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } }) }
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

  it('tracks each locale on its own marker, and --locale all reports any drift', () => {
    const base = repo()
    // No README.zh-TW.md yet: a clear error, not a silent pass.
    const missing = run('--check', '--locale', 'zh-TW')
    expect(missing.code).toBe(1)
    expect(missing.out).toMatch(/README\.zh-TW\.md not found/)
    fs.writeFileSync(path.join(dir, 'README.zh-TW.md'), withMarker(TW_SYNTH, base, 'zh-TW'))
    g('add', '.'); g('commit', '-qm', 'zh-TW')
    expect(run('--check', '--locale', 'zh-TW').code).toBe(0)
    expect(run('--check', '--locale', 'all').code).toBe(0)
    // A zh-CN marker in the zh-TW file is malformed for zh-TW.
    fs.writeFileSync(path.join(dir, 'README.zh-TW.md'), withMarker(TW_SYNTH, base))
    g('commit', '-qam', 'wrong marker')
    expect(run('--check', '--locale', 'zh-TW').code).toBe(3)
    expect(run('--check').code).toBe(0)
    expect(run('--check', '--locale', 'all').code).toBe(3)
    const st = inDir(() => readState('zh-TW'))
    expect(st.sha).toBeNull()
    expect(st.file).toBe('README.zh-TW.md')
    expect(run('--dry-run', '--locale', 'zh-TW').out).toMatch(/Taiwan/)
    expect(run('--check', '--locale', 'xx').code).toBe(2)
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

// Stand-in renderer: link-free HTML, so the rendered check passes and the
// model-loop behaviour is what these tests see.
const fakeRender = async () => '<p dir="auto">x</p>'

describe('translate (fake model)', () => {
  const state = { zh: ZH, newEn: EN, oldEn: EN, diff: '', headSha: 'abc1234', sha: parseMarker(ZH), inSync: false }
  const reply = (text: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 })

  it('writes the validated reply with a bumped marker', async () => {
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl: reply(`<readme>\n${BODY}</readme>`), render: fakeRender, log: () => {} })
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
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl, render: fakeRender, log: () => {} })
    expect(parseMarker(out)).toBe('abc1234')
    expect(seen[1]).toMatch(/previous answer was rejected/)
  })

  it('throws, writing nothing, when every attempt fails validation or the API errors', async () => {
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl: reply('no tags'), render: fakeRender, log: () => {} })).rejects.toThrow(/rejected after 2 attempts/)
    const apiErr = async () => new Response(JSON.stringify({ error: { message: 'no credit' } }), { status: 402 })
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl: apiErr, render: fakeRender, log: () => {} })).rejects.toThrow(/OpenRouter 402/)
  })
})

type Render = { markdown: string; html: string }
const R = RENDERS as Record<string, Render>

describe('rendered link check (GitHub render fixtures)', () => {
  // Each audit bypass, as GitHub really renders it, and the URL a browser follows.
  it.each([
    ['blockquote_ref', 'https://evil.example.net/bq'],
    ['ref_next_line', 'https://evil.example.net/nl'],
    ['escaped_label', 'https://evil.example.net/esc'],
    ['pct_dot', 'https://evil.example.net/p'],
    ['ideographic_dot', 'https://evil.example.net/i'],
    ['idn_www', 'http://www.xn--e1afmkfd.xn--p1ai/'],
    ['underscore_url', 'https://evil.example.net/u_。'],
    ['underscore_label', 'http://www.a_b.evil.example.net/'],
    ['bare_mailto', 'mailto:a@example.org'],
    ['bare_email', 'mailto:a@example.org'],
  ])('%s resolves to %s and is rejected', (name, key) => {
    expect([...renderedUrlKeys(R[name].html)]).toContain(key)
    const problems = renderedLinkProblems({ enHtml: R.known_links.html, prevZhHtml: R.known_links.html, candidateHtml: R[name].html })
    expect(problems).toContain(`rendered link not in the English or current translation: ${key}`)
  })
  it('emphasised www. text renders as no link (the domain backstop covers it)', () => {
    expect(renderedUrlKeys(R.underscore_www.html).size).toBe(0)
    expect(check(BODY.replace('## 许可证', `## 许可证\n\n${R.underscore_www.markdown}\n`)).join()).toMatch(/domain-like token/)
  })
  it('known links pass, relative links resolve against the repo, image jwt is ignored', () => {
    expect(renderedLinkProblems({ enHtml: R.known_links.html, prevZhHtml: '', candidateHtml: R.known_links.html })).toEqual([])
    const keys = [...renderedUrlKeys(R.known_links.html)]
    expect(keys).toContain('https://github.com/cyborg-garden/swarm-map/blob/main/README.md')
    expect(keys).toContain('https://github.com/cyborg-garden/swarm-map/blob/main/docs/runtimes.md')
    const img = R.known_links.html.replace(/jwt=REDACTED/g, 'jwt=another-render')
    expect(renderedLinkProblems({ enHtml: R.known_links.html, prevZhHtml: '', candidateHtml: img })).toEqual([])
  })
  it('reads every URL attribute, decodes entities, splits srcset', () => {
    const html = '<form action="/a"><button formaction="//b.example.net/x"></button></form><video poster="https://c.example.net/p"></video>'
      + '<object data="https://d.example.net/o"></object><img srcset="https://e.example.net/1x.png 1x, https://f.example.net/2x.png 2x">'
      + '<a href="https://g.example.net/?a=1&amp;b=2">x</a><a href=\'https://h.example.net/&#x2e;\'>y</a>'
    expect(htmlUrls(html)).toEqual(['/a', '//b.example.net/x', 'https://c.example.net/p', 'https://d.example.net/o',
      'https://e.example.net/1x.png', 'https://f.example.net/2x.png', 'https://g.example.net/?a=1&b=2', 'https://h.example.net/.'])
  })
  it('normalises the way a browser resolves', () => {
    expect(normalizeUrl('#section')).toBeNull()
    expect(normalizeUrl('HTTPS://EVIL.Example.NET/a#frag')).toBe('https://evil.example.net/a')
    expect(normalizeUrl('//evil%2Eexample%2Enet/p')).toBe(normalizeUrl('https://evil.example.net/p'))
    expect(normalizeUrl('http://[bad')).toMatch(/^unparseable:/)
    // The query of a mailto: or tel: link is part of what it does.
    expect(normalizeUrl('mailto:a@example.org?bcc=b@example.com')).toBe('mailto:a@example.org?bcc=b@example.com')
    expect(normalizeUrl('tel:+1234567890?x=1')).toBe('tel:+1234567890?x=1')
    const known = '<a href="mailto:a@example.org">a</a>'
    const bcc = '<a href="mailto:a@example.org?bcc=b%40example.com">a</a>'
    expect(renderedLinkProblems({ enHtml: known, prevZhHtml: '', candidateHtml: known })).toEqual([])
    expect(renderedLinkProblems({ enHtml: known, prevZhHtml: '', candidateHtml: bcc })).toEqual([
      'rendered link not in the English or current translation: mailto:a@example.org?bcc=b@example.com',
    ])
  })
})

describe('githubRenderer (fails closed)', () => {
  it('refuses without a token', () => {
    expect(() => githubRenderer({ token: '' })).toThrow(/GITHUB_TOKEN/)
  })
  it('sends gfm with the repo as context and throws on an API error or empty body', async () => {
    let sent: { text: string; mode: string; context: string } | null = null
    const ok = githubRenderer({ token: 't', fetchImpl: (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response('<p>x</p>', { status: 200 }) }) as unknown as typeof fetch })
    expect(await ok('hi')).toBe('<p>x</p>')
    expect(sent).toEqual({ text: 'hi', mode: 'gfm', context: 'cyborg-garden/swarm-map' })
    const bad = githubRenderer({ token: 't', fetchImpl: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch })
    await expect(bad('hi')).rejects.toThrow(/HTTP 502/)
    const empty = githubRenderer({ token: 't', fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch })
    await expect(empty('hi')).rejects.toThrow(/empty/)
  })
  it('translate refuses to run without a renderer, and a render error writes nothing', async () => {
    const state = { zh: ZH, newEn: EN, oldEn: EN, diff: '', headSha: 'abc1234', sha: parseMarker(ZH), inSync: false }
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: `<readme>\n${BODY}</readme>` } }] }), { status: 200 })
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl, log: () => {} })).rejects.toThrow(/no markdown renderer/)
    const boom = async () => { throw new Error('GitHub markdown render failed: HTTP 500') }
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl, render: boom, log: () => {} })).rejects.toThrow(/HTTP 500/)
  })
  it('rejects a reply whose rendered links add a URL, then accepts a clean retry', async () => {
    const state = { zh: ZH, newEn: EN, oldEn: EN, diff: '', headSha: 'abc1234', sha: parseMarker(ZH), inSync: false }
    let n = 0
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: `<readme>\n${BODY}</readme>` } }] }), { status: 200 })
    // Sources render to the known links; the first candidate render adds a bypass link.
    let renders = 0
    const render = async () => (++renders === 3 && n++ === 0 ? R.pct_dot.html : R.known_links.html)
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl, render, log: () => {} })
    expect(parseMarker(out)).toBe('abc1234')
    expect(renders).toBe(4)
  })
})

// Optional: the real API against the real README pair. Skipped without a token.
describe.skipIf(!process.env.README_SYNC_LIVE_TOKEN)('live GitHub render', () => {
  it("main's README pair has no rendered link outside English ∪ current zh", async () => {
    const render = githubRenderer({ token: process.env.README_SYNC_LIVE_TOKEN as string })
    const [en, zh] = await Promise.all([render(EN), render(BODY)])
    expect(renderedLinkProblems({ enHtml: en, prevZhHtml: zh, candidateHtml: await render(BODY) })).toEqual([])
    // Against the English alone, the only extra is the switcher's link back to README.md.
    expect(renderedLinkProblems({ enHtml: en, prevZhHtml: '', candidateHtml: zh })).toEqual([
      'rendered link not in the English or current translation: https://github.com/cyborg-garden/swarm-map/blob/main/README.md',
    ])
  }, 60_000)
})

describe('exact switcher per locale', () => {
  it('accepts the real files and rejects a wrong switcher', async () => {
    const fs = await import('node:fs')
    const { validate: v, stripMarker: sm } = await import('../sync-readme-zh.mjs')
    const en = fs.readFileSync(path.join(SNAP, 'README.md'), 'utf8')
    for (const [loc, file] of [['zh-CN', 'README.zh-CN.md'], ['zh-TW', 'README.zh-TW.md']] as const) {
      const body = sm(fs.readFileSync(path.join(SNAP, file), 'utf8'), loc)
      expect(v({ newEn: en, zhBody: body, prevZhBody: body, locale: loc })).toEqual([])
      const bad = body.replace(/^\[English\]\(README\.md\).*$/m, '[English](README.md) | **简体中文**')
      expect(v({ newEn: en, zhBody: bad, prevZhBody: body, locale: loc }).join()).toMatch(/switcher line is not exactly/)
    }
  })
})

// The snapshot must stay the pair we ship. The translations at the repo root
// are written only by the sync, which refreshes the snapshot in the same
// commit, so this holds on main and on any PR that does not hand-edit them.
// README.md is deliberately NOT compared: a PR is allowed to be ahead there.
describe('snapshot (fixtures/readme-pair)', () => {
  it.each(Object.values(LOCALES).map((l) => l.file))('%s at the repo root equals its snapshot', (file) => {
    const live = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const snap = fs.readFileSync(path.join(SNAP, file), 'utf8')
    expect(live === snap, `${file} differs from ${SNAPSHOT_DIR}/${file}. The sync refreshes both in one commit; `
      + 'after a hand edit to a translation run: node scripts/sync-readme-zh.mjs --snapshot').toBe(true)
  })

  // The script's own state check, against this repo's history. A shallow clone
  // (CI) may not have the marker commit; then there is nothing to compare.
  const sha = parseMarker(ZH)
  const show = (rev: string) => {
    try { return execFileSync('git', ['show', `${rev}:README.md`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }) } catch { return null }
  }
  const markerEn = sha ? show(sha) : null
  it('both snapshot translations name the same English commit', () => {
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(parseMarker(TW as string, 'zh-TW')).toBe(sha)
  })
  it.skipIf(markerEn == null)('the snapshot English is README.md at the commit the translations name', () => {
    expect(EN).toBe(markerEn)
  })
})

describe('refreshSnapshot (real git)', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = '' })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
  const inDir = <T>(fn: () => T): T => { const cwd = process.cwd(); process.chdir(dir); try { return fn() } finally { process.chdir(cwd) } }
  const cli = (...a: string[]) => {
    try { return { code: 0, out: execFileSync('node', [SCRIPT, ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string }
      return { code: err.status, out: err.stdout + err.stderr }
    }
  }
  const snapFile = (f: string) => path.join(dir, SNAPSHOT_DIR, f)

  it('copies an in-step set, reports only what changed, and refuses a drifted one', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-snap-'))
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com'); g('config', 'user.name', 'test'); g('config', 'commit.gpgsign', 'false')
    fs.writeFileSync(path.join(dir, 'README.md'), EN)
    g('add', '.'); g('commit', '-qm', 'en')
    const sha = g('rev-parse', '--short=7', 'HEAD')
    fs.writeFileSync(path.join(dir, 'README.zh-CN.md'), withMarker(BODY, sha))
    fs.writeFileSync(path.join(dir, 'README.zh-TW.md'), withMarker(TW_SYNTH, sha, 'zh-TW'))
    g('add', '.'); g('commit', '-qm', 'zh')

    // No snapshot yet: all three files are written, byte for byte.
    expect(inDir(() => refreshSnapshot())).toEqual({ drifted: [], changed: ['README.md', 'README.zh-CN.md', 'README.zh-TW.md'].map((f) => path.join(SNAPSHOT_DIR, f)) })
    for (const f of ['README.md', 'README.zh-CN.md', 'README.zh-TW.md']) {
      expect(fs.readFileSync(snapFile(f), 'utf8')).toBe(fs.readFileSync(path.join(dir, f), 'utf8'))
    }
    expect(cli('--snapshot')).toMatchObject({ code: 0, out: expect.stringMatching(/already current/) })

    // A translation moved on (as --write leaves it): only that copy is rewritten.
    fs.appendFileSync(path.join(dir, 'README.zh-TW.md'), '\n新的一行。\n')
    const again = cli('--snapshot')
    expect(again.code).toBe(0)
    expect(again.out).toMatch(/snapshot refreshed: .*README\.zh-TW\.md/)
    expect(again.out).not.toMatch(/README\.zh-CN\.md/)
    expect(fs.readFileSync(snapFile('README.zh-TW.md'), 'utf8')).toMatch(/新的一行。/)

    // English ahead of the translations: an out-of-step set is never snapshotted.
    const before = fs.readFileSync(snapFile('README.md'), 'utf8')
    fs.writeFileSync(path.join(dir, 'README.md'), EN.replace('## Quick Start', '## Quick Start\n\nNew paragraph.'))
    g('commit', '-qam', 'en change')
    const refused = cli('--snapshot')
    expect(refused.code).toBe(3)
    expect(refused.out).toMatch(/snapshot not refreshed: zh-CN, zh-TW drifted/)
    expect(fs.readFileSync(snapFile('README.md'), 'utf8')).toBe(before)
  })
})

// The case that broke: a pull request adds a link to README.md. The
// translations get it only after the merge, when the sync runs on main.
describe('English ahead of the translations (a PR that adds a link)', () => {
  const LINK = 'https://new-home.example.org/'
  const EN_AHEAD = EN.replace('## Quick Start', `See [the new home](${LINK}).\n\n## Quick Start`)
  const BODY_AHEAD = BODY.replace('## 快速开始', `参见[新主页](${LINK})。\n\n## 快速开始`)
  const reply = (text: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 })
  const state = { zh: ZH, newEn: EN_AHEAD, oldEn: EN, diff: '', headSha: 'abc1234', sha: parseMarker(ZH), inSync: false }

  it('the fixture really is ahead: the link is new to both snapshot translations', () => {
    expect(EN_AHEAD).not.toBe(EN)
    expect(BODY_AHEAD).not.toBe(BODY)
    expect(ZH).not.toContain(LINK)
    expect(TW as string).not.toContain(LINK)
  })

  it('the validator still rejects a reply that drops the new link, and accepts one that carries it', async () => {
    expect(validate({ newEn: EN_AHEAD, zhBody: BODY, prevZhBody: BODY })).toContain(`link target dropped: ${LINK}`)
    expect(validate({ newEn: EN_AHEAD, zhBody: BODY_AHEAD, prevZhBody: BODY })).toEqual([])
    // Through the whole model loop: the old translation echoed back is refused,
    await expect(translate(state, { model: 'm/x', key: 'k', fetchImpl: reply(`<readme>\n${BODY}</readme>`), render: fakeRender, log: () => {} }))
      .rejects.toThrow(`link target dropped: ${LINK}`)
    // and a reply with the link is written.
    const out = await translate(state, { model: 'm/x', key: 'k', fetchImpl: reply(`<readme>\n${BODY_AHEAD}</readme>`), render: fakeRender, log: () => {} })
    expect(stripMarker(out)).toBe(BODY_AHEAD)
  })

  // The suite itself must not fail on such a PR. Run this very file in a copy
  // of the tree whose root README.md is ahead (nested runs skip this block).
  // CI forces colour on; the assertions read plain text.
  const plain = (t: string) => t.replace(/\u001b\[[0-9;]*m/g, '')
  const nested = (edit: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-pr-'))
    try {
      for (const f of ['README.md', 'README.zh-CN.md', 'README.zh-TW.md']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f))
      fs.mkdirSync(path.join(dir, 'scripts'))
      fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'sync-readme-zh.mjs'))
      fs.cpSync(path.join(ROOT, 'scripts', '__tests__', 'fixtures'), path.join(dir, 'scripts', '__tests__', 'fixtures'), { recursive: true })
      fs.copyFileSync(__filename, path.join(dir, 'scripts', '__tests__', path.basename(__filename)))
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
      edit(dir)
      try {
        const out = execFileSync('node', [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--root', dir, 'scripts/__tests__'], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, README_PAIR_NESTED: '1' },
        })
        return { code: 0, out: plain(out) }
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string }
        return { code: err.status, out: plain(err.stdout + err.stderr) }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  describe.skipIf(!!process.env.README_PAIR_NESTED)('the suite on such a tree', () => {
    it('passes when only README.md at the repo root is ahead', () => {
      const run = nested((dir) => fs.writeFileSync(path.join(dir, 'README.md'), EN_AHEAD))
      expect(run.out).not.toMatch(/link target dropped/)
      expect(run.out).toMatch(/Tests\s+\d+ passed/)
      expect(run.code, run.out).toBe(0)
    }, 120_000)
    // The same harness must be able to fail, or the test above proves nothing.
    it('fails when a translation at the repo root is hand-edited away from the snapshot', () => {
      const run = nested((dir) => fs.appendFileSync(path.join(dir, 'README.zh-CN.md'), '\n手动修改。\n'))
      expect(run.code).not.toBe(0)
      expect(run.out).toMatch(/README\.zh-CN\.md differs from/)
    }, 120_000)
  })
})
