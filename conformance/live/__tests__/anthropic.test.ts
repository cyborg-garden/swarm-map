// @vitest-environment node
//
// The live run's plumbing, with nothing live in it: the scripted model stands
// where the provider would be, the fake SDK where the real one would be, and
// the key file is made here. What a real run adds is an address and a key.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../guards/tripwire.ts'
import { startWatchProxy, type WatchProxy } from '../../guards/watch-proxy.ts'
import { fakeClaudeSdk } from '../../rig/fake-claude-sdk.ts'
import { startScriptedModel, type ScriptedModel } from '../../rig/scripted-model.ts'
import { liveTurn, readKeyFile } from '../anthropic.ts'

armTripwire()

const NONCE = 'deadbeef'
const KEY = `UPSTREAM-${NONCE}`
// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICE = { inPerMTok: 5000, outPerMTok: 25000 }
let dir: string
let model: ScriptedModel | undefined
let watch: WatchProxy | undefined
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-livekey-')) })
afterEach(async () => {
  await model?.close()
  watch?.close()
  model = watch = undefined
  rmSync(dir, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})
const keyFile = (content = `${KEY}\n`, mode = 0o600): string => {
  const file = path.join(dir, 'key')
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

describe('a live turn, with a stand-in at each end', () => {
  it('[U:live-turn] one question gets one reply, the provider saw the key from the file, the SDK only ever held the placeholder, and the cap then refuses', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [{ match: 'CANARY-live', text: 'a live answer' }], shape: 'anthropic-messages' })
    watch = await startWatchProxy()
    const result = await liveTurn({
      sdk: fakeClaudeSdk(), upstream: model.baseUrl, keyFile: keyFile(), model: 'scripted', price: PRICE, budgetUsd: 5,
      question: 'say CANARY-live', watch,
    })
    expect(result.reply).toBe(`a live answer FAKE-MODEL-${NONCE}`)
    expect(model.requests.map((r) => r.key)).toEqual([KEY])
    // No tool is on offer in a live run, whatever the model says.
    expect(JSON.parse(model.requests[0].body).tools).toEqual([])
    expect(result.presented).toEqual([result.placeholder])
    expect(result.placeholder).toMatch(/^PLACEHOLDER-[0-9a-f]{8}$/)
    expect(result.meter).toEqual({ requests: 1, inTokens: 100, outTokens: 20, usd: 1 })
    expect(result.unmetered).toBe(0)
    expect(result.keyInCell).toEqual([])
    expect(result.attempts).toEqual([])
    expect(result.capRefused).toBe(true)
    expect(result.receipts).toContainEqual({ rule: 'budget.cap', verdict: 'deny' })
  })

  it('[U:live-turn] a budget smaller than one call refuses the first one, and nothing is posted', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [], shape: 'anthropic-messages' })
    const result = await liveTurn({ sdk: fakeClaudeSdk(), upstream: model.baseUrl, keyFile: keyFile(), model: 'scripted', price: PRICE, budgetUsd: 0, question: 'hello' })
    expect(result.reply).toBeUndefined()
    expect(model.requests).toEqual([])
    expect(result.meter.requests).toBe(0)
  })

  it('[U:live-turn] the wrong key in the file is the provider\'s refusal, costs nothing, and is not posted as a reply', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [], shape: 'anthropic-messages' })
    const result = await liveTurn({ sdk: fakeClaudeSdk(), upstream: model.baseUrl, keyFile: keyFile('not-the-key\n'), model: 'scripted', price: PRICE, budgetUsd: 5, question: 'hello' })
    expect(result.reply).toBeUndefined()
    expect(model.refused).toBe(1)
    expect(result.meter.usd).toBe(0)
    expect(result.capRefused).toBe(false)
  })

  it.each([
    ['a file that is not there', () => path.join(dir, 'missing'), 'cannot be read'],
    ['a folder', () => dir, 'not a plain file'],
    ['a file others can read', () => keyFile(`${KEY}\n`, 0o644), 'can be read by others'],
    ['an empty file', () => keyFile(''), 'on one line and nothing else'],
    ['a file with two lines', () => keyFile(`${KEY}\nsomething else\n`), 'on one line and nothing else'],
  ])('[U:live-turn] the key file is refused when it is %s, and the refusal never holds the key', (_what, file, why) => {
    let message = ''
    try { readKeyFile(file()) } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/^REFUSING TO RUN: /)
    expect(message).toContain(why)
    expect(message).not.toContain(KEY)
  })

  it('[U:live-turn] a good key file gives the key, without the line ending', () => {
    expect(readKeyFile(keyFile(`  ${KEY}  \n\n`))).toBe(KEY)
  })
})
