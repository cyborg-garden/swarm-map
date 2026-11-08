#!/usr/bin/env node
/**
 * Keep README.zh-CN.md in step with README.md.
 *
 * README.zh-CN.md line 1 records the English commit it was translated from:
 *
 *   <!-- 译自 README.md @ 66ff4b8；如有出入，以英文版为准。 -->
 *
 * When README.md at HEAD differs from README.md at that commit, this script
 * sends the model the old English, the new English, the diff between them and
 * the current Chinese, asks for the Chinese with ONLY the changed parts
 * updated, validates the reply mechanically, writes it, and bumps the marker.
 * Incremental on purpose: a full retranslation every time churns wording that
 * did not change and loses hand-tuned terminology.
 *
 * Usage:
 *   node scripts/sync-readme-zh.mjs --check     exit 0 in sync, 3 drifted
 *   node scripts/sync-readme-zh.mjs --dry-run   print the prompt, call nothing
 *   node scripts/sync-readme-zh.mjs --write     translate, validate, write
 *
 * --write needs OPENROUTER_API_KEY and GITHUB_TOKEN (for GitHub's markdown
 * renderer, the ground truth for the link check; no token means no write). README_SYNC_MODEL overrides the model.
 * Run from the repo root (CI does). The pure functions are exported for tests.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EN = 'README.md'
export const ZH = 'README.zh-CN.md'
export const DEFAULT_MODEL = 'moonshotai/kimi-k3'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const API_SECTION = '## API Reference'

const MARKER_ZH = /^<!-- 译自 README\.md @ ([0-9a-f]{7,40})；如有出入，以英文版为准。 -->$/
const MARKER_EN = /^<!-- Translated from README\.md @ ([0-9a-f]{7,40})\. The English README is authoritative\. -->$/

export function markerLines(sha) {
  return [
    `<!-- 译自 README.md @ ${sha}；如有出入，以英文版为准。 -->`,
    `<!-- Translated from README.md @ ${sha}. The English README is authoritative. -->`,
  ]
}

/** The source SHA in the marker, or null when the marker is missing or malformed. */
export function parseMarker(zh) {
  const [l1 = '', l2 = ''] = zh.split('\n')
  const a = l1.match(MARKER_ZH)
  const b = l2.match(MARKER_EN)
  if (!a || !b || a[1] !== b[1]) return null
  return a[1]
}

/** The translation without its two marker lines (and the blank line after them). */
export function stripMarker(zh) {
  const lines = zh.split('\n')
  let i = 0
  while (i < lines.length && i < 2 && (MARKER_ZH.test(lines[i]) || MARKER_EN.test(lines[i]))) i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n')
}

export function withMarker(body, sha) {
  return `${markerLines(sha).join('\n')}\n\n${body.replace(/^\s+/, '').replace(/\s*$/, '\n')}`
}

// ---------------------------------------------------------------- prompt ----

export const SYSTEM_PROMPT = `You maintain the Simplified Chinese translation (README.zh-CN.md) of an open-source project's English README.md. The English README is authoritative.

You are given the OLD English the translation was made from, the NEW English, the diff between them, and the CURRENT Chinese translation. Produce the updated Chinese translation.

Rules:
1. Update ONLY what the English diff changed. Every Chinese passage whose English did not change must come back byte-for-byte identical. Do not polish, reword or reformat untouched text.
2. If the current Chinese already reflects a change, leave it as it is.
3. Keep every image tag, URL, link target, inline code span and fenced code block exactly as in the English. Inside code blocks only "#" comments are translated; commands stay identical.
4. The "API 参考" section deliberately does NOT translate the route tables: it keeps a short Chinese summary, a link to the English section (README.md#api-reference) and the curl examples. Keep that shape; do not add route tables. If the English changes only inside the route tables, the Chinese needs no change there.
5. Links to docs (docs/*.md, CONTRIBUTING.md, AGENTS.md) point at English documents; keep the "（英文）" notes where they are.
6. Terminology: agent = 智能体, runtime = 运行时, model cascade = 模型级联, multi-tenant = 多租户. Product names (Swarm Map, SM, Hermes, Letta) stay in English.
7. Punctuation: Chinese punctuation (，。：；（）) and curly quotes “” in Chinese prose; straight ASCII quotes inside HTML attributes, inline code and code blocks.
8. Keep the language switcher line "[English](README.md) | **简体中文**" under the title.
9. Do NOT output the two HTML comment marker lines at the top; they are added afterwards.

Output the complete updated Chinese README between <readme> and </readme>, and nothing else.`

export function buildPrompt({ oldEn, newEn, diff, zhBody }) {
  const old = oldEn == null
    ? '(unavailable: the source commit in the marker could not be found. Treat the CURRENT Chinese as the base and bring it in line with the NEW English, changing as little as possible.)'
    : oldEn
  const user = [
    '<old_english>', old, '</old_english>',
    '<new_english>', newEn, '</new_english>',
    '<english_diff>', diff || '(none available)', '</english_diff>',
    '<current_chinese>', zhBody, '</current_chinese>',
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/** The text between <readme> tags; tolerates a ```markdown fence around it. */
export function extractReadme(reply) {
  if (typeof reply !== 'string') return null
  const m = reply.match(/<readme>\s*\n?([\s\S]*?)\n?\s*<\/readme>/)
  if (!m) return null
  let body = m[1]
  const fenced = body.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/)
  if (fenced) body = fenced[1]
  return stripMarker(body)
}

// ------------------------------------------------------------ validation ----

/** Text outside the English API Reference section (its tables are not translated). */
function outsideApiSection(en) {
  const start = en.indexOf(`\n${API_SECTION}\n`)
  if (start < 0) return en
  const rest = en.slice(start + 1)
  const next = rest.slice(API_SECTION.length).search(/\n## /)
  return next < 0 ? en.slice(0, start) : en.slice(0, start) + rest.slice(API_SECTION.length + next)
}

export function fencedBlocks(md) {
  const blocks = []
  const re = /^```[^\n]*\n([\s\S]*?)^```\s*$/gm
  let m
  while ((m = re.exec(md))) blocks.push(m[1])
  return blocks
}

/** Code with comments removed, so "# Examples" and "# 示例" compare equal. */
export function codeSkeleton(block) {
  return block
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '').replace(/\s+$/, ''))
    .filter((l) => l !== '')
    .join('\n')
}

function imageSrcs(md) {
  return [...md.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g), ...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1])
}

function linkTargets(md) {
  const out = new Set()
  for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) out.add(m[1])
  for (const m of md.matchAll(/https?:\/\/[^\s)"'<>`]+/g)) out.add(m[0])
  return [...out].filter((t) => !t.startsWith('#') && t !== ZH)
}

// Characters that end a bare URL: whitespace, markup delimiters, and the
// full-width punctuation Chinese prose puts straight after a link.
const URL_CHARS = '[^\\s)\\]"\'<>`，。；：！？、（）“”]+'

/**
 * Every URL a reader could follow, in every form Markdown and HTML allow:
 * inline links and images, reference definitions, href/src attributes,
 * autolinks, bare http(s)://, protocol-relative //host and bare www.
 * Normalised to host+path(+query), fragment dropped, so the same target
 * written two ways compares equal and a new target in any form is caught.
 */
export function urlKeys(md) {
  const raw = []
  const add = (re, g = 1) => { for (const m of md.matchAll(re)) raw.push(m[g]) }
  add(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g)          // [t](url "title"), ![a](src)
  add(/^[ \t]{0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm)                   // [ref]: url
  add(/\b(?:href|src|srcset|action|poster|data)\s*=\s*["']?([^"'\s>]+)/gi) // <a href>, <img src>, ...
  add(/<((?:[a-z][a-z0-9+.-]*:|www\.)[^\s>]+)>/gi)                    // <https://x>, <www.x>
  add(new RegExp(`\\b[a-z][a-z0-9+.-]*://${URL_CHARS}`, 'gi'), 0)      // bare scheme://
  add(new RegExp(`(?<![\\w:/.-])//[a-z0-9-]+(?:\\.[a-z0-9-]+)+${URL_CHARS.slice(0, -1)}*`, 'gi'), 0) // //host
  add(new RegExp(`(?<![\\w./:-])www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+${URL_CHARS.slice(0, -1)}*`, 'gi'), 0) // www.host
  const keys = new Set()
  for (const u of raw) {
    const k = urlKey(u)
    if (k) keys.add(k)
  }
  return keys
}

/**
 * Backstop that does not depend on link syntax at all: every domain-like token
 * anywhere in the text (prose, code spans, code blocks), lowercased, with
 * leading/trailing "_" and "-" trimmed so _evil.com_ emphasis cannot hide one.
 * A token counts when its last label is letters (2+) or punycode (xn--).
 * Filenames like README.md or state.db match too; they are allowed because the
 * check is token-set membership against the source texts, not a TLD list.
 */
export function domainTokens(text) {
  const out = new Set()
  for (const m of text.matchAll(/[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/gi)) {
    const t = m[0].toLowerCase().replace(/^[_-]+|[_-]+$/g, '')
    const last = t.split('.').pop()
    if (t.includes('.') && (/^[a-z]{2,}$/.test(last) || last.startsWith('xn--'))) out.add(t)
  }
  return out
}

function urlKey(u) {
  let s = u.trim().replace(/[.,;:!?'"]+$/, '')
  if (!s || s.startsWith('#')) return null
  s = s.replace(/#.*$/, '')
  const abs = s.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)(.*)$/i) || (/^www\./i.test(s) ? [null, s.split(/[/?]/)[0], s.slice(s.split(/[/?]/)[0].length)] : null)
  if (abs) {
    const host = abs[1].toLowerCase().replace(/^www\./, '').replace(/:(80|443)$/, '')
    return `${host}${abs[2].replace(/\/$/, '') || ''}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s.toLowerCase()               // mailto:, data:, javascript:
  return s.replace(/^\.\//, '') || null
}

const h2 = (md) => md.split('\n').filter((l) => /^## /.test(l)).length
const cjk = (s) => (s.match(/[一-鿿]/g) || []).length

/**
 * Mechanical checks on a candidate translation body (no marker). Returns a list
 * of problems; empty means it may be written. These catch the failures a model
 * actually produces: truncation, dropped images or code, rewritten commands,
 * English left untranslated, or the API tables re-added.
 */
export function validate({ newEn, zhBody, prevZhBody = null, diff = null }) {
  const problems = []
  if (!zhBody || !zhBody.trim()) return ['empty translation']

  if (!/^# Swarm Map\s*$/m.test(zhBody.split('\n')[0] || '')) problems.push('first line is not the "# Swarm Map" title')
  if (!zhBody.includes('[English](README.md)')) problems.push('language switcher "[English](README.md)" is missing')
  if (/<!--\s*(译自|Translated from)/.test(zhBody)) problems.push('output contains a marker comment')
  if (/<\/?readme>/.test(zhBody)) problems.push('output contains a <readme> tag')

  const ratio = cjk(zhBody) / Math.max(1, zhBody.replace(/\s/g, '').length)
  if (ratio < 0.15) problems.push(`too little Chinese text (${(ratio * 100).toFixed(1)}% CJK)`)

  if (prevZhBody && zhBody.length < prevZhBody.length * 0.7) {
    problems.push(`translation shrank to ${zhBody.length} chars from ${prevZhBody.length} (truncated?)`)
  }

  for (const src of imageSrcs(newEn)) {
    if (!zhBody.includes(src)) problems.push(`image dropped: ${src}`)
  }
  for (const t of linkTargets(outsideApiSection(newEn))) {
    if (!zhBody.includes(t)) problems.push(`link target dropped: ${t}`)
  }
  // The other direction: the model must not invent a link or image. Every URL
  // in the output has to come from the English or the current translation, so
  // a hallucinated or injected URL never reaches the published README.
  const known = new Set([...urlKeys(newEn), ...urlKeys(prevZhBody || '')])
  for (const k of urlKeys(zhBody)) {
    if (!known.has(k)) problems.push(`link or image not in the English or current translation: ${k}`)
  }
  // Superset backstop: any host or file-like token the sources never contained.
  const knownTokens = new Set([...domainTokens(newEn), ...domainTokens(prevZhBody || '')])
  for (const t of domainTokens(zhBody)) {
    if (!knownTokens.has(t)) problems.push(`domain-like token not in the English or current translation: ${t}`)
  }

  const enCode = fencedBlocks(newEn).map(codeSkeleton)
  const zhCode = fencedBlocks(zhBody).map(codeSkeleton)
  if (enCode.length !== zhCode.length) {
    problems.push(`code block count ${zhCode.length}, English has ${enCode.length}`)
  } else {
    enCode.forEach((c, i) => {
      if (c !== zhCode[i]) problems.push(`code block ${i + 1} differs from the English (only # comments may change)`)
    })
  }

  // Incremental means untouched passages come back verbatim. Allow the share of
  // changed Chinese lines to track the share of changed English lines, plus slack
  // for a changed sentence spilling over its neighbours.
  if (prevZhBody && diff) {
    const prev = prevZhBody.split('\n').filter((l) => l.trim())
    const kept = new Set(zhBody.split('\n'))
    const retained = prev.filter((l) => kept.has(l)).length / Math.max(1, prev.length)
    const enLines = Math.max(1, newEn.split('\n').length)
    const changed = diff.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l)).length
    const floor = Math.max(0, 1 - changed / enLines - 0.2)
    if (retained < floor) {
      problems.push(`only ${(retained * 100).toFixed(0)}% of unchanged Chinese lines kept (need ${(floor * 100).toFixed(0)}%): rewrote text the English did not change`)
    }
  }

  if (h2(zhBody) !== h2(newEn)) problems.push(`section count ${h2(zhBody)}, English has ${h2(newEn)}`)
  if (/\|\s*`(GET|POST|PUT|DELETE)`\s*\|/.test(zhBody)) problems.push('API route table present (the convention links to the English one instead)')

  return problems
}

// ------------------------------------------------------------------- git ----

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 << 20, ...opts })
}

function tryGit(args) {
  try { return git(args, { stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

/** Everything the decision needs, read from the repo at cwd. */
export function readState() {
  const zh = fs.readFileSync(ZH, 'utf8')
  const newEn = fs.readFileSync(EN, 'utf8')
  const sha = parseMarker(zh)
  const resolved = sha && tryGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])?.trim()
  const oldEn = resolved ? tryGit(['show', `${resolved}:${EN}`]) : null
  const diff = oldEn != null ? tryGit(['diff', '--no-color', resolved, '--', EN]) || '' : null
  // The marker names the last commit that changed README.md, so it only moves
  // when the English does.
  const headSha = (tryGit(['log', '-1', '--format=%h', '--abbrev=7', '--', EN]) || '').trim()
  return { zh, newEn, sha, oldEn, diff, headSha, inSync: oldEn != null && oldEn === newEn }
}

// --------------------------------------------------- rendered link check ----
//
// Ground truth for links: what GitHub actually renders. Regex extraction keeps
// losing to Markdown edge cases (reference definitions inside blockquotes, an
// escaped label, a URL on the next line, a host spelt evil%2Ecom or evil。com).
// So the candidate, the current translation and the English all go through
// GitHub's own renderer (POST /markdown, gfm, this repo as context), every URL
// attribute is read from the HTML, and each URL is normalised the way a
// browser would resolve it. The regex checks above stay as an offline first pass.

export const REPO_BASE = 'https://github.com/cyborg-garden/swarm-map/blob/main/'
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'cite', 'background', 'xlink:href'])

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_, e) => {
    const l = e.toLowerCase()
    if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[l]
  })
}

/** Raw URL attribute values from rendered HTML (srcset split into its URLs). */
export function htmlUrls(html) {
  const out = []
  for (const tag of html.matchAll(/<[a-z][^\s/>]*(\s[^>]*)?>/gi)) {
    for (const a of (tag[1] || '').matchAll(/([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const name = a[1].toLowerCase()
      if (!URL_ATTRS.has(name)) continue
      const v = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '').trim()
      if (name === 'srcset') out.push(...v.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean))
      else out.push(v)
    }
  }
  return out
}

/**
 * A URL as a browser resolves it: relative against the repo, host through the
 * WHATWG parser (percent-decoded, IDNA/punycode, 。 mapped to ., lowercased),
 * path percent-decoded, fragment dropped. Pure in-page anchors return null.
 * GitHub signs uploaded images with a per-render jwt; that is dropped so the
 * same image compares equal across renders.
 */
export function normalizeUrl(raw, base = REPO_BASE) {
  const v = raw.trim()
  if (!v || v.startsWith('#')) return null
  let u
  try { u = new URL(v, base) } catch { return `unparseable:${v}` }
  if (u.hostname === 'private-user-images.githubusercontent.com') u.searchParams.delete('jwt')
  let path = u.pathname
  try { path = decodeURIComponent(path) } catch { /* keep the encoded form */ }
  // mailto:, tel:, data:, javascript:. The query stays: mailto:known@x?bcc=other
  // is a different message from mailto:known@x.
  let search = u.search
  try { search = decodeURIComponent(search) } catch { /* keep the encoded form */ }
  if (!u.host) return `${u.protocol}${path.toLowerCase()}${search}`
  return `${u.protocol}//${u.host}${path}${u.search}`
}

export function renderedUrlKeys(html) {
  const keys = new Set()
  for (const raw of htmlUrls(html)) {
    const k = normalizeUrl(raw)
    if (k) keys.add(k)
  }
  return keys
}

/** GitHub's renderer. Throws on any failure: no render, no write. */
export function githubRenderer({ token, fetchImpl = fetch, repo = 'cyborg-garden/swarm-map' }) {
  if (!token) throw new Error('GITHUB_TOKEN is not set; the rendered link check cannot run')
  return async (text) => {
    const res = await fetchImpl('https://api.github.com/markdown', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'cyborg-garden-readme-sync/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ text, mode: 'gfm', context: repo }),
      signal: AbortSignal.timeout(60_000),
    })
    const html = await res.text()
    if (!res.ok) throw new Error(`GitHub markdown render failed: HTTP ${res.status} ${html.slice(0, 200)}`)
    if (!html.trim()) throw new Error('GitHub markdown render returned an empty body')
    return html
  }
}

/** Problems for URLs the rendered candidate links to that neither source does. */
export function renderedLinkProblems({ enHtml, prevZhHtml, candidateHtml }) {
  const known = new Set([...renderedUrlKeys(enHtml), ...renderedUrlKeys(prevZhHtml)])
  return [...renderedUrlKeys(candidateHtml)]
    .filter((k) => !known.has(k))
    .map((k) => `rendered link not in the English or current translation: ${k}`)
}

// ----------------------------------------------------------------- model ----

async function callModel({ system, user }, { model, key, fetchImpl = fetch }) {
  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cyborg-garden-readme-sync/1.0',
    },
    body: JSON.stringify({
      model,
      max_tokens: 32000,
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(600_000),
  })
  const data = await res.json().catch(() => ({}))
  const choice = (data.choices || [])[0] || {}
  const err = data.error || choice.error
  if (!res.ok || err) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(err || data).slice(0, 500)}`)
  let content = choice.message?.content
  if (Array.isArray(content)) content = content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('')
  return { text: typeof content === 'string' ? content : '', finish: choice.finish_reason }
}

/** Ask, validate, and on failure ask once more with the problems listed. */
/**
 * @param {any} state
 * @param {{ model: string, key: string, fetchImpl?: any, render?: ((text: string) => Promise<string>) | null, attempts?: number, log?: (msg: string) => void }} opts
 */
export async function translate(state, { model, key, fetchImpl, render = null, attempts = 2, log = console.error }) {
  // Fail closed: without GitHub's renderer there is no ground-truth link check.
  if (typeof render !== 'function') throw new Error('no markdown renderer; refusing to translate without the rendered link check')
  const zhBody = stripMarker(state.zh)
  let sourceHtml = null
  const prompt = buildPrompt({ oldEn: state.oldEn, newEn: state.newEn, diff: state.diff, zhBody })
  let user = prompt.user
  let problems = []
  for (let i = 1; i <= attempts; i++) {
    const { text, finish } = await callModel({ system: prompt.system, user }, { model, key, fetchImpl })
    const body = extractReadme(text)
    problems = body == null ? [`no <readme> block in the reply (finish_reason ${finish})`] : validate({ newEn: state.newEn, zhBody: body, prevZhBody: zhBody, diff: state.diff })
    if (!problems.length) {
      sourceHtml ??= { en: await render(state.newEn), zh: await render(zhBody) }
      problems = renderedLinkProblems({ enHtml: sourceHtml.en, prevZhHtml: sourceHtml.zh, candidateHtml: await render(body) })
    }
    if (!problems.length) return withMarker(body, state.headSha)
    log(`attempt ${i}: rejected:\n  - ${problems.join('\n  - ')}`)
    user = `${prompt.user}\n\nYour previous answer was rejected for these reasons. Fix them:\n- ${problems.join('\n- ')}`
  }
  throw new Error(`translation rejected after ${attempts} attempts:\n  - ${problems.join('\n  - ')}`)
}

// ------------------------------------------------------------------ main ----

async function main(argv) {
  const mode = argv[0] || '--check'
  const state = readState()
  if (!state.sha) console.error(`${ZH}: marker on lines 1-2 missing or malformed; will retranslate against the current Chinese.`)
  else if (state.oldEn == null) console.error(`${ZH}: marker commit ${state.sha} not found; will retranslate against the current Chinese.`)

  if (state.inSync) {
    console.log(`in sync: ${EN} unchanged since ${state.sha}`)
    return 0
  }
  if (mode === '--check') {
    console.log(`drift: ${EN} changed since ${state.sha || '(no marker)'}; head ${state.headSha}`)
    return 3
  }
  if (mode === '--dry-run') {
    const p = buildPrompt({ oldEn: state.oldEn, newEn: state.newEn, diff: state.diff, zhBody: stripMarker(state.zh) })
    console.log(`=== SYSTEM ===\n${p.system}\n\n=== USER ===\n${p.user}`)
    return 0
  }
  if (mode !== '--write') {
    console.error(`unknown mode ${mode}`)
    return 2
  }
  const key = (process.env.OPENROUTER_API_KEY || '').trim()
  if (!key) {
    console.error('OPENROUTER_API_KEY is not set')
    return 2
  }
  if (!state.headSha) {
    console.error(`cannot find the last commit that touched ${EN}`)
    return 2
  }
  const model = (process.env.README_SYNC_MODEL || '').trim() || DEFAULT_MODEL
  const render = githubRenderer({ token: (process.env.GITHUB_TOKEN || '').trim() })
  const out = await translate(state, { model, key, render })
  fs.writeFileSync(ZH, out)
  console.log(`wrote ${ZH} (source ${state.headSha}, model ${model})`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(err.message || err); process.exit(1) },
  )
}
