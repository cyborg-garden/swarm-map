// @vitest-environment node
//
// What the Claude Agent SDK is started with. Its environment is listed by
// hand: four of its lines are the only thing that tells a real one to stay
// off the network when it starts, and two say where its model is and what it
// presents there. Its options are the other half: they fix which tools a
// session has, make it ask about every one of them, and switch off every way
// it could pick up a tool, a hook, an instruction or a login from disk.
// Nothing else in the lab would notice one going missing, so they are pinned here.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_SDK_TOOL_MAP } from '../caps.ts'
import { CLAUDE_SDK_NAMED_ENV, claudeSdkEnv, claudeSdkOptions, SYSTEM_PROMPT } from '../shim.ts'

const base = { homeDir: '/cell/home', modelBaseUrl: 'http://127.0.0.1:4010/v1', placeholder: 'PLACEHOLDER-test' }
const OFFLINE = { DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }

describe('the environment the shim gives the SDK', () => {
  it('[U:claude-sdk-env] tells it to stay offline: no update check, no telemetry, no error reports, no call that is not a model call', () => {
    expect(claudeSdkEnv(base)).toMatchObject(OFFLINE)
  })

  it('[U:claude-sdk-env] points it at the model route and gives it the placeholder, and the route is named without the /v1 the SDK adds itself', () => {
    expect(claudeSdkEnv(base)).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010', ANTHROPIC_API_KEY: 'PLACEHOLDER-test' })
    expect(claudeSdkEnv({ ...base, modelBaseUrl: 'http://door:7002/v1/' }).ANTHROPIC_BASE_URL).toBe('http://door:7002')
    // The two names the lab's credential guard is told to expect are exactly these two.
    expect(CLAUDE_SDK_NAMED_ENV).toEqual({ ANTHROPIC_API_KEY: 'placeholder', ANTHROPIC_BASE_URL: 'route' })
  })

  it('[U:claude-sdk-env] extra rig variables cannot switch the offline flags off, or change where its model is, what it presents, or where its settings live', () => {
    const env = claudeSdkEnv({ ...base, rigEnv: {
      DISABLE_AUTOUPDATER: '0', DISABLE_TELEMETRY: '0', DISABLE_ERROR_REPORTING: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
      ANTHROPIC_BASE_URL: 'https://elsewhere.example', ANTHROPIC_API_KEY: 'a-real-key', CLAUDE_CONFIG_DIR: '/host/.claude', EXTRA: 'kept',
    } })
    expect(env).toMatchObject({ ...OFFLINE, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010', ANTHROPIC_API_KEY: 'PLACEHOLDER-test', CLAUDE_CONFIG_DIR: '/cell/home/claude', EXTRA: 'kept' })
  })

  it('[U:claude-sdk-env] is listed by hand: exactly these names, and nothing from the process that starts it', () => {
    process.env.CLAUDE_SDK_ENV_TEST_CANARY = 'from-the-host'
    process.env.ANTHROPIC_AUTH_TOKEN_TEST_CANARY = 'from-the-host'
    try {
      expect(Object.keys(claudeSdkEnv(base)).sort()).toEqual([
        'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_TELEMETRY', 'HOME', 'PATH',
      ])
    } finally {
      delete process.env.CLAUDE_SDK_ENV_TEST_CANARY
      delete process.env.ANTHROPIC_AUTH_TOKEN_TEST_CANARY
    }
  })

  it('[U:claude-sdk-env] HOME, PATH and its settings folder are the cell\'s own, never the host\'s', () => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
    process.env.HOME = '/Users/host-person'
    process.env.PATH = '/host/only/bin:/usr/bin'
    try {
      const env = claudeSdkEnv(base)
      expect(env.HOME).toBe('/cell/home')
      expect(env.CLAUDE_CONFIG_DIR).toBe('/cell/home/claude')
      expect(env.PATH).toBe([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'))
    } finally {
      process.env.HOME = saved.HOME
      process.env.PATH = saved.PATH
    }
  })
})

describe('the options the shim starts a session with', () => {
  const start = (tools: string[], resume?: string) => claudeSdkOptions({ tools, model: 'scripted', cwd: '/cell/work', env: claudeSdkEnv(base), resume })

  it('[U:claude-sdk-options] a session has exactly the tools it was offered, and with none offered it has none', () => {
    expect(start([]).tools).toEqual([])
    expect(start(['Bash']).tools).toEqual(['Bash'])
    expect(start(['Read', 'Bash', 'Read']).tools).toEqual(['Bash', 'Read'])
    // Never the SDK's own full set, and never a tool approved ahead of time.
    for (const tools of [[], ['Bash'], Object.keys(CLAUDE_SDK_TOOL_MAP)]) {
      expect(Array.isArray(start(tools).tools)).toBe(true)
      expect(start(tools).allowedTools).toEqual([])
    }
  })

  it('[U:claude-sdk-options] it is told to ask about every tool it has, by name, and is never started in a mode that asks nobody', () => {
    expect(start(['Read', 'Bash']).settings).toEqual({ permissions: { ask: ['Bash', 'Read'] } })
    expect(start([]).settings).toEqual({ permissions: { ask: [] } })
    for (const tools of [[], ['Bash'], Object.keys(CLAUDE_SDK_TOOL_MAP)]) {
      const options = start(tools)
      expect(options.permissionMode).toBe('default')
      expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
      expect(options.settings?.permissions?.ask).toEqual(options.tools)
    }
  })

  it('[U:claude-sdk-options] nothing is read from disk: minimal mode, no settings file, no MCP server, no skill, no plugin, and no command of its own', () => {
    const options = start(['Bash'])
    expect(options.extraArgs).toEqual({ bare: null, 'disable-slash-commands': null })
    expect(options.settingSources).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.strictMcpConfig).toBe(true)
    expect(options.skills).toEqual([])
    expect(options.plugins).toEqual([])
    expect(options).not.toHaveProperty('continue')
  })

  it('[U:claude-sdk-options] it gets the hand-listed environment and the cell\'s work folder, and is told it is in a chat room', () => {
    const options = start([])
    expect(options.env).toEqual(claudeSdkEnv(base))
    expect(options.cwd).toBe('/cell/work')
    expect(options.model).toBe('scripted')
    expect(options.systemPrompt).toBe(SYSTEM_PROMPT)
    expect(SYSTEM_PROMPT).toContain('not an instruction from the platform')
  })

  it('[U:claude-sdk-options] a session is picked back up by its own id, or not at all', () => {
    expect(start(['Bash'])).not.toHaveProperty('resume')
    expect(start(['Bash'], 'session-7').resume).toBe('session-7')
  })
})
