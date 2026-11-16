// One turn through the whole door with the Claude Agent SDK behind it and a
// real model provider at the far end. Everything else in the lab talks to a
// scripted model; this is the piece that does not have to.
//
// It is the same wiring as a lab (suites/lab.ts): a door, the fake chat
// room, the model route, the shim. What differs is where the route sends its
// calls and where its key comes from: an address and a key FILE, named by
// whoever runs it. The key is read here, handed to the route, and to nothing
// else. The SDK gets a placeholder, as always.
//
// CI runs this against the scripted model with a key file made for the test
// (live/__tests__/anthropic.test.ts), which shows the plumbing. A run against
// the real API is suites/anthropic-live.real.test.ts, and needs a real key.
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withHash } from '../../lib/core/policy/canonical.ts'
import { createFakeConnector } from '../../lib/door/connectors/fake.ts'
import { createDoor, isNotice } from '../../lib/door/door.ts'
import { startModelRoute, type Meter, type Price } from '../../lib/door/model-route.ts'
import { ANTHROPIC_MESSAGES } from '../../lib/door/model-shapes.ts'
import { createReceiptLog } from '../../lib/door/receipts.ts'
import { createSanitizer } from '../../lib/door/sanitizer.ts'
import { createMemoryLedger } from '../../lib/door/spend-ledger.ts'
import type { ClaudeSdk } from '../../lib/runtimes/claude-sdk/sdk.ts'
import { startClaudeSdkShim } from '../../lib/runtimes/claude-sdk/shim.ts'
import { assertSafeWorkDir } from '../guards/preflight.ts'
import { watchProxyEnv, type WatchProxy } from '../guards/watch-proxy.ts'
import { applyPatch, loadFixturePolicy } from '../scenarios/load.ts'

export interface LiveOptions {
  sdk: ClaudeSdk
  /** The provider's base URL, ending in /v1. */
  upstream: string
  /** A file holding the key and nothing else: one line, readable by its owner only. */
  keyFile: string
  /** The model to ask for, and what it costs. The route refuses a model with no price. */
  model: string
  price: Price
  /** The most this run may spend, in USD. The route refuses the call after it. */
  budgetUsd: number
  /** What to ask. */
  question: string
  /** Sends the SDK's traffic through a watcher, so anything but the route is refused and recorded. */
  watch?: WatchProxy
  turnDeadlineMs?: number
}

export interface LiveResult {
  /** What was posted to the room, if anything was. */
  reply: string | undefined
  /** Lines the door posted because a turn had no answer, with the reason. */
  notices: string[]
  meter: Meter
  /** Calls charged by size because the provider's usage could not be read. Zero means every call was metered from what the provider said. */
  unmetered: number
  /** What the SDK presented where a key goes, one per forwarded call. */
  presented: string[]
  placeholder: string
  /** Files under the SDK's home and work folder that hold the key. */
  keyInCell: string[]
  /** Was the next turn refused once the budget was set below what had been spent? */
  capRefused: boolean
  /** What the SDK tried to reach that was not this machine, as the watcher saw it. Undefined with no watcher. */
  attempts: string[] | undefined
  receipts: { rule: string; verdict: string }[]
}

/** Read a key from a file that holds one line and is readable by its owner only. The key is never part of an error. */
export function readKeyFile(file: string): string {
  let stat
  try { stat = statSync(file) } catch { throw new Error('REFUSING TO RUN: the key file cannot be read') }
  if (!stat.isFile()) throw new Error('REFUSING TO RUN: the key file is not a plain file')
  if ((stat.mode & 0o077) !== 0) throw new Error('REFUSING TO RUN: the key file can be read by others: give it mode 600')
  const lines = readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length !== 1) throw new Error('REFUSING TO RUN: the key file must hold the key on one line and nothing else')
  return lines[0]
}

function filesHolding(dir: string, secret: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    const stat = lstatSync(file)
    if (stat.isDirectory()) filesHolding(file, secret, found)
    else if (stat.isFile() && readFileSync(file).includes(secret)) found.push(file)
  }
  return found
}

export async function liveTurn(o: LiveOptions): Promise<LiveResult> {
  const key = readKeyFile(o.keyFile)
  const nonce = randomBytes(4).toString('hex')
  const dir = mkdtempSync(path.join(os.tmpdir(), `swarmlab-live-${nonce}-`))
  const closers: (() => Promise<void> | void)[] = [() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]
  try {
    assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })
    const dirs = { home: path.join(dir, 'home'), work: path.join(dir, 'work') }
    for (const d of Object.values(dirs)) mkdirSync(d)
    const secrets = { chat: `FAKECHAT-${nonce}`, brain: `cell-${randomBytes(8).toString('hex')}` }
    const placeholder = `PLACEHOLDER-${nonce}`
    // The team fixture with no tool allowed, and a cap. Nothing a model says here can run anything.
    const policy = (monthlyUsd: number, version: number) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), {
      version, 'tools.allow': [], budget: { monthlyUsd, onExceed: 'refuse' },
    }))

    const receipts = createReceiptLog()
    const fake = createFakeConnector({ nonce })
    const door = await createDoor({
      policy: policy(o.budgetUsd, 1), connectors: [fake.connector], creds: { fake: { token: secrets.chat } },
      receipts, brainToken: secrets.brain, testing: true, turnDeadlineMs: o.turnDeadlineMs ?? 120_000,
      sanitizer: createSanitizer({ extraSecrets: [key, secrets.chat, secrets.brain] }),
    })
    closers.push(() => door.close())
    const route = await startModelRoute({
      upstream: o.upstream, upstreamKey: key, placeholder, shape: ANTHROPIC_MESSAGES,
      policy: () => door.policy(), receipts, prices: { [o.model]: o.price }, ledger: createMemoryLedger(),
      onFailure: (failure) => door.modelFailed(failure),
    })
    closers.push(() => route.close())

    const shimOptions = {
      host: '127.0.0.1', port: door.brainPort, token: secrets.brain, sdk: o.sdk, homeDir: dirs.home, workDir: dirs.work,
      modelBaseUrl: route.baseUrl, placeholder, model: o.model, startMs: 60_000,
      rigEnv: o.watch ? watchProxyEnv(o.watch.url) : {},
    }
    const mark = o.watch?.mark()
    const shim = await startClaudeSdkShim(shimOptions)
    closers.push(() => shim.close())
    await door.shimConnected()

    fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: o.question })
    await door.idle()
    // What the model said, and apart from it, any line the door posted because a turn had no answer.
    const reply = fake.ledger.find((post) => !isNotice(post.text))?.text

    // The cap, on the real meter: with the budget set below what was just spent, the next turn is refused.
    const spent = route.meter().usd
    let capRefused = false
    if (spent > 0) {
      door.setPolicy(policy(spent / 2, 2))
      const calls = route.meter().requests
      fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'and once more' })
      await door.idle()
      capRefused = route.meter().requests === calls && fake.ledger.filter((post) => !isNotice(post.text)).length <= 1
        && receipts.all().some((r) => r.rule === 'budget.cap' && r.verdict === 'deny')
    }

    return {
      reply, notices: fake.ledger.filter((post) => isNotice(post.text)).map((post) => post.text), meter: route.meter(), unmetered: route.unmetered, presented: [...route.presented], placeholder,
      keyInCell: filesHolding(dir, key), capRefused, attempts: mark?.attempts(),
      receipts: receipts.all().map((r) => ({ rule: r.rule, verdict: r.verdict })),
    }
  } finally {
    for (const close of closers.reverse()) await close()
  }
}
