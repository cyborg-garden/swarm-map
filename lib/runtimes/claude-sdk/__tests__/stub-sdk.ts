// A stand-in for the SDK in the shim's own tests: it writes down how each
// session was started, and plays whatever a test tells it to for each
// message it is sent.
import { CLAUDE_CODE_VERSION, CLAUDE_SDK_VERSION_LINE } from '../caps.ts'
import type { ClaudeSdk, SdkMessage, SdkOptions } from '../sdk.ts'

export interface StubSdk {
  sdk: ClaudeSdk
  /** The options of every session started, in order. */
  started: SdkOptions[]
  /** Every message sent, with the index of the session it went to. */
  sent: { session: number; text: string }[]
  closed: number[]
}

/** What the stand-in does with one message. Returning 'end' ends the session there, as a process that exits would. */
export type Play = (text: string, options: SdkOptions, session: number) => AsyncGenerator<SdkMessage, 'end' | void> | Generator<SdkMessage, 'end' | void>

export const init = (options: SdkOptions, patch: Partial<SdkMessage> = {}): SdkMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'session-1', tools: options.tools as string[], claude_code_version: CLAUDE_CODE_VERSION, ...patch })
export const done = (result: string, patch: Partial<SdkMessage> = {}): SdkMessage =>
  ({ type: 'result', subtype: 'success', is_error: false, result, ...patch })

export function stubSdk(play: Play, version: string = CLAUDE_SDK_VERSION_LINE): StubSdk {
  const stub: StubSdk = {
    started: [], sent: [], closed: [],
    sdk: {
      version: async () => version,
      query({ prompt, options }) {
        const session = stub.started.push(options) - 1
        let closed = false
        return {
          close() { closed = true; stub.closed.push(session) },
          async* [Symbol.asyncIterator]() {
            for await (const message of prompt) {
              if (closed) return
              stub.sent.push({ session, text: message.message.content })
              if ((yield* play(message.message.content, options, session)) === 'end') return
            }
          },
        }
      },
    },
  }
  return stub
}
