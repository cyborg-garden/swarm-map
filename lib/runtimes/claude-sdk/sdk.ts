// The slice of the Claude Agent SDK the shim uses, written out as types of
// its own. The SDK is not a dependency of this repo: it is installed, pinned,
// in the place it runs (the lab's cell image, or a folder a local run is
// pointed at), and handed to the shim as a value of this shape. The names and
// meanings below were checked against the types the package ships
// (`sdk.d.ts`, version 0.3.325) and against the real thing running.
export interface SdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
}

/** What the SDK hands back, as far as the shim reads it. Every other field is ignored. */
export interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  /** On `system`/`init`: the tools the session really has. */
  tools?: string[]
  /** On `system`/`init`: the version of Claude Code that is running. */
  claude_code_version?: string
  /** On `result`: the reply. Also where the SDK writes an error, so `is_error` has to be read with it. */
  result?: string
  is_error?: boolean
  /**
   * On `assistant` and `user`: the message itself. The shim reads only its `tool_use` blocks
   * (`id`, `name`) and its `tool_result` blocks (`tool_use_id`).
   */
  message?: { content?: unknown }
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal
  /** Which call this is: the `id` of its `tool_use` block. The SDK 0.3.325 always sends it. */
  toolUseID?: string
}) => Promise<PermissionResult>

export interface SdkOptions {
  cwd: string
  /** Replaces the environment of the Claude Code process. Nothing is merged in from the caller's. */
  env: Record<string, string>
  model: string
  /** The built-in tools the session has. An empty list means none. */
  tools: string[] | { type: 'preset'; preset: 'claude_code' }
  /** Tools that run without asking. */
  allowedTools: string[]
  permissionMode: 'default' | 'bypassPermissions'
  allowDangerouslySkipPermissions?: boolean
  canUseTool?: CanUseTool
  /** Which settings files to read from disk. Empty: none. */
  settingSources: string[]
  /** Settings given in the call itself. */
  settings?: { permissions?: { ask?: string[] } }
  mcpServers: Record<string, never>
  strictMcpConfig: boolean
  skills: string[]
  plugins: never[]
  systemPrompt: string
  /** Flags for Claude Code that have no option of their own. `null` is a flag with no value. */
  extraArgs: Record<string, string | null>
  /** Pick a stored session back up by its id. */
  resume?: string
  /** Pick up whichever session was used last in this folder. The shim never sets it. */
  continue?: boolean
  stderr?: (data: string) => void
}

export interface SdkQuery extends AsyncIterable<SdkMessage> {
  close(): void
}

export interface ClaudeSdk {
  /** What this install says it is: the package's version and the version of the Claude Code it starts. */
  version(env: Record<string, string>): Promise<string>
  query(args: { prompt: AsyncIterable<SdkUserMessage>; options: SdkOptions }): SdkQuery
}
