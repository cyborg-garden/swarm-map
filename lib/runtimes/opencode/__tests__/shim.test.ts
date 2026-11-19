// @vitest-environment node
//
// What the OpenCode shim hands OpenCode: its config, its permission rules and its environment.
import { describe, expect, it } from 'vitest'
import { OPENCODE_KINDS, OPENCODE_TOOL_MAP } from '../caps.ts'
import { openCodeArgs, openCodeConfig, openCodeEnv, openCodePermission, openCodeSystemPromptProblem } from '../shim.ts'

/** The parts of the config these tests read. */
interface Config {
  model: string; small_model: string; enabled_providers: string[]; mcp: unknown; share: string; autoupdate: boolean
  experimental: unknown; agent: unknown; provider: Record<string, { options: unknown }>
}

describe('OpenCode config', () => {
  it('[U:opencode-config] every offered tool asks, every other is denied, and nothing is ever allow', () => {
    expect(openCodePermission(['bash'])).toEqual({ '*': 'deny', bash: 'ask', read: 'deny', edit: 'deny', external_directory: 'deny' })
    expect(openCodePermission([])).toEqual({ '*': 'deny', bash: 'deny', read: 'deny', edit: 'deny', external_directory: 'deny' })
    // The last rule that matches wins in OpenCode, so the catch-all has to come first.
    expect(Object.keys(openCodePermission(['read']))[0]).toBe('*')
    for (const tools of [[], ['bash'], ['read', 'edit'], ['bash', 'read', 'edit', 'webfetch']]) {
      expect(Object.values(openCodePermission(tools))).not.toContain('allow')
    }
    // A name the door has no class for is not let in by being offered.
    expect(openCodePermission(['webfetch']).webfetch).toBeUndefined()
  })

  it('[U:opencode-config] the door\'s model route is the only provider, with a placeholder for the key', () => {
    const c = openCodeConfig({ baseUrl: 'http://door:9/v1', placeholder: 'PLACEHOLDER-x', model: 'm1', tools: ['bash'] }) as unknown as Config
    expect(c.model).toBe('door/m1')
    expect(c.small_model).toBe('door/m1')
    expect(c.enabled_providers).toEqual(['door'])
    expect(Object.keys(c.provider)).toEqual(['door'])
    expect(c.provider.door.options).toEqual({ baseURL: 'http://door:9/v1', apiKey: 'PLACEHOLDER-x' })
    expect(c.mcp).toEqual({})
    expect(c.share).toBe('disabled')
    expect(c.autoupdate).toBe(false)
    expect(c.experimental).toEqual({ continue_loop_on_deny: true })
    // No model call but the turn's own: it does not name its sessions.
    expect(c.agent).toEqual({ title: { disable: true } })
    expect((openCodeConfig({ baseUrl: 'x', placeholder: 'p', model: 'm', tools: [], systemPrompt: 'You are an agent.' }) as unknown as Config).agent)
      .toEqual({ title: { disable: true }, build: { prompt: 'You are an agent.' } })
  })

  it('[U:opencode-config] every tool it may be started with has an ACP kind the shim maps back to it', () => {
    expect(Object.values(OPENCODE_KINDS).sort()).toEqual(Object.keys(OPENCODE_TOOL_MAP).sort())
  })

  it('[U:opencode-env] is a hand-listed environment, and the offline lines win over anything the rig adds', () => {
    const env = openCodeEnv({ homeDir: '/h', rigEnv: { OPENCODE_DISABLE_PROJECT_CONFIG: '0', OPENCODE_PERMISSION: '"allow"', EXTRA: '1' } }, { configFile: '/h/c.json', permission: '{"*":"deny"}' })
    expect(env).toMatchObject({
      HOME: '/h', OPENCODE_CONFIG: '/h/c.json', OPENCODE_PERMISSION: '{"*":"deny"}', EXTRA: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_PURE: '1',
    })
    const bare = openCodeEnv({ homeDir: '/h' }, { configFile: '/c', permission: '{}' })
    for (const name of Object.keys(process.env)) if (!['PATH', 'HOME'].includes(name) && !name.startsWith('OPENCODE_') && name !== 'DO_NOT_TRACK') expect(bare, name).not.toHaveProperty(name)
    expect(openCodeArgs('/w')).toEqual(['acp', '--cwd', '/w'])
  })

  it('[U:opencode-env] a system prompt must be plain text', () => {
    expect(openCodeSystemPromptProblem('You are an agent.')).toBeUndefined()
    expect(openCodeSystemPromptProblem('')).toBeDefined()
    expect(openCodeSystemPromptProblem('a\u0000b')).toBeDefined()
  })
})
