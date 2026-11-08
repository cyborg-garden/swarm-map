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
 * --write needs OPENROUTER_API_KEY. README_SYNC_MODEL overrides the model.
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
export async function translate(state, { model, key, fetchImpl, attempts = 2, log = console.error }) {
  const zhBody = stripMarker(state.zh)
  const prompt = buildPrompt({ oldEn: state.oldEn, newEn: state.newEn, diff: state.diff, zhBody })
  let user = prompt.user
  let problems = []
  for (let i = 1; i <= attempts; i++) {
    const { text, finish } = await callModel({ system: prompt.system, user }, { model, key, fetchImpl })
    const body = extractReadme(text)
    problems = body == null ? [`no <readme> block in the reply (finish_reason ${finish})`] : validate({ newEn: state.newEn, zhBody: body, prevZhBody: zhBody, diff: state.diff })
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
  const out = await translate(state, { model, key })
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
