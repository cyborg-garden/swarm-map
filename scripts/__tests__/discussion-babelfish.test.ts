// @vitest-environment node
/**
 * scripts/discussion-babelfish.mjs translates GitHub Discussions posts between
 * Chinese and English. Everything is tested here with fetch mocked: language
 * and script detection, the decision, the mechanical validation that must
 * refuse a hostile or broken model reply, mention defusing, and the end-to-end
 * event handling (what is posted where, and when nothing is posted).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  detectLang, detectScript, cjkRatio, decide, isBot, extractTranslation,
  validateTranslation, defuseMentions, formatReply, buildPrompt, postFromEvent,
  translate, run, MAX_INPUT, fences, inlineCode, refs, withTitle,
} from '../discussion-babelfish.mjs'

const ZWSP = '​'
const ZH_CN = '我用 docker compose 启动之后，hermes 容器一直重启，这是为什么？请帮我看看日志。'
const ZH_TW = '我用 docker compose 啟動之後，hermes 容器一直重啟，這是為什麼？請幫我看看日誌。'
const EN = 'I started it with docker compose and the hermes container keeps restarting. Why is that? Please help me read the logs.'
const EN_REPLY = 'Check the gateway log first, it usually says which key is missing.'

describe('language detection', () => {
  it('scores mixed technical Chinese as Chinese', () => {
    expect(detectLang(ZH_CN)).toBe('zh')
    expect(detectLang(ZH_TW)).toBe('zh')
  })
  it('scores English as English, even with a stray Chinese word', () => {
    expect(detectLang(EN)).toBe('en')
    expect(detectLang('This is a long English sentence about deploying the swarm, 部署.')).toBe('en')
  })
  it('ignores code, URLs and mentions when scoring', () => {
    const md = '这个配置有问题吗？\n\n```yaml\nmodel:\n  default: some/very-long-model-name-with-many-letters\n  fallback_providers: [a, b, c, d, e, f]\n```\n\nhttps://example.org/a/really/long/english/path @someone'
    expect(detectLang(md)).toBe('zh')
  })
  it('calls code-only and empty bodies empty', () => {
    expect(detectLang('```\nnpm run dev\n```')).toBe('empty')
    expect(detectLang('`foo`  https://example.org')).toBe('empty')
    expect(detectLang('')).toBe('empty')
  })
  it('leaves Japanese and Korean alone', () => {
    expect(detectLang('このコンテナは再起動を繰り返しています。ログを見てください。')).toBe('other')
    expect(detectLang('컨테이너가 계속 다시 시작됩니다')).toBe('empty')
  })
  it('cjkRatio is null without prose', () => {
    expect(cjkRatio('```\nx\n```')).toBeNull()
  })
})

describe('script detection', () => {
  it('tells Traditional from Simplified', () => {
    expect(detectScript(ZH_CN)).toBe('zh-CN')
    expect(detectScript(ZH_TW)).toBe('zh-TW')
  })
  it('defaults to Simplified when there is no signal', () => {
    expect(detectScript('日志')).toBe('zh-CN')
  })
})

describe('decide', () => {
  it('translates a Chinese post to English, opener or comment', () => {
    expect(decide({ body: ZH_CN, author: 'alice' })).toEqual({ action: 'translate', target: 'en' })
    expect(decide({ body: ZH_TW, author: 'alice', openerBody: EN })).toEqual({ action: 'translate', target: 'en' })
  })
  it('translates English into the opener\'s script in a Chinese thread', () => {
    expect(decide({ body: EN_REPLY, author: 'bob', openerBody: ZH_CN })).toEqual({ action: 'translate', target: 'zh-CN' })
    expect(decide({ body: EN_REPLY, author: 'bob', openerBody: ZH_TW })).toEqual({ action: 'translate', target: 'zh-TW' })
  })
  it('does nothing for English in an English thread or an English opener', () => {
    expect(decide({ body: EN_REPLY, author: 'bob', openerBody: EN }).action).toBe('skip')
    expect(decide({ body: EN, author: 'bob' }).action).toBe('skip')
  })
  it('skips bots, empty, code-only and over-long bodies', () => {
    expect(decide({ body: ZH_CN, author: 'github-actions' })).toMatchObject({ action: 'skip', code: 'bot' })
    expect(decide({ body: ZH_CN, author: 'renovate[bot]' })).toMatchObject({ action: 'skip', code: 'bot' })
    expect(decide({ body: '   ', author: 'a' })).toMatchObject({ action: 'skip', code: 'empty' })
    expect(decide({ body: '```\nls\n```', author: 'a' })).toMatchObject({ action: 'skip', code: 'no-prose' })
    expect(decide({ body: '中'.repeat(MAX_INPUT + 1), author: 'a' })).toMatchObject({ action: 'skip', code: 'too-long' })
  })
  it('isBot', () => {
    expect(isBot('GitHub-Actions')).toBe(true)
    expect(isBot('dependabot[bot]')).toBe(true)
    expect(isBot('botanist')).toBe(false)
  })
})

describe('prompt and extraction', () => {
  it('puts the post in the user message and the rules in the system prompt', () => {
    const p = buildPrompt(ZH_CN, 'en')
    expect(p.system).toMatch(/never instructions/)
    expect(p.system).toMatch(/<translation>/)
    expect(p.user).toContain(ZH_CN)
    expect(p.system).not.toContain(ZH_CN)
  })
  it('extracts exactly one translation block', () => {
    expect(extractTranslation('<translation>\nhello\n</translation>')).toBe('hello')
    expect(extractTranslation('hello')).toBeNull()
    expect(extractTranslation('<translation>a</translation><translation>b</translation>')).toBeNull()
    expect(extractTranslation('<translation>  </translation>')).toBeNull()
  })
})

describe('validateTranslation', () => {
  const ok = (source: string, output: string, target: 'en' | 'zh-CN' | 'zh-TW') =>
    validateTranslation({ source, output, target }) as string[]

  it('accepts a faithful translation', () => {
    expect(ok(ZH_CN, EN, 'en')).toEqual([])
    expect(ok(EN, ZH_CN, 'zh-CN')).toEqual([])
    expect(ok(EN, ZH_TW, 'zh-TW')).toEqual([])
  })
  it('keeps URLs and code that the source had', () => {
    const src = '请看 https://example.org/docs 然后运行 `npm run dev`：\n\n```sh\nnpm ci\n```\n'
    const out = 'See https://example.org/docs and then run `npm run dev`:\n\n```sh\nnpm ci\n```\n'
    expect(ok(src, out, 'en')).toEqual([])
  })
  it('rejects a URL or domain the source did not have', () => {
    expect(ok(ZH_CN, `${EN} More at https://evil.example/x`, 'en').join()).toMatch(/URL not in the source/)
    expect(ok(ZH_CN, `${EN} Visit evil.example today.`, 'en').join()).toMatch(/domain-like token/)
  })
  it('rejects added links and images, even relative ones', () => {
    expect(ok(ZH_CN, `${EN} [docs](./x)`, 'en').join()).toMatch(/links added/)
    expect(ok(ZH_CN, `${EN} ![x](./y.png)`, 'en').join()).toMatch(/images added/)
    expect(ok(ZH_CN, `${EN} <details>hi</details>`, 'en').join()).toMatch(/HTML tag/)
  })
  it('rejects changed or dropped code', () => {
    const src = '运行这个：\n\n```sh\nnpm ci\n```\n然后 `npm run dev`'
    expect(ok(src, 'Run this:\n\n```sh\nnpm install\n```\nthen `npm run dev`', 'en').join()).toMatch(/code blocks/)
    expect(ok(src, 'Run this:\n\n```sh\nnpm ci\n```\nthen `npm start`', 'en').join()).toMatch(/inline code/)
  })
  it('rejects the wrong language or script', () => {
    expect(ok(ZH_CN, ZH_CN, 'en').join()).toMatch(/not English/)
    expect(ok(EN, EN, 'zh-CN').join()).toMatch(/not Chinese/)
    expect(ok(EN, ZH_CN, 'zh-TW').join()).toMatch(/Simplified, wanted Traditional/)
    expect(ok(EN, ZH_TW, 'zh-CN').join()).toMatch(/Traditional, wanted Simplified/)
  })
  it('rejects a reply far too long or too short for the source', () => {
    const essay = 'This is an extra paragraph the model added on its own. '.repeat(20)
    expect(ok(ZH_CN, `${EN} ${essay}`, 'en').join()).toMatch(/too long/)
    const long = EN.repeat(6)
    expect(ok(long, '好的。', 'zh-CN').join()).toMatch(/too short/)
  })
  it('regression: rejects issue references the source did not have', () => {
    expect(refs('see #12, other/repo#3 and GH-5')).toEqual(new Set(['#12', 'other/repo#3', 'gh-5']))
    expect(ok(ZH_CN, `${EN} See #123.`, 'en').join()).toMatch(/reference not in the source: #123/)
    expect(ok(ZH_CN, `${EN} See evil/repo#9.`, 'en').join()).toMatch(/reference not in the source/)
    expect(ok(ZH_CN, `${EN} See GH-5.`, 'en').join()).toMatch(/reference not in the source: gh-5/)
    expect(ok(`${ZH_CN} 见 #12`, `${EN} See #12.`, 'en')).toEqual([])
  })
  it('regression: the zh->en length bound is tighter but still fits real translations', () => {
    // Real ratio here is ~2x; ~6.7x (between the new 5x and the old 8x bound) is an added essay.
    expect(ok(ZH_CN, EN, 'en')).toEqual([])
    const pad = ' And here is some extra text the model added.'.repeat(6)
    expect(ok(ZH_CN, EN + pad, 'en').join()).toMatch(/too long/)
  })
  it('requires a bold title line when the source has one', () => {
    expect(ok(`**部署失败**\n\n${ZH_CN}`, `**Deploy failed**\n\n${EN}`, 'en')).toEqual([])
    expect(ok(`**部署失败**\n\n${ZH_CN}`, `Deploy failed\n\n${EN}`, 'en').join()).toMatch(/bold title/)
  })
  it('rejects leaked prompt markers', () => {
    expect(ok(ZH_CN, `<post>${EN}</post>`, 'en').join()).toMatch(/prompt markers/)
  })
  it('fences and inlineCode read exact text', () => {
    expect(fences('a\n~~~\nx\n~~~\nb')).toEqual(['~~~\nx\n~~~'])
    expect(inlineCode('a `x` b ``y`z`` c')).toEqual(['`x`', '``y`z``'])
  })
})

describe('mentions', () => {
  const live = /@(?!\u200B)[A-Za-z0-9_-]/
  it('defuses every mention, inside code and URLs too', () => {
    const out = defuseMentions('hi @alice and @org/team\n\n```\n@decorator\n```\n`@x` https://medium.example/@writer')
    expect(out).toContain(`@${ZWSP}alice`)
    expect(out).toContain(`@${ZWSP}org/team`)
    expect(out).toContain(`\`\`\`\n@${ZWSP}decorator\n\`\`\``)
    expect(out).toContain(`\`@${ZWSP}x\``)
    expect(out).toContain(`https://medium.example/@${ZWSP}writer`)
    expect(out).not.toMatch(live)
  })
  it('regression: an inline-code span across a blank line cannot hide a mention', () => {
    // GitHub ends inline code at a blank line, so @octocat here is live prose.
    const out = defuseMentions('请帮我 `开始\n\n@octocat 你好\n\n结束` 谢谢')
    expect(out).toContain(`@${ZWSP}octocat`)
    expect(out).not.toMatch(live)
  })
  it('regression: emphasis inside a URL cannot hide a mention', () => {
    expect(defuseMentions('https://x.com/*@octocat*')).not.toMatch(live)
  })
  it('regression: a fence line inside an HTML block cannot hide a mention', () => {
    expect(defuseMentions('<div>\n```\n</div>\n@octocat\n```')).not.toMatch(live)
  })
  it('formats the bilingual header with a defused author', () => {
    const r = formatReply({ login: 'alice', translation: 'Hello @bob' })
    expect(r.split('\n')[0]).toBe(`> 🤖 机器翻译 · Machine translation of @${ZWSP}alice's post`)
    expect(r).toContain(`Hello @${ZWSP}bob`)
    expect(r).not.toMatch(/@(?!​)[\w-]/)
  })
  it('strips odd characters from the login', () => {
    expect(formatReply({ login: 'a**b\n@c', translation: 'x' }).split('\n')[0]).toContain(`@${ZWSP}abc's`)
  })
})

// ----------------------------------------------------------- end to end ----

type Call = { url: string, body: any }

function reply(text: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) }
}
function gql(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) }
}

/** A fetch that answers OpenRouter with `models` in order and GitHub by query. */
function mockFetch({ models = [] as string[], opener = ZH_CN, replyTo = null as string | null } = {}) {
  const calls: Call[] = []
  const queue = [...models]
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    if (url.includes('openrouter.ai')) return reply(queue.shift() ?? '')
    if (body.query.includes('addDiscussionComment')) return gql({ addDiscussionComment: { comment: { id: 'C_new', url: 'https://github.com/x' } } })
    return gql({ discussion: { body: opener }, comment: { replyTo: replyTo ? { id: replyTo } : null } })
  })
  return { fn, calls }
}

const ENV = { GITHUB_TOKEN: 'test-token', OPENROUTER_API_KEY: 'test-key' }
const discussionEvent = (body: string, login = 'alice') => ({ discussion: { number: 7, node_id: 'D_1', body, user: { login } } })
const commentEvent = (body: string, login = 'bob') => ({
  discussion: { number: 7, node_id: 'D_1', body: 'stale', user: { login: 'alice' } },
  comment: { node_id: 'DC_2', body, user: { login } },
})
const posts = (calls: Call[]) => calls.filter((c) => c.url.includes('api.github.com') && c.body.query.includes('addDiscussionComment'))
const silent = () => {}

describe('run', () => {
  it('posts an English translation of a Chinese opener as a top-level comment', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN}</translation>`] })
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: ENV, fetchImpl: fn, log: silent })).toBe(0)
    const p = posts(calls)
    expect(p).toHaveLength(1)
    expect(p[0].body.variables).toMatchObject({ discussionId: 'D_1', replyToId: null })
    expect(p[0].body.variables.body).toContain(`@${ZWSP}alice's post`)
    expect(p[0].body.variables.body).toContain(EN)
    const model = calls.find((c) => c.url.includes('openrouter.ai'))!
    expect(model.body.model).toBe('moonshotai/kimi-k3')
  })

  it('answers an English comment in a Traditional thread in Traditional, threaded under it', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${ZH_TW}</translation>`], opener: ZH_TW })
    expect(await run({ eventName: 'discussion_comment', payload: commentEvent(EN), env: ENV, fetchImpl: fn, log: silent })).toBe(0)
    const p = posts(calls)
    expect(p).toHaveLength(1)
    expect(p[0].body.variables.replyToId).toBe('DC_2')
    expect(calls.find((c) => c.url.includes('openrouter.ai'))!.body.messages[0].content).toMatch(/Traditional/)
  })

  it('sends a reply-to-a-reply to the parent top-level comment', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN}</translation>`], replyTo: 'DC_top' })
    await run({ eventName: 'discussion_comment', payload: commentEvent(ZH_CN), env: ENV, fetchImpl: fn, log: silent })
    expect(posts(calls)[0].body.variables.replyToId).toBe('DC_top')
  })

  it('regression: translates an opener\'s title as a bold first line, and detects language from it', async () => {
    expect(withTitle('部署 *失败*', 'body')).toBe('**部署 \\*失败\\***\n\nbody')
    expect(withTitle('', 'body')).toBe('body')
    expect(withTitle('部署失败', '')).toBe('**部署失败**')
    // Chinese title, code-only body: translated because of the title.
    const { fn, calls } = mockFetch({ models: ['<translation>**Deploy failed**\n\n```\nnpm ci\n```</translation>'] })
    const payload = { discussion: { number: 7, node_id: 'D_1', title: '部署失败了，怎么办', body: '```\nnpm ci\n```', user: { login: 'alice' } } }
    expect(await run({ eventName: 'discussion', payload, env: ENV, fetchImpl: fn, log: silent })).toBe(0)
    expect(calls.find((c) => c.url.includes('openrouter.ai'))!.body.messages[1].content).toContain('**部署失败了，怎么办**')
    expect(posts(calls)[0].body.variables.body).toContain('**Deploy failed**')
  })

  it('regression: asks for at most 6000 output tokens', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN}</translation>`] })
    await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: ENV, fetchImpl: fn, log: silent })
    expect(calls.find((c) => c.url.includes('openrouter.ai'))!.body.max_tokens).toBeLessThanOrEqual(6000)
  })

  it('honours BABELFISH_MODEL', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN}</translation>`] })
    await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: { ...ENV, BABELFISH_MODEL: 'other/model' }, fetchImpl: fn, log: silent })
    expect(calls.find((c) => c.url.includes('openrouter.ai'))!.body.model).toBe('other/model')
  })

  it('does nothing for an English comment in an English thread (no model call)', async () => {
    const { fn, calls } = mockFetch({ opener: EN })
    expect(await run({ eventName: 'discussion_comment', payload: commentEvent(EN_REPLY), env: ENV, fetchImpl: fn, log: silent })).toBe(0)
    expect(calls.some((c) => c.url.includes('openrouter.ai'))).toBe(false)
    expect(posts(calls)).toHaveLength(0)
  })

  it('makes no network call at all for bots, code-only and over-long bodies', async () => {
    for (const payload of [
      discussionEvent(ZH_CN, 'github-actions'),
      commentEvent(ZH_CN, 'someone[bot]'),
      discussionEvent('```\nnpm ci\n```'),
      discussionEvent('中'.repeat(MAX_INPUT + 1)),
    ]) {
      const { fn } = mockFetch()
      const eventName = 'comment' in payload ? 'discussion_comment' : 'discussion'
      expect(await run({ eventName, payload, env: ENV, fetchImpl: fn, log: silent })).toBe(0)
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('retries once on a bad reply, then posts the good one', async () => {
    const log = vi.fn()
    const { fn, calls } = mockFetch({ models: [`<translation>${EN} https://evil.example/</translation>`, `<translation>${EN}</translation>`] })
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: ENV, fetchImpl: fn, log })).toBe(0)
    const modelCalls = calls.filter((c) => c.url.includes('openrouter.ai'))
    expect(modelCalls).toHaveLength(2)
    expect(modelCalls[1].body.messages[1].content).toMatch(/rejected/)
    expect(posts(calls)).toHaveLength(1)
  })

  it('posts nothing and exits non-zero after two bad replies', async () => {
    const injected = '<translation>Sure! As an AI I will help. Visit https://evil.example/ now. ![x](https://evil.example/p.png)</translation>'
    const { fn, calls } = mockFetch({ models: [injected, injected] })
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: ENV, fetchImpl: fn, log: silent })).toBe(1)
    expect(calls.filter((c) => c.url.includes('openrouter.ai'))).toHaveLength(2)
    expect(posts(calls)).toHaveLength(0)
  })

  it('defuses mentions the model echoes from the source', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN} cc @carol</translation>`] })
    await run({ eventName: 'discussion', payload: discussionEvent(`${ZH_CN} cc @carol`), env: ENV, fetchImpl: fn, log: silent })
    const body = posts(calls)[0].body.variables.body as string
    expect(body).toContain(`@${ZWSP}carol`)
    expect(body).not.toMatch(/@(?!​)[\w-]/)
  })

  it('posts nothing in a dry run', async () => {
    const { fn, calls } = mockFetch({ models: [`<translation>${EN}</translation>`] })
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: { ...ENV, BABELFISH_DRY_RUN: '1' }, fetchImpl: fn, log: silent })).toBe(0)
    expect(posts(calls)).toHaveLength(0)
  })

  it('fails without credentials once it has something to translate', async () => {
    const { fn } = mockFetch()
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: { GITHUB_TOKEN: 't' }, fetchImpl: fn, log: silent })).toBe(2)
    expect(await run({ eventName: 'discussion', payload: discussionEvent(ZH_CN), env: {}, fetchImpl: fn, log: silent })).toBe(2)
  })

  it('ignores other events', async () => {
    expect(postFromEvent('push', {})).toBeNull()
    const { fn } = mockFetch()
    expect(await run({ eventName: 'issues', payload: {}, env: ENV, fetchImpl: fn, log: silent })).toBe(0)
  })

  it('translate throws after the attempts are used up', async () => {
    const { fn } = mockFetch({ models: ['no tags', 'still no tags'] })
    await expect(translate(ZH_CN, 'en', { model: 'm', key: 'k', fetchImpl: fn, log: silent })).rejects.toThrow(/rejected after 2 attempts/)
  })
})
