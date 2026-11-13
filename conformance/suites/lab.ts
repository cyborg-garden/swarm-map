// One lab: a door, the fake connector, the scripted model behind the model
// route, and a shim driving a Pi process. Everything listens on loopback,
// every secret is minted for this lab, and the lab refuses to start if its
// work dir or the environment it hands to Pi is not provably safe.
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withHash } from '../../lib/core/policy/canonical.ts'
import type { PolicyRecord } from '../../lib/core/policy/types.ts'
import { createFakeConnector, type FakeConnector } from '../../lib/door/connectors/fake.ts'
import { createDoor, type Door } from '../../lib/door/door.ts'
import { startModelRoute, type ModelRoute } from '../../lib/door/model-route.ts'
import { createReceiptLog, type ReceiptLog } from '../../lib/door/receipts.ts'
import { createSanitizer } from '../../lib/door/sanitizer.ts'
import { piEnv, startPiShim } from '../../lib/runtimes/pi/shim.ts'
import { startChattyShim } from '../broken/chatty.ts'
import { assertNoCredentials, assertSafeWorkDir } from '../guards/preflight.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../scenarios/load.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GATE = path.resolve(HERE, '..', '..', 'lib', 'runtimes', 'pi', 'cell', 'gate.ts')

export type ShimKind = 'pi' | 'ignores-verdicts' | 'leaks-env' | 'chatty'

export interface LabOptions {
  shim: ShimKind
  /** How to start Pi: the fake one, or a real install. */
  piCommand: string[]
  policy?: Record<string, unknown>
  silentVerdicts?: boolean
}

export interface Lab {
  nonce: string
  door: Door
  fake: FakeConnector
  model: ScriptedModel
  route: ModelRoute
  receipts: ReceiptLog
  /** Secrets that must never show up in the cell or in a post. */
  secrets: { upstream: string; chat: string; brain: string }
  canary(name: string): string
  /** A path under this lab's work dir, for a tool to touch. */
  file(name: string): string
  /** Add a scripted reply. */
  script(entry: ScriptEntry): void
  policy(patch?: Record<string, unknown>): PolicyRecord
  close(): Promise<void>
}

export function fakePiCommand(): string[] {
  return [process.execPath, path.resolve(HERE, '..', 'rig', 'fake-pi.ts')]
}

// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICES = { scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

export async function startLab(o: LabOptions): Promise<Lab> {
  const nonce = randomBytes(4).toString('hex')
  const dir = mkdtempSync(path.join(os.tmpdir(), `swarmlab-${nonce}-`))
  assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })
  const dirs = { agent: path.join(dir, 'agent'), sessions: path.join(dir, 'sessions'), work: path.join(dir, 'work'), home: path.join(dir, 'home') }
  for (const d of Object.values(dirs)) mkdirSync(d)

  const secrets = { upstream: `UPSTREAM-${nonce}`, chat: `FAKECHAT-${nonce}`, brain: `cell-${randomBytes(8).toString('hex')}` }
  const placeholder = `PLACEHOLDER-${nonce}`
  const policy = (patch: Record<string, unknown> = {}): PolicyRecord =>
    withHash(applyPatch(loadFixturePolicy('policy-team.json'), { ...o.policy, ...patch }))

  const script: ScriptEntry[] = []
  const model = await startScriptedModel({ nonce, script })
  const receipts = createReceiptLog()
  const fake = createFakeConnector({ nonce })
  const door = await createDoor({
    policy: policy(), connectors: [fake.connector], creds: { fake: { token: secrets.chat } },
    receipts, brainToken: secrets.brain, testing: true, silentVerdicts: o.silentVerdicts,
    sanitizer: createSanitizer({ extraSecrets: [secrets.upstream, secrets.chat, secrets.brain] }),
    turnDeadlineMs: 8000,
  })
  const route = await startModelRoute({
    upstream: model.baseUrl, upstreamKey: secrets.upstream, placeholder,
    policy: () => door.policy(), receipts, prices: PRICES,
  })
  // Pi is pointed at the sidecar's model route and given a placeholder, never a key.
  writeFileSync(path.join(dirs.agent, 'models.json'), JSON.stringify({
    providers: { swarm: { baseUrl: route.baseUrl, api: 'openai-completions', apiKey: placeholder, models: [{ id: 'scripted' }] } },
  }))

  const link = { host: '127.0.0.1', port: door.brainPort, token: secrets.brain }
  const pi = {
    ...link, piCommand: o.piCommand, agentDir: dirs.agent, sessionsDir: dirs.sessions, workDir: dirs.work, homeDir: dirs.home,
    verdictTimeoutMs: 400, gateTimeoutMs: 2000,
  }
  // F2: what Pi is about to be given must hold nothing credential-shaped.
  assertNoCredentials(piEnv(pi))

  let shim: { close(): void }
  switch (o.shim) {
    case 'pi': shim = await startPiShim({ ...pi, gate: { path: GATE } }); break
    // Broken on purpose, each in one way. See the must-fail suite.
    case 'ignores-verdicts': shim = await startPiShim({ ...pi, gate: 'NONE-FOR-TESTS' }); break
    case 'leaks-env': shim = await startPiShim({ ...pi, gate: { path: GATE }, unsafeExtraEnv: { SWARMLAB_LEAK: secrets.upstream } }); break
    case 'chatty': shim = await startChattyShim(link); break
  }
  await door.shimConnected()

  return {
    nonce, door, fake, model, route, receipts, secrets, policy,
    canary: (name) => `CANARY-${name}-${nonce}`,
    file: (name) => path.join(dirs.work, name),
    script: (entry) => { script.push(entry) },
    async close() {
      shim.close()
      await door.close()
      await route.close()
      await model.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
