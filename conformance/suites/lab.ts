// One lab: a door, the fake connector, the scripted model behind the model
// route, and a shim driving one harness. Everything listens on loopback,
// every secret is minted for this lab, and the lab refuses to start if its
// work dir or the environment it hands to the harness is not provably safe.
//
// This file names no harness. What differs between harnesses comes in as a
// HarnessUnderTest (see harness.ts).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withHash } from '../../lib/core/policy/canonical.ts'
import type { PolicyRecord } from '../../lib/core/policy/types.ts'
import { createFakeConnector, type FakeConnector } from '../../lib/door/connectors/fake.ts'
import { createDoor, type Door } from '../../lib/door/door.ts'
import { startModelRoute, type ModelRoute } from '../../lib/door/model-route.ts'
import { createReceiptLog, type ReceiptLog } from '../../lib/door/receipts.ts'
import { createSanitizer } from '../../lib/door/sanitizer.ts'
import { startChattyShim } from '../broken/chatty.ts'
import { assertNoCredentials, assertSafeWorkDir } from '../guards/preflight.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../scenarios/load.ts'
import type { Cell, HarnessUnderTest } from './harness.ts'

export interface LabOptions {
  harness: HarnessUnderTest
  /** 'good', 'chatty', or a key of `harness.broken`. */
  shim: string
  policy?: Record<string, unknown>
  silentVerdicts?: boolean
  /** How long the shim waits for a verdict. Default 400 ms. */
  verdictTimeoutMs?: number
  /** How long the in-cell veto waits for the shim. Default 2000 ms. */
  vetoTimeoutMs?: number
}

export interface Lab {
  nonce: string
  harness: HarnessUnderTest
  door: Door
  fake: FakeConnector
  model: ScriptedModel
  route: ModelRoute
  receipts: ReceiptLog
  /** Secrets that must never show up in the cell or in a post. */
  secrets: { upstream: string; chat: string; brain: string }
  /**
   * A variable planted in this test process's own environment before the shim
   * started. It is not a secret and not shaped like one. A harness that
   * inherits its environment from the shim will have it; one that is given a
   * hand-listed environment will not.
   */
  hostCanary: { name: string; value: string }
  canary(name: string): string
  /** A path a tool run by the harness can touch, and the lab can see. */
  file(name: string): string
  /** Add a scripted reply. */
  script(entry: ScriptEntry): void
  policy(patch?: Record<string, unknown>): PolicyRecord
  close(): Promise<void>
}

// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICES = { scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

export async function startLab(o: LabOptions): Promise<Lab> {
  const nonce = randomBytes(4).toString('hex')
  const dir = mkdtempSync(path.join(os.tmpdir(), `swarmlab-${nonce}-`))
  assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })

  const secrets = { upstream: `UPSTREAM-${nonce}`, chat: `FAKECHAT-${nonce}`, brain: `cell-${randomBytes(8).toString('hex')}` }
  const placeholder = `PLACEHOLDER-${nonce}`
  const policy = (patch: Record<string, unknown> = {}): PolicyRecord =>
    withHash(applyPatch(loadFixturePolicy('policy-team.json'), { ...o.policy, ...patch }))

  const hostCanary = { name: `LABHOST_CANARY_${nonce.toUpperCase()}`, value: `host-env-${randomBytes(6).toString('hex')}` }
  const closers: (() => Promise<void> | void)[] = [
    () => rmSync(dir, { recursive: true, force: true }),
    () => { delete process.env[hostCanary.name] },
  ]
  const closeAll = async (): Promise<void> => { for (const close of closers.reverse()) await close() }

  try {
    const script: ScriptEntry[] = []
    const model = await startScriptedModel({ nonce, script })
    closers.push(() => model.close())
    const receipts = createReceiptLog()
    const fake = createFakeConnector({ nonce })
    const door = await createDoor({
      policy: policy(), connectors: [fake.connector], creds: { fake: { token: secrets.chat } },
      receipts, brainToken: secrets.brain, testing: true, silentVerdicts: o.silentVerdicts,
      sanitizer: createSanitizer({ extraSecrets: [secrets.upstream, secrets.chat, secrets.brain] }),
      turnDeadlineMs: 8000,
    })
    closers.push(() => door.close())
    const route = await startModelRoute({
      upstream: model.baseUrl, upstreamKey: secrets.upstream, placeholder, shape: o.harness.modelShape,
      policy: () => door.policy(), receipts, prices: PRICES,
    })
    closers.push(() => route.close())

    const cell: Cell = {
      nonce, dir, placeholder, modelBaseUrl: route.baseUrl, upstreamKey: secrets.upstream,
      link: { host: '127.0.0.1', port: door.brainPort, token: secrets.brain },
      verdictTimeoutMs: o.verdictTimeoutMs ?? 400, vetoTimeoutMs: o.vetoTimeoutMs ?? 2000,
    }

    process.env[hostCanary.name] = hostCanary.value
    let shim: { close(): void }
    if (o.shim === 'chatty') {
      shim = await startChattyShim({ ...cell.link, caps: o.harness.caps })
    } else {
      // F2: what this exact shim is about to give the harness must hold nothing
      // credential-shaped. The only exception is a fake stamped with this run's nonce.
      assertNoCredentials(o.harness.cellEnv(cell, o.shim), { nonce })
      shim = await o.harness.start(cell, o.shim)
    }
    closers.push(() => shim.close())
    await door.shimConnected()

    return {
      nonce, harness: o.harness, door, fake, model, route, receipts, secrets, hostCanary, policy,
      canary: (name) => `CANARY-${name}-${nonce}`,
      file: (name) => o.harness.workFile(cell, name),
      script: (entry) => { script.push(entry) },
      close: closeAll,
    }
  } catch (err) {
    await closeAll()
    throw err
  }
}
