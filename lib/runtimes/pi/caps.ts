// What the Pi shim declares to the sidecar. Pinned to one Pi version: Pi
// ships weekly, and a new version means a new matrix, not an edit here.
// Each field says only what has been run, not what the docs promise.
import type { ToolClass } from '../../core/policy/types.ts'
import type { Capabilities } from '../../door/protocol.ts'

export const PI_VERSION = '1.5.2'

/** Every built-in tool Pi 1.5.2 can be started with, classified. */
export const PI_TOOL_MAP: Record<string, ToolClass> = {
  read: 'file_read',
  grep: 'file_read',
  find: 'file_read',
  ls: 'file_read',
  edit: 'file_write',
  write: 'file_write',
  bash: 'shell',
}

export const PI_CAPS: Capabilities = {
  harness: 'pi',
  version: PI_VERSION,
  ownsChat: false,
  toolVeto: 'pre-call',
  approvalRoundTrip: false, // Pi can hold a call; the door's ask flow is not built yet
  toolMap: PI_TOOL_MAP,
  modelBaseUrl: true,
  mcpClient: false, // started with --no-mcp in this slice
  nativeMemory: 'none',
  sessions: 'one-per-process',
  steer: false,
  resume: false,
  usage: 'route-only',
  streaming: false,
  toolChange: 'restart', // Pi's tools are fixed by --tools at process start
  // Every session's Pi process shares one work dir, one home and one sessions
  // dir. Nothing outside Pi keeps them apart. The lab's Docker cell does not
  // either: it is one cell with one shared folder for every session.
  sessionIsolation: 'none',
  modelShape: 'openai-chat',
}
