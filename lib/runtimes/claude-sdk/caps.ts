// What the Claude Agent SDK shim declares to the sidecar. Pinned to one
// version of the SDK package, which ships one version of the Claude Code
// program inside it. Both change often, and a new version means a new
// matrix, not an edit here. Each field says only what has been run.
import type { ToolClass } from '../../core/policy/types.ts'
import type { Capabilities } from '../../door/protocol.ts'

/** The npm package `@anthropic-ai/claude-agent-sdk`. */
export const CLAUDE_SDK_VERSION = '0.3.325'
/** The Claude Code program that package version ships and starts. */
export const CLAUDE_CODE_VERSION = '2.1.325'
/** What the pinned install says it is. The shim sends no turn to anything else. */
export const CLAUDE_SDK_VERSION_LINE = `${CLAUDE_SDK_VERSION} (Claude Agent SDK), ${CLAUDE_CODE_VERSION} (Claude Code)`

/**
 * The built-in tools the shim is willing to start a session with, classified.
 * These three are every tool the pinned SDK has in its minimal mode, which is
 * the only mode the shim starts it in. Outside that mode it has many more (a
 * separate write tool, web fetch and search, sub-agents, notebooks, tasks,
 * schedules). None of those can be listed here: the door offers what is in
 * this map, a session is started with exactly what it was offered, and one
 * that reports other tools than it was started with is stopped. So a name the
 * SDK does not have would stop every turn of a policy that allows its class.
 * `Edit` makes a file that does not exist yet, so there is no need for `Write`.
 */
export const CLAUDE_SDK_TOOL_MAP: Record<string, ToolClass> = {
  Read: 'file_read',
  Edit: 'file_write',
  Bash: 'shell',
}

export const CLAUDE_SDK_CAPS: Capabilities = {
  harness: 'claude-sdk',
  version: CLAUDE_SDK_VERSION,
  // The SDK has no chat connector. Claude Code's own channels need a person at a terminal.
  ownsChat: false,
  toolVeto: 'pre-call',
  approvalRoundTrip: false, // it can hold a call for as long as it takes; the door's ask flow is not built yet
  toolMap: CLAUDE_SDK_TOOL_MAP,
  modelBaseUrl: true,
  mcpClient: false, // started with no MCP server, and told to read none from disk
  // It has a memory of its own (notes it keeps, and instruction files it reads from disk).
  // The shim starts it with both switched off, and each session keeps its own transcript.
  nativeMemory: 'off-able',
  sessions: 'one-per-process',
  steer: false,
  resume: false, // the shim keeps each session's id in memory only
  usage: 'route-only',
  streaming: false,
  toolChange: 'restart', // its tools are fixed when a session's process starts
  // Every session's process shares one home and one work dir.
  sessionIsolation: 'none',
  modelShape: 'anthropic-messages',
}
