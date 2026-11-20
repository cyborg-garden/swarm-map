// The OpenCode shim: the generic ACP shim (../acp/shim.ts), started with what
// is true of OpenCode. This file and caps.ts are the only OpenCode-specific
// code that runs.
//
// - OpenCode is started as `opencode acp`, one process per session.
// - Its config is written by the shim into its home, and named by
//   OPENCODE_CONFIG. Its only model provider is the door's model route, with a
//   placeholder where a key would go. Its own hosted models are switched off.
// - Its permission rules ask before every tool the turn was offered and deny
//   every other one, which removes those from what it is started with. The
//   same rules are also passed in OPENCODE_PERMISSION.
// - Config and instruction files in the scratch folder are not read
//   (OPENCODE_DISABLE_PROJECT_CONFIG), and its global config folder is a new,
//   empty one for every process it starts, so nothing the agent writes on disk
//   can change a later process's rules or be read into a later prompt.
// - Its update check, its model list fetch, its default plugins, its LSP
//   downloads and the package install it does at start are switched off, and
//   nothing is inherited from the shim's env.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Capabilities } from '../../door/protocol.ts'
import { startAcpShim, type AcpLaunch, type AcpShim } from '../acp/shim.ts'
import { OPENCODE_AGENT_INFO, OPENCODE_CAPS, OPENCODE_KINDS, OPENCODE_TOOL_MAP } from './caps.ts'

export interface OpenCodeShimOptions {
  host: string
  port: number
  /** Per-cell token for the sidecar. Never passed on to OpenCode. */
  token: string
  /** How to start OpenCode, e.g. ['/usr/local/bin/opencode']. `acp` and its flags are appended. */
  command: string[]
  /** OpenCode's home: its config, its sessions and its caches all live under it. */
  homeDir: string
  /** The scratch folder. OpenCode is started there and its sessions are opened there. */
  workDir: string
  /** The door's model route, and what to present there instead of a key. */
  modelBaseUrl: string
  placeholder: string
  model?: string
  /** What the agent is told it is, in place of OpenCode's own introduction. */
  systemPrompt?: string
  verdictTimeoutMs?: number
  vetoTimeoutMs?: number
  startMs?: number
  /** Rig-only: extra env for OpenCode (a tripwire, or a leak planted on purpose). It cannot change the lines that keep it offline. */
  rigEnv?: Record<string, string>
  /** Rig-only: what a shim broken on purpose says about itself in its hello. */
  rigCaps?: Partial<Capabilities>
  onBreach?: (why: string) => void
}

/** The tool names the door may offer, in the order OpenCode's rules are written. */
const MAPPED = Object.keys(OPENCODE_TOOL_MAP)

/**
 * OpenCode's permission rules for one tool list. The last rule that matches wins, so `*` comes
 * first: every tool is denied, and the offered ones ask. A denied tool is not given to the model.
 * Nothing is ever `allow`: every call is put to the door, even one the door will allow at once.
 */
export function openCodePermission(tools: string[]): Record<string, 'ask' | 'deny'> {
  const out: Record<string, 'ask' | 'deny'> = { '*': 'deny' }
  for (const name of MAPPED) out[name] = tools.includes(name) ? 'ask' : 'deny'
  // Reaching outside the scratch folder is its own rule in OpenCode. It is never offered.
  out.external_directory = 'deny'
  return out
}

export function openCodeConfig(o: { baseUrl: string; placeholder: string; model: string; tools: string[]; systemPrompt?: string }): Record<string, unknown> {
  const model = `door/${o.model}`
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: model,
    // The door's route is the only provider: OpenCode's own hosted models are not listed.
    enabled_providers: ['door'],
    provider: {
      door: {
        npm: '@ai-sdk/openai-compatible',
        name: 'door',
        options: { baseURL: o.baseUrl, apiKey: o.placeholder },
        models: { [o.model]: { name: o.model, tool_call: true } },
      },
    },
    permission: openCodePermission(o.tools),
    // After a no, it goes back to the model, which can say so. Without this it ends the turn in silence.
    experimental: { continue_loop_on_deny: true },
    share: 'disabled',
    autoupdate: false,
    mcp: {},
    agent: {
      // It names each new session with a model call of its own. That call is not the turn's, and is charged like one.
      title: { disable: true },
      ...(o.systemPrompt !== undefined ? { build: { prompt: o.systemPrompt } } : {}),
    },
  }
}

/**
 * A folder of its own for each process the shim starts, under OpenCode's home: its config file,
 * and the folder OpenCode reads its global config, instructions and plugins from
 * (XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR). A shell call can write into a folder OpenCode will
 * read when it next starts, such as ~/.config/opencode. Each process gets a new, empty one, so
 * nothing written there by an earlier one is read by a later one.
 */
export function openCodeLaunchDir(homeDir: string): string {
  return path.join(homeDir, '.swarm-door', `launch-${randomBytes(8).toString('hex')}`)
}

/**
 * OpenCode's whole environment, listed by hand. Nothing is inherited from the shim's own env.
 * The lines after the rig's come last and win.
 */
export function openCodeEnv(o: Pick<OpenCodeShimOptions, 'homeDir' | 'rigEnv'>, extra: { configFile: string; permission: string; configDir: string }): Record<string, string> {
  return {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: o.homeDir,
    ...o.rigEnv,
    OPENCODE_CONFIG: extra.configFile,
    OPENCODE_PERMISSION: extra.permission,
    // Its global config, instructions (AGENTS.md) and plugins are read from here, not from ~/.config.
    XDG_CONFIG_HOME: extra.configDir,
    OPENCODE_CONFIG_DIR: path.join(extra.configDir, 'opencode'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_PURE: '1',
    // At start it installs a package of its own into its config folder, in the background. Offline, npm
    // makes no request for it, and the install fails quietly.
    npm_config_offline: 'true',
    DO_NOT_TRACK: '1',
  }
}

/** Why a system prompt cannot be handed to OpenCode, or undefined if it can. It goes into a JSON config file. */
export function openCodeSystemPromptProblem(prompt: string): string | undefined {
  if (prompt === '') return 'the system prompt is empty'
  if (prompt.length > 16_000) return 'the system prompt is too long'
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(prompt)) return 'the system prompt is not plain text'
  return undefined
}

export function openCodeArgs(workDir: string): string[] {
  return ['acp', '--cwd', workDir]
}

/** The command and environment for one OpenCode process, with its config written into a new launch folder. */
export function prepareOpenCodeLaunch(opts: OpenCodeShimOptions, tools: string[]): AcpLaunch & { dir: string } {
  const offered = tools.filter((t) => MAPPED.includes(t)).sort()
  const config = openCodeConfig({
    baseUrl: opts.modelBaseUrl, placeholder: opts.placeholder, model: opts.model ?? 'scripted', tools: offered, systemPrompt: opts.systemPrompt,
  })
  const dir = openCodeLaunchDir(opts.homeDir)
  const configDir = path.join(dir, 'config')
  mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  const configFile = path.join(dir, 'opencode.json')
  writeFileSync(configFile, JSON.stringify(config, null, 2))
  return {
    dir,
    command: [...opts.command, ...openCodeArgs(opts.workDir)],
    env: openCodeEnv(opts, { configFile, permission: JSON.stringify(config.permission), configDir }),
  }
}

export async function startOpenCodeShim(opts: OpenCodeShimOptions): Promise<AcpShim> {
  const promptProblem = opts.systemPrompt === undefined ? undefined : openCodeSystemPromptProblem(opts.systemPrompt)
  if (promptProblem) throw new Error(promptProblem)
  return startAcpShim({
    host: opts.host, port: opts.port, token: opts.token,
    caps: { ...OPENCODE_CAPS, ...opts.rigCaps },
    workDir: opts.workDir,
    kinds: OPENCODE_KINDS,
    expect: OPENCODE_AGENT_INFO,
    verdictTimeoutMs: opts.verdictTimeoutMs, vetoTimeoutMs: opts.vetoTimeoutMs, startMs: opts.startMs,
    onBreach: opts.onBreach,
    launch: (tools) => prepareOpenCodeLaunch(opts, tools),
  })
}
