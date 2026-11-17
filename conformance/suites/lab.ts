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
import { createMemoryStore, type MemoryStore } from '../../lib/door/memory.ts'
import { startModelRoute, type ModelRoute } from '../../lib/door/model-route.ts'
import { createReceiptLog, type ReceiptLog } from '../../lib/door/receipts.ts'
import { createSanitizer } from '../../lib/door/sanitizer.ts'
import { startFakeWeb, type FakeWeb } from '../../lib/door/testing/fake-web.ts'
import { createWebFetcher, type WebLimits } from '../../lib/door/web-fetch.ts'
import { createMemoryLedger } from '../../lib/door/spend-ledger.ts'
import { startChattyShim } from '../broken/chatty.ts'
import { brokenMemoryStore, type BrokenMemory } from '../broken/memory-stores.ts'
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
  /** Where the lab's work dir is made. Default: the temp dir. Anywhere unsafe is refused (F5). */
  workRoot?: string
  /**
   * Set when the harness runs in a container of its own and this lab is the
   * sidecar's side of a rig. The rig was given its nonce, its cell token and
   * its shared folder from outside, and the cell dials in over the rig's
   * network, so the lab listens on every interface of its own container.
   */
  remote?: RemoteCell
  /** How long a turn may take before the door gives up on it. Default 8 s. */
  turnDeadlineMs?: number
  /** How long the door waits for an admin to answer a request to run a tool. Default 5 s. */
  approvalTimeoutMs?: number
  /** The time one shell call may run and the output that reaches the model, handed to the cell. */
  toolLimits?: { callSeconds?: number; outputBytes?: number }
  /**
   * A rig broken on purpose, outside the door. `answers-as-admin`: the chat surface reports every
   * answer to a request as sent by the fixture's admin, whoever sent it. The door has no way to
   * know better, so it shows that the check on who may answer can go red.
   */
  rig?: 'answers-as-admin' | BrokenMemory | 'search-key-anyway' | 'web-no-list' | 'web-no-address-check' | 'web-unchecked-redirects' | 'web-keeps-cookies' | 'web-no-limits'
  /**
   * The door keeps notes for each room (lib/door/memory.ts), in a folder of the lab's own that the
   * harness is never given: not the work dir, which a cell shares. `dir` reuses a folder another lab
   * made, for a check that starts a second door and harness on the same notes; that lab owns it.
   */
  memory?: { dir?: string }
  /** What the harness is told it is, as the launcher would tell it, or how to get it. Left out, the harness keeps its own. */
  systemPrompt?: string | (() => Promise<string>)
  /** Left out or true, the door has a search key (minted per lab) and the fake provider; false, it has none. */
  searchKey?: boolean
  /** The door's limits on a web fetch, for a check that wants them small. */
  webLimits?: Partial<WebLimits>
}

export interface RemoteCell {
  nonce: string
  brainToken: string
  /** The folder both containers mount. It is used as it is: not created, not removed. */
  dir: string
  /** The name the cell knows this container by. */
  advertise: string
  brainPort: number
  routePort: number
}

export interface Lab {
  nonce: string
  harness: HarnessUnderTest
  door: Door
  fake: FakeConnector
  model: ScriptedModel
  route: ModelRoute
  receipts: ReceiptLog
  /** The only web the door can reach in a lab: a server on loopback that plays every site, and a fake DNS. */
  web: FakeWeb
  /** Secrets that must never show up in the cell or in a post. */
  secrets: { upstream: string; chat: string; brain: string; search: string }
  /**
   * A variable planted in this test process's own environment before the shim
   * started. It is not a secret and not shaped like one. A harness that
   * inherits its environment from the shim will have it; one that is given a
   * hand-listed environment will not.
   */
  hostCanary: { name: string; value: string }
  /** The lab's work dir. Where the harness is in a container, it is the folder both sides mount. */
  dir: string
  canary(name: string): string
  /** A path a tool run by the harness can touch, and the lab can see. */
  file(name: string): string
  /** Something outside the scratch folder, for a harness the tool checks run on. */
  outside(): ReturnType<NonNullable<HarnessUnderTest['tools']>['outside']>
  /** What the tripwire inside the harness process saw. Read it before close(): the log goes with the lab. */
  tripwire(): { armed: number; attempts: string[] }
  /** Add a scripted reply. */
  script(entry: ScriptEntry): void
  policy(patch?: Record<string, unknown>): PolicyRecord
  /** The door's notes, when the lab keeps them. */
  memory?: MemoryStore
  /** Where the notes are on disk, when the lab keeps them. */
  memoryDir?: string
  /**
   * A second lab on the same notes: a new door, a new harness, the same folder of notes. As a restart
   * would leave things. The caller closes it, after reading its tripwire.
   */
  again(): Promise<Lab>
  close(): Promise<void>
}

// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICES = { scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

/**
 * Why a harness's patch to the starting policy is not allowed. It comes from the adapter of
 * the harness under test, so it may do one thing: take rooms away from a surface the fixture
 * already has. Anything else (a tool, a sender, the posture, a room the fixture does not
 * open, a room made easier to speak in) could make that harness's own checks easier to pass.
 * Empty means the patch only narrows.
 */
export function narrowingProblems(fixture: PolicyRecord, patch: Record<string, unknown> | undefined): string[] {
  const problems: string[] = []
  for (const [key, value] of Object.entries(patch ?? {})) {
    const m = /^surfaces\.([a-z]+)\.rooms$/.exec(key)
    const had = m ? fixture.surfaces[m[1] as keyof PolicyRecord['surfaces']]?.rooms : undefined
    if (!had) { problems.push(`${key} is not the room list of a surface the fixture has`); continue }
    if (!Array.isArray(value)) { problems.push(`${key} is not a list`); continue }
    const known = new Set(had.map((rule) => JSON.stringify(rule)))
    const added = value.filter((rule) => !known.has(JSON.stringify(rule))).length
    if (added > 0) problems.push(`${key} holds ${added} room rule(s) the fixture does not have`)
  }
  return problems
}

export async function startLab(o: LabOptions): Promise<Lab> {
  const widened = narrowingProblems(loadFixturePolicy('policy-team.json'), o.harness.policy)
  if (widened.length > 0) throw new Error(`REFUSING TO RUN: a harness may only take rooms away from the lab's starting policy: ${widened.join('; ')}`)
  const nonce = o.remote?.nonce ?? randomBytes(4).toString('hex')
  const dir = o.remote?.dir ?? mkdtempSync(path.join(o.workRoot ?? os.tmpdir(), `swarmlab-${nonce}-`))
  // F5: checked before anything is written there or started. A refused dir is removed again.
  try {
    assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })
  } catch (err) {
    if (!o.remote) rmSync(dir, { recursive: true, force: true })
    throw err
  }

  const secrets = { upstream: `UPSTREAM-${nonce}`, chat: `FAKECHAT-${nonce}`, brain: o.remote?.brainToken ?? `cell-${randomBytes(8).toString('hex')}`, search: `SEARCHKEY-${nonce}` }
  const listen = o.remote ? '0.0.0.0' : undefined
  const placeholder = `PLACEHOLDER-${nonce}`
  const policy = (patch: Record<string, unknown> = {}): PolicyRecord =>
    withHash(applyPatch(loadFixturePolicy('policy-team.json'), { ...o.harness.policy, ...o.policy, ...patch }))

  const hostCanary = { name: `LABHOST_CANARY_${nonce.toUpperCase()}`, value: `host-env-${randomBytes(6).toString('hex')}` }
  const closers: (() => Promise<void> | void)[] = [
    // A harness that was just stopped may still be writing its last file: a folder that is not empty yet is tried again.
    () => { if (!o.remote) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) },
    () => { delete process.env[hostCanary.name] },
  ]
  const closeAll = async (): Promise<void> => { for (const close of closers.reverse()) await close() }

  try {
    const script: ScriptEntry[] = []
    const model = await startScriptedModel({ nonce, script, shape: o.harness.modelShape.id })
    closers.push(() => model.close())
    const receipts = createReceiptLog()
    const fake = createFakeConnector({ nonce })
    const sanitizer = createSanitizer({ extraSecrets: [secrets.upstream, secrets.chat, secrets.brain, secrets.search] })
    // The notes' folder is the lab's own, outside the work dir, unless a rig puts it where the harness can write.
    let memoryDir: string | undefined
    let memory: MemoryStore | undefined
    if (o.memory) {
      if (o.rig === 'memory-in-scratch') {
        memoryDir = o.harness.workFile({ dir } as Cell, 'notes')
      } else if (o.memory.dir) {
        memoryDir = o.memory.dir
      } else {
        const own = mkdtempSync(path.join(os.tmpdir(), `swarmlab-notes-${nonce}-`))
        closers.push(() => { rmSync(own, { recursive: true, force: true }) })
        memoryDir = path.join(own, 'memory')
      }
      memory = brokenMemoryStore(o.rig, createMemoryStore({ dir: memoryDir, sanitizer, ...(o.rig === 'memory-no-checks' ? { checks: false } : {}) }))
    }
    const web = await startFakeWeb()
    closers.push(() => web.close())
    const webOptions = { ...web.options, limits: o.webLimits }
    // A door whose web fetcher is broken on purpose, in one way each, to show the web checks can go red.
    const broken = { addresses: true, redirects: true, bare: true, limits: true }
    const webFetcher = o.rig === 'web-no-address-check' ? createWebFetcher(webOptions, { ...broken, addresses: false })
      : o.rig === 'web-unchecked-redirects' ? createWebFetcher(webOptions, { ...broken, redirects: false })
        : o.rig === 'web-keeps-cookies' ? createWebFetcher(webOptions, { ...broken, bare: false })
          : o.rig === 'web-no-limits' ? createWebFetcher(webOptions, { ...broken, limits: false })
            : undefined
    if (o.rig === 'answers-as-admin') {
      // The surface lies about who answered. Everything else it passes on as it came.
      const admin = { id: 'u-root', display: 'u-root', isBot: false, isSelf: false, roles: [] }
      const onEvent = fake.connector.onEvent.bind(fake.connector)
      fake.connector.onEvent = (cb) => onEvent((e) => cb(
        e.kind === 'reaction' || (e.kind === 'inbound' && e.replyTo !== undefined) ? { ...e, sender: admin } : e,
      ))
    }
    const door = await createDoor({
      policy: policy(), connectors: [fake.connector], creds: { fake: { token: secrets.chat } },
      receipts, brainToken: secrets.brain, brainHost: listen, brainPort: o.remote?.brainPort, testing: true, silentVerdicts: o.silentVerdicts,
      sanitizer, memory,
      turnDeadlineMs: o.turnDeadlineMs ?? 8000, approvalTimeoutMs: o.approvalTimeoutMs ?? 5000,
      web: webOptions, ...(webFetcher ? { webFetcher } : {}),
      // A lab with no search key has none, unless the rig is broken to hand the door one anyway.
      ...(o.searchKey !== false || o.rig === 'search-key-anyway' ? { search: { key: secrets.search, endpoint: web.search.endpoint } } : {}), ...(o.rig === 'web-no-list' ? { webListUnchecked: true } : {}), ...(o.rig === 'memory-after-web' ? { notesAfterWeb: true } : {}),
    })
    closers.push(() => door.close())
    const route = await startModelRoute({
      upstream: model.baseUrl, upstreamKey: secrets.upstream, placeholder, shape: o.harness.modelShape,
      // A lab lives for one check and is never restarted, so its spend need not outlive it.
      policy: () => door.policy(), receipts, prices: PRICES, ledger: createMemoryLedger(),
      host: listen, port: o.remote?.routePort,
      // As the launcher wires it: a call that is refused or fails is told to the room.
      onFailure: (failure) => door.modelFailed(failure),
    })
    closers.push(() => route.close())

    const cell: Cell = {
      nonce, dir, placeholder, upstreamKey: secrets.upstream,
      modelBaseUrl: o.remote ? `http://${o.remote.advertise}:${o.remote.routePort}/v1` : route.baseUrl,
      link: { host: o.remote?.advertise ?? '127.0.0.1', port: door.brainPort, token: secrets.brain },
      verdictTimeoutMs: o.verdictTimeoutMs ?? 400, vetoTimeoutMs: o.vetoTimeoutMs ?? 2000,
      ...(o.toolLimits ? { toolLimits: o.toolLimits } : {}),
      ...(o.systemPrompt !== undefined ? { systemPrompt: typeof o.systemPrompt === 'function' ? await o.systemPrompt() : o.systemPrompt } : {}),
    }

    process.env[hostCanary.name] = hostCanary.value
    let shim: { close(): void }
    if (o.shim === 'chatty') {
      shim = await startChattyShim({ ...cell.link, caps: o.harness.caps })
    } else {
      // F2: what this exact shim is about to give the harness must hold nothing
      // credential-shaped. The only exception is a fake stamped with this run's nonce.
      assertNoCredentials(o.harness.cellEnv(cell, o.shim), { nonce, named: o.harness.namedEnv })
      shim = await o.harness.start(cell, o.shim)
    }
    closers.push(() => shim.close())
    await door.shimConnected()

    return {
      nonce, harness: o.harness, door, fake, model, route, receipts, web, secrets, hostCanary, dir, policy,
      canary: (name) => `CANARY-${name}-${nonce}`,
      file: (name) => o.harness.workFile(cell, name),
      outside: () => {
        if (!o.harness.tools) throw new Error('this harness has no tool surface for the tool checks')
        return o.harness.tools.outside(cell)
      },
      tripwire: () => o.harness.tripwire(cell),
      script: (entry) => { script.push(entry) },
      memory, memoryDir,
      again: () => {
        if (!memoryDir || o.remote) throw new Error('a second lab on the same notes needs a lab that keeps notes, on this machine')
        return startLab({ ...o, memory: { dir: memoryDir } })
      },
      close: closeAll,
    }
  } catch (err) {
    await closeAll()
    throw err
  }
}
