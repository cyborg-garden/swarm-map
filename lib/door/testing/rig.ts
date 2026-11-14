// One door, one scripted room, one echo shim, all on loopback. Shared by the
// plumbing tests. Every secret here is minted per rig and never written down.
import { randomBytes } from 'node:crypto'
import type { PolicyRecord } from '../../core/policy/types.ts'
import { createFakeConnector, type FakeConnector } from '../connectors/fake.ts'
import { createDoor, type Door, type DoorOptions } from '../door.ts'
import { createReceiptLog, type ReceiptLog } from '../receipts.ts'
import { startEchoShim, type EchoMode, type EchoShim } from './echo-shim.ts'

export interface Rig {
  nonce: string
  door: Door
  fake: FakeConnector
  shim: EchoShim
  receipts: ReceiptLog
  close(): Promise<void>
}

export async function startRig(policy: PolicyRecord, opts: {
  mode?: EchoMode
  noShim?: boolean
  door?: Partial<DoorOptions>
  verdictTimeoutMs?: number
} = {}): Promise<Rig> {
  const nonce = randomBytes(4).toString('hex')
  const brainToken = `cell-${randomBytes(8).toString('hex')}`
  const fake = createFakeConnector({ nonce })
  const receipts = createReceiptLog()
  const door = await createDoor({
    policy, connectors: [fake.connector], creds: { fake: { token: `FAKECHAT-${nonce}` } },
    receipts, brainToken, testing: true, ...opts.door,
  })
  let shim = undefined as EchoShim | undefined
  if (!opts.noShim) {
    shim = await startEchoShim({ port: door.brainPort, token: brainToken, mode: opts.mode, verdictTimeoutMs: opts.verdictTimeoutMs })
    await door.shimConnected()
  }
  return {
    nonce, door, fake, receipts, shim: shim as EchoShim,
    close: async () => { shim?.close(); await door.close() },
  }
}
