// What the Letta Code shim declares to the sidecar. Pinned to one Letta Code
// version: it ships several times a day, and a new version means a new
// matrix, not an edit here. Each field says only what has been run.
import type { ToolClass } from '../../core/policy/types.ts'
import type { Capabilities } from '../../door/protocol.ts'

export const LETTA_CODE_VERSION = '0.34.60'
/** What `--version` prints for the pinned version. The shim sends no turn to anything else. */
export const LETTA_CODE_VERSION_LINE = `${LETTA_CODE_VERSION} (Letta Code)`

/**
 * The tools of Letta Code 0.34.60's default toolset that the shim is willing
 * to start it with, classified. It has more (sub-agents, schedules, worktrees,
 * workflows). Those are left out on purpose: a tool that is not here is never
 * offered, so Letta Code is never started with it.
 */
export const LETTA_CODE_TOOL_MAP: Record<string, ToolClass> = {
  Read: 'file_read',
  Edit: 'file_write',
  Write: 'file_write',
  Bash: 'shell',
  Memory: 'memory',
}

export const LETTA_CODE_CAPS: Capabilities = {
  harness: 'letta-code',
  version: LETTA_CODE_VERSION,
  // It has chat channels of its own. They belong to its server mode, which this shim never starts.
  ownsChat: true,
  toolVeto: 'pre-call',
  approvalRoundTrip: false, // it can hold a call for as long as it takes; the door's ask flow is not built yet
  toolMap: LETTA_CODE_TOOL_MAP,
  modelBaseUrl: true,
  mcpClient: false, // none is configured in the home the shim gives it
  // Its memory is a folder per agent that is read into every conversation.
  // It will not start without it. So the door gives it one conversation.
  nativeMemory: 'always-on',
  sessions: 'one-per-process',
  steer: false,
  resume: false, // the shim keeps the agent's id in memory only
  usage: 'route-only',
  streaming: false,
  toolChange: 'restart', // its tools are fixed by --tools at process start
  // Every conversation's process shares one home and one work dir.
  sessionIsolation: 'none',
  modelShape: 'openai-chat',
}
