// @vitest-environment node
//
// ONE turn against the real Anthropic API, through the door, with the real
// Claude Agent SDK behind it. Not part of any default run: it spends money
// and needs a key. Nobody has run it yet. Run it with:
//
//   SWARMLAB_CLAUDE_SDK_DIR=/tmp/claude-agent-sdk-0.3.325 \
//   SWARMLAB_ANTHROPIC_KEY_FILE=/path/to/key-file \
//   npm run conformance -- anthropic-live
//
// The key file holds the key on one line and is readable by its owner only
// (mode 600). The key is read by the model route in this process and goes
// nowhere else: the SDK is given a placeholder, and its traffic is sent
// through a watcher that lets it reach this machine only.
//
// It refuses to run, rather than skip, without both. It asks one short
// question of the smallest current model and stops at ten cents.
//
// No tripwire is armed here: this process is the model route, and reaching
// the provider is its job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadClaudeSdk } from '../../lib/runtimes/claude-sdk/load.ts'
import { startWatchProxy, type WatchProxy } from '../guards/watch-proxy.ts'
import { liveTurn, type LiveResult } from '../live/anthropic.ts'

const DIR = process.env.SWARMLAB_CLAUDE_SDK_DIR
const KEY_FILE = process.env.SWARMLAB_ANTHROPIC_KEY_FILE
const UPSTREAM = 'https://api.anthropic.com/v1'
// The smallest current model, at the higher of its two list prices (USD per million tokens), so the meter never reads low.
// Check both against Anthropic's price list before a run: they were current on 2026-11-03.
const MODEL = 'claude-haiku-5-5'
const PRICE = { inPerMTok: 0.5, outPerMTok: 2.5 }

let watch: WatchProxy | undefined
let result: LiveResult | undefined
beforeAll(async () => {
  if (!DIR) throw new Error('REFUSING TO RUN: set SWARMLAB_CLAUDE_SDK_DIR to a folder the Claude Agent SDK is installed in. This suite never skips.')
  if (!KEY_FILE) throw new Error('REFUSING TO RUN: set SWARMLAB_ANTHROPIC_KEY_FILE to a file holding an Anthropic API key. This suite never skips.')
  watch = await startWatchProxy()
  result = await liveTurn({
    sdk: await loadClaudeSdk(DIR), upstream: UPSTREAM, keyFile: KEY_FILE, model: MODEL, price: PRICE, budgetUsd: 0.10,
    question: 'Reply with the single word: ready', watch, turnDeadlineMs: 120_000,
  })
}, 300_000)
afterAll(() => watch?.close())

describe(`one live turn: the Claude Agent SDK behind the door, ${MODEL} at the far end`, () => {
  it('the question got a reply', () => {
    expect(result!.reply ?? '').not.toBe('')
  })

  it('every call was metered from the usage the provider reported, and the cap then refused', () => {
    expect(result!.meter.requests).toBeGreaterThan(0)
    expect(result!.unmetered).toBe(0)
    expect(result!.meter.usd).toBeGreaterThan(0)
    expect(result!.meter.usd).toBeLessThan(0.10)
    expect(result!.capRefused).toBe(true)
  })

  it('the SDK only ever presented the placeholder, the key is in no file of its own, and it reached for nothing but the route', () => {
    expect(new Set(result!.presented)).toEqual(new Set([result!.placeholder]))
    expect(result!.keyInCell).toEqual([])
    expect(result!.attempts).toEqual([])
  })
})
