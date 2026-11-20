// What the OpenCode shim declares to the sidecar. Pinned to one OpenCode
// version: a new version means a new run of the checks, not an edit here.
// Each field says only what has been run.
import type { ToolClass } from '../../core/policy/types.ts'
import type { Capabilities } from '../../door/protocol.ts'
import type { AcpToolKind } from '../acp/permission.ts'

export const OPENCODE_VERSION = '1.19.5'
/** What OpenCode reports as its name and version at ACP `initialize`. The shim sends no prompt to anything else. */
export const OPENCODE_AGENT_INFO = { name: 'OpenCode', version: OPENCODE_VERSION }

/**
 * The OpenCode tools the shim is willing to start it with, by the name OpenCode's permission
 * rules use, classified. OpenCode's `edit` rule covers its edit, write and patch tools. It has
 * more (glob, grep, list, web fetch and search, sub-agents, todo lists, skills, LSP). Those are
 * denied in the config the shim writes, so OpenCode is never started with them.
 */
export const OPENCODE_TOOL_MAP: Record<string, ToolClass> = {
  bash: 'shell',
  read: 'file_read',
  edit: 'file_write',
}

/** Which ACP tool kind OpenCode reports for each of those tools (its acp/tool.ts). Any other kind is refused. */
export const OPENCODE_KINDS: Partial<Record<AcpToolKind, string>> = {
  execute: 'bash',
  read: 'read',
  edit: 'edit',
}

export const OPENCODE_CAPS: Capabilities = {
  harness: 'opencode',
  version: OPENCODE_VERSION,
  ownsChat: false, // it has no chat connector
  toolVeto: 'pre-call',
  // It holds a call for as long as the permission request is open, and the shim checks that a yes names the call.
  approvalRoundTrip: true,
  toolMap: OPENCODE_TOOL_MAP,
  modelBaseUrl: true,
  mcpClient: false, // every session is opened with no MCP server
  nativeMemory: 'none', // started with project instructions off; its sessions are kept per session
  sessions: 'one-per-process',
  steer: false,
  resume: false, // the shim keeps each session's id in memory only
  usage: 'route-only',
  streaming: false,
  toolChange: 'restart', // its permission rules are fixed when its process starts
  // Every session's process shares one home and one work dir.
  sessionIsolation: 'none',
  modelShape: 'openai-chat',
}
