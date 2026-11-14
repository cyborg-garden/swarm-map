// One door, the real Discord connector, a fake Discord and an echo shim, all
// on loopback. Nothing here can start until assertFakeDiscord() has agreed
// that the connector is pointed at the fake and no real credential is about.
import { randomBytes } from 'node:crypto'
import type { PolicyRecord } from '../../core/policy/types.ts'
import type { SurfaceConnector } from '../connector.ts'
import { createDiscordConnector, type DiscordOptions } from '../connectors/discord.ts'
import { createDoor, type Door, type DoorOptions } from '../door.ts'
import { createReceiptLog, type ReceiptLog } from '../receipts.ts'
import { createSanitizer } from '../sanitizer.ts'
import { startEchoShim, type EchoMode, type EchoShim } from './echo-shim.ts'
import { assertFakeDiscord, FAKE_GUILD, startFakeDiscord, type FakeDiscord } from './fake-discord.ts'

/** Ids for the fake server. Digits, as Discord's are. */
export const IDS = {
  guild: FAKE_GUILD,
  home: '7100000000000000001', // the one allowed channel
  other: '7100000000000000002', // another channel in the same server
  thread: '7200000000000000001', // a thread in the allowed channel
  strayThread: '7200000000000000002', // a thread in the other channel
  admin: '8000000000000000001',
  member: '8000000000000000002',
  stranger: '8000000000000000003',
  bot: '8900000000000000001',
  role: '8500000000000000001',
} as const

export interface DiscordRig {
  fake: FakeDiscord
  connector: SurfaceConnector
  door: Door
  shim: EchoShim
  receipts: ReceiptLog
  brainToken: string
  /** Everything the connector logged. */
  logs: string[]
  /** Wait until the fake has seen `n` posts, or time runs out. */
  posts(n: number, timeoutMs?: number): Promise<void>
  /** Let the gateway deliver what was sent, then wait for the door to finish with it. */
  settle(): Promise<void>
  close(): Promise<void>
}

export async function startDiscordRig(policy: PolicyRecord, opts: {
  mode?: EchoMode
  noShim?: boolean
  door?: Partial<DoorOptions>
  connector?: Partial<DiscordOptions>
  heartbeatMs?: number
  env?: Record<string, string | undefined>
} = {}): Promise<DiscordRig> {
  const fake = await startFakeDiscord({ heartbeatMs: opts.heartbeatMs })
  try {
    assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce }, opts.env ?? process.env)
  } catch (err) {
    await fake.close()
    throw err
  }
  fake.addChannel({ id: IDS.home })
  fake.addChannel({ id: IDS.other })
  fake.addChannel({ id: IDS.thread, type: 11, parent: IDS.home })
  fake.addChannel({ id: IDS.strayThread, type: 11, parent: IDS.other })

  const logs: string[] = []
  const connector = createDiscordConnector({
    apiBase: fake.apiBase, sendScope: [IDS.home], guildId: IDS.guild, log: (line) => logs.push(line),
    reconnect: { firstMs: 5, maxMs: 20 }, readyTimeoutMs: 2000, maxRateLimitWaitMs: 300, ...opts.connector,
  })
  const receipts = createReceiptLog()
  const brainToken = `cell-${randomBytes(8).toString('hex')}`
  const door = await createDoor({
    policy, connectors: [connector], creds: { discord: { token: fake.token } }, live: ['discord'],
    receipts, brainToken, sanitizer: createSanitizer({ extraSecrets: [fake.token] }), ...opts.door,
  }).catch(async (err) => { await fake.close(); throw err })
  let shim: EchoShim | undefined
  if (!opts.noShim) {
    shim = await startEchoShim({ port: door.brainPort, token: brainToken, mode: opts.mode })
    await door.shimConnected()
  }
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    fake, connector, door, receipts, brainToken, logs, shim: shim as EchoShim,
    async posts(n, timeoutMs = 2000) {
      const until = Date.now() + timeoutMs
      while (fake.posted.length < n && Date.now() < until) await sleep(5)
    },
    async settle() {
      // The gateway is a socket: give what was sent time to arrive before asking the door if it is done.
      for (let i = 0; i < 3; i++) { await sleep(25); await door.idle() }
    },
    close: async () => { shim?.close(); await door.close(); await fake.close() },
  }
}
