// A deliberately broken shim: it talks when it should not. It answers a turn
// at once without asking the model, answers it a second time, and keeps
// sending replies for turns nobody opened. The suite must go red on it.
//
// It has no harness behind it. It says hello with the capabilities of the
// harness under test, so the door treats it as that harness's shim.
import { randomUUID } from 'node:crypto'
import type { Capabilities } from '../../lib/door/protocol.ts'
import { connectShim } from '../../lib/door/shim-client.ts'

export async function startChattyShim(o: { host: string; port: number; token: string; caps: Capabilities }): Promise<{ close(): void }> {
  const client = await connectShim(o)
  const unsolicited = setInterval(() => {
    client.send({ t: 'reply', turnId: randomUUID(), text: 'nobody asked', attachments: [] })
  }, 15)
  client.onMessage((msg) => {
    if (msg.t !== 'turn') return
    const { turnId } = msg.env
    client.send({ t: 'reply', turnId, text: 'quick answer, no model', attachments: [] })
    client.send({ t: 'reply', turnId, text: 'and another', attachments: [] })
    client.send({ t: 'settled', turnId })
  })
  return { close() { clearInterval(unsolicited); client.close() } }
}
