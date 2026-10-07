import { describe, it, expect } from 'vitest'
import { generateDefaultConfig } from './config-yaml'

describe('generateDefaultConfig', () => {
  const baseParams = { provider: 'anthropic', primaryModel: 'claude-sonnet-4-5' }

  it('interpolates provider and primaryModel', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('provider: anthropic')
    expect(result).toContain('default: claude-sonnet-4-5')
  })

  it('includes fallbackModel when provided', () => {
    const result = generateDefaultConfig({ ...baseParams, fallbackModel: 'claude-haiku-3' })
    expect(result).toContain('fallback: claude-haiku-3')
    expect(result).not.toContain('# fallback: <model>')
  })

  it('omits fallbackModel line when not provided', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('# fallback: <model>')
    expect(result).not.toMatch(/^\s*fallback: \w/m)
  })

  it('contains compression section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('compression:')
    expect(result).toContain('enabled: true')
    expect(result).toContain('threshold: 0.50')
    expect(result).toContain('target_ratio: 0.20')
    expect(result).toContain('protect_last_n: 20')
    expect(result).toContain('summary_model:')
  })

  it('contains memory section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('memory:')
    expect(result).toContain('memory_enabled: true')
    expect(result).toContain('user_profile_enabled: true')
    expect(result).toContain('memory_char_limit: 5000')
    expect(result).toContain('user_char_limit: 2000')
    expect(result).toContain('nudge_interval: 10')
  })

  it('contains session_reset section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('session_reset:')
    expect(result).toContain('mode: both')
    expect(result).toContain('idle_minutes: 1440')
    expect(result).toContain('at_hour: 4')
  })

  it('defaults group_sessions_per_user to false (shared group session)', () => {
    // Override layer: Swarm Map ships a shared group session by default
    // (one session per group, sender-name prefixed). DMs stay isolated.
    // Upstream's runtime default is true; we flip it here, not in the runtime.
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('group_sessions_per_user: false')
    expect(result).not.toContain('group_sessions_per_user: true')
  })

  it('contains agent section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('agent:')
    expect(result).toContain('max_turns: 60')
    expect(result).toContain('reasoning_effort: "medium"')
  })

  it('contains stt section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('stt:')
    expect(result).toContain('model: "base"')
  })

  it('contains tts section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('tts:')
    expect(result).toContain('default_provider: "edge"')
    expect(result).toContain('voice: "en-US-AriaNeural"')
  })

  it('contains terminal section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('terminal:')
    expect(result).toContain('backend: "local"')
    expect(result).toContain('timeout: 180')
  })

  it('contains skills section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('skills:')
    expect(result).toContain('creation_nudge_interval: 15')
  })

  it('contains display section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('display:')
    expect(result).toContain('compact: false')
    expect(result).toContain('tool_progress: all')
    expect(result).toContain('streaming: true')
  })

  it('contains platform_toolsets section', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).toContain('platform_toolsets:')
    expect(result).toContain('cli: [hermes-cli]')
    expect(result).toContain('telegram: [hermes-telegram]')
    expect(result).toContain('signal: [hermes-signal]')
  })

  it('adds base_url for ollama provider', () => {
    const result = generateDefaultConfig({ provider: 'ollama', primaryModel: 'llama3' })
    expect(result).toContain('provider: custom')
    expect(result).toContain('base_url: "http://host.docker.internal:11434/v1"')
  })

  it('adds base_url for custom provider', () => {
    const result = generateDefaultConfig({ provider: 'custom', primaryModel: 'my-model' })
    expect(result).toContain('provider: custom')
    expect(result).toContain('base_url: "http://host.docker.internal:11434/v1"')
  })

  it('does not add base_url for non-ollama providers', () => {
    const result = generateDefaultConfig(baseParams)
    expect(result).not.toContain('base_url:')
  })

  it('passes the zai provider through unchanged with no base_url (plugin bakes its endpoint)', () => {
    const result = generateDefaultConfig({ provider: 'zai', primaryModel: 'glm-5.2' })
    expect(result).toContain('provider: zai')
    expect(result).toContain('default: glm-5.2')
    // The runtime zai plugin owns base_url (https://api.z.ai/...); must NOT be
    // rewritten to custom or given a localhost ollama URL.
    expect(result).not.toContain('provider: custom')
    expect(result).not.toContain('base_url:')
  })

  // --- MCP Servers ---

  it('generates config without mcp_servers when none provided', () => {
    const config = generateDefaultConfig(baseParams)
    expect(config).not.toContain('mcp_servers:')
  })

  it('generates github mcp_servers section when github is enabled', () => {
    const config = generateDefaultConfig({
      ...baseParams,
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
      },
    })
    expect(config).toContain('mcp_servers:')
    expect(config).toContain('  github:')
    expect(config).toContain('    command: npx')
    expect(config).toContain('      - "-y"')
    expect(config).toContain('      - "@modelcontextprotocol/server-github"')
    expect(config).toContain('    env:')
    expect(config).toContain('      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}"')
  })

  it('generates google mcp_servers section when google is enabled', () => {
    const config = generateDefaultConfig({
      ...baseParams,
      mcpServers: {
        google: {
          command: 'node',
          args: ['/opt/google-multiplayer-mcp/dist/index.js', '--config', '/opt/google/config.yaml'],
        },
      },
    })
    expect(config).toContain('mcp_servers:')
    expect(config).toContain('  google:')
    expect(config).toContain('    command: node')
    expect(config).toContain('      - "/opt/google-multiplayer-mcp/dist/index.js"')
    expect(config).not.toContain('/opt/google-mcp/')
  })

  it('generates both mcp_servers when both enabled', () => {
    const config = generateDefaultConfig({
      ...baseParams,
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
        google: {
          command: 'node',
          args: ['/opt/google-multiplayer-mcp/dist/index.js', '--config', '/opt/google/config.yaml'],
        },
      },
    })
    expect(config).toContain('  github:')
    expect(config).toContain('  google:')
    expect(config).toContain('      - "/opt/google-multiplayer-mcp/dist/index.js"')
    expect(config).not.toContain('/opt/google-mcp/')
  })

  it('does not include env key when server has no env vars', () => {
    const config = generateDefaultConfig({
      ...baseParams,
      mcpServers: {
        google: {
          command: 'node',
          args: ['/opt/google-multiplayer-mcp/dist/index.js', '--config', '/opt/google/config.yaml'],
        },
      },
    })
    const googleSection = config.split('google:')[1]?.split('\n\n')[0] ?? ''
    expect(googleSection).not.toContain('env:')
    expect(config).not.toContain('/opt/google-mcp/')
  })

  it('generates url-based mcp server config', () => {
    const config = generateDefaultConfig({
      ...baseParams,
      mcpServers: {
        notion: {
          url: 'https://mcp.notion.com/mcp',
        },
      },
    })
    expect(config).toContain('mcp_servers:')
    expect(config).toContain('  notion:')
    expect(config).toContain('    url: https://mcp.notion.com/mcp')
    expect(config).not.toContain('    command:')
  })

  it('derives an anthropic compression summary_model — never a foreign provider', () => {
    const result = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-6' })
    expect(result).not.toContain('gemini')
    // summary_model line must reference a valid anthropic catalog id
    const line = result.split('\n').find((l) => l.trim().startsWith('summary_model:')) ?? ''
    expect(line).toContain('anthropic/')
    expect(line).toContain('claude')
  })

  it('derives a local compression summary_model matching the declared custom provider', () => {
    // ollama is declared as provider `custom` (with base_url) in the model block,
    // so the summary must use the SAME `custom/` prefix (an `ollama/` prefix has
    // no declared provider/base_url and won't resolve), reusing the primary model.
    const result = generateDefaultConfig({ provider: 'ollama', primaryModel: 'llama3.1:8b' })
    const line = result.split('\n').find((l) => l.trim().startsWith('summary_model:')) ?? ''
    expect(line).toContain('custom/llama3.1:8b')
    expect(line).not.toContain('ollama/')
    expect(line).not.toContain('gemini')
    expect(line).not.toContain('claude')
    expect(line).not.toContain('gpt')
  })

  it('produces valid YAML structure (no syntax errors)', () => {
    const result = generateDefaultConfig(baseParams)
    // Basic structural checks: no tabs, proper indentation, all colons have values or nested blocks
    expect(result).not.toMatch(/\t/)
    // Every non-comment, non-blank line should be key: value or key: (block)
    const lines = result.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
    for (const line of lines) {
      // Each line is either a top-level key or indented key: value
      expect(line).toMatch(/^(\s*[\w_]+:\s*.*|$)/)
    }
  })
})

describe('generateDefaultConfig plugins.enabled', () => {
  it('emits a plugins.enabled block listing enabled plugins', () => {
    const out = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-5', enabledPlugins: ['swarm_map_policy', 'captcha_cascade'] })
    expect(out).toContain('plugins:')
    expect(out).toContain('enabled:')
    expect(out).toMatch(/-\s+swarm_map_policy/)
    expect(out).toMatch(/-\s+captcha_cascade/)
  })
  it('omits the plugins block when no plugins are enabled', () => {
    const out = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-5' })
    expect(out).not.toMatch(/^plugins:/m)
  })
})

describe('generateDefaultConfig platforms enablement', () => {
  const baseParams = { provider: 'anthropic', primaryModel: 'claude-sonnet-4-5' }

  it('emits platforms.<p>.enabled: true for each surface chosen at deploy time', () => {
    const out = generateDefaultConfig({ ...baseParams, enabledPlatforms: ['discord', 'telegram'] })
    expect(out).toMatch(/^platforms:$/m)
    expect(out).toContain('  discord:\n    enabled: true')
    expect(out).toContain('  telegram:\n    enabled: true')
  })

  it('omits the platforms block when no surfaces are chosen', () => {
    const out = generateDefaultConfig(baseParams)
    expect(out).not.toMatch(/^platforms:/m)
    // platform_toolsets stays regardless — it is a different key.
    expect(out).toContain('platform_toolsets:')
  })

  it('rejects unknown platform slugs (never spliced into the file)', () => {
    expect(() => generateDefaultConfig({ ...baseParams, enabledPlatforms: ['irc'] })).toThrow(/Unknown platform/)
    expect(() => generateDefaultConfig({ ...baseParams, enabledPlatforms: ['discord:\n  privileged'] })).toThrow(/Unknown platform/)
  })
})

describe('generateDefaultConfig never renders the Discord thread gate', () => {
  // platforms.discord.extra.thread_require_mention outranks .env in the adapter
  // and the top-level `discord:` block is the fallback .env already beats. The
  // policy lives in .env (DISCORD_THREAD_REQUIRE_MENTION), so the generator
  // must never write the key into config.yaml at any level.
  it('omits thread_require_mention even with Discord enabled', () => {
    const yaml = generateDefaultConfig({
      provider: 'anthropic',
      primaryModel: 'claude-opus-4-6',
      enabledPlatforms: ['discord', 'signal'],
    })
    expect(yaml).toContain('discord')
    expect(yaml).not.toContain('thread_require_mention')
  })
})

describe('generateDefaultConfig web.search_backend (base package research)', () => {
  const baseParams = { provider: 'anthropic', primaryModel: 'claude-sonnet-4-6' }
  it('defaults to brave-free', () => {
    expect(generateDefaultConfig(baseParams)).toMatch(/^  search_backend: brave-free$/m)
  })
  it('writes the no-key fallback when asked (never silently drops to firecrawl search)', () => {
    const out = generateDefaultConfig({ ...baseParams, searchBackend: 'ddgs' })
    expect(out).toMatch(/^  search_backend: ddgs$/m)
    expect(out).toMatch(/^  extract_backend: firecrawl$/m)
  })
  it('rejects a backend that would inject YAML', () => {
    expect(() => generateDefaultConfig({ ...baseParams, searchBackend: 'x\nplugins:' })).toThrow(/Invalid search backend/)
  })
  it('always writes plugins.enabled as a block list, never inline', () => {
    const out = generateDefaultConfig({ ...baseParams, enabledPlugins: ['a'] })
    expect(out).not.toMatch(/enabled:\s*\[/)
  })
})
