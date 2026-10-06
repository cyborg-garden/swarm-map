import { describe, it, expect } from 'vitest'
import { generateEnvContent, generateAgentCompose } from '../agent-deploy-templates'

describe('generateEnvContent', () => {
  const base = { name: 'matilde', port: 8642, provider: 'anthropic', primaryModel: 'claude-opus-4-6' }

  it('writes a standard anthropic api key to ANTHROPIC_API_KEY', () => {
    const env = generateEnvContent({ ...base, llmKey: 'sk-ant-api-abc123' })
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-api-abc123')
    expect(env).not.toContain('ANTHROPIC_TOKEN=')
  })

  it('routes a bearer-style anthropic credential to ANTHROPIC_TOKEN', () => {
    const env = generateEnvContent({ ...base, llmKey: 'sk-ant-oat-xyz' })
    expect(env).toContain('ANTHROPIC_TOKEN=sk-ant-oat-xyz')
    expect(env).not.toContain('ANTHROPIC_API_KEY=sk-ant-oat-xyz')
  })

  it('host ollama mode points OLLAMA_BASE_URL at host.docker.internal', () => {
    const env = generateEnvContent({ name: 'x', port: 8642, provider: 'ollama', primaryModel: 'qwen3:8b' })
    expect(env).toContain('OLLAMA_BASE_URL=http://host.docker.internal:11434/v1')
  })

  it('bundled ollama mode points OLLAMA_BASE_URL at the sidecar service', () => {
    const env = generateEnvContent({ name: 'sci', port: 8642, provider: 'ollama', primaryModel: 'qwen2.5:0.5b', bundledOllama: true })
    expect(env).toContain('OLLAMA_BASE_URL=http://ollama-sci:11434/v1')
    expect(env).not.toContain('host.docker.internal:11434')
  })

  it('writes the GLM key to GLM_API_KEY for the zai provider', () => {
    const env = generateEnvContent({ name: 'matilde', port: 8642, provider: 'zai', primaryModel: 'glm-5.2', llmKey: 'glm-secret-123' })
    expect(env).toContain('GLM_API_KEY=glm-secret-123')
    // zai is Z.ai cloud (base_url baked into the runtime plugin) — no local ollama URL.
    expect(env).not.toContain('OLLAMA_BASE_URL=')
  })

  it('writes signal env when a phone is provided', () => {
    const env = generateEnvContent({ ...base, signalPhone: '+15551234567' })
    expect(env).toContain('SIGNAL_ACCOUNT=+15551234567')
    expect(env).toContain('SIGNAL_HTTP_URL=http://host.docker.internal:8080')
  })

  it('adds CAMOFOX_URL only when browser enabled', () => {
    expect(generateEnvContent({ ...base, browserEnabled: true })).toContain('CAMOFOX_URL=')
    expect(generateEnvContent({ ...base })).not.toContain('CAMOFOX_URL=')
  })

  it('writes discord env + secure policy defaults when a bot token is provided', () => {
    const env = generateEnvContent({ ...base, discordToken: 'discord.bot.token' })
    expect(env).toContain('DISCORD_BOT_TOKEN=discord.bot.token')
    expect(env).toContain('DISCORD_ALLOWED_USERS=')
    // Mention-gating defaults on (mirrors the adapter's own default).
    expect(env).toContain('DISCORD_REQUIRE_MENTION=true')
  })

  it('seeds a new discord agent fail-closed rather than unscoped', () => {
    const env = generateEnvContent({ ...base, discordToken: 'discord.bot.token' })
    // NOT an empty channel list: the adapter reads empty as "no channel gate at
    // all", so a new agent would answer in every channel the moment a user is
    // added to the allowlist. '0' can never be a snowflake, so it denies until the
    // operator scopes the agent deliberately.
    expect(env).toMatch(/^DISCORD_ALLOWED_CHANNELS=0$/m)
    expect(env).not.toMatch(/^DISCORD_ALLOWED_CHANNELS=$/m)
    // Explicit: this check runs BEFORE the human allowlist and skips it entirely
    // when it permits a bot, so it must not be left to an implicit default.
    expect(env).toMatch(/^DISCORD_ALLOW_BOTS=none$/m)
    // Org policy (2026-08-05): bot senders must carry a literal inline
    // @mention — a reply-ping alone must not trigger the agent. Inert while
    // ALLOW_BOTS=none, but opening bot access later inherits the strict posture.
    expect(env).toMatch(/^DISCORD_BOTS_REQUIRE_INLINE_MENTION=true$/m)
  })

  it('seeds mention-required in threads (2026-10-06 #bounties-work incident)', () => {
    const env = generateEnvContent({ ...base, discordToken: 'discord.bot.token' })
    // Without it the adapter default (false) lets a bot answer every message in
    // any thread it has "participated" in, mentioned or not.
    expect(env).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('does not emit the thread gate for a non-discord agent', () => {
    expect(generateEnvContent({ ...base })).not.toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=/m)
  })

  it('seeds channel-scoped access on (inert until channels are approved)', () => {
    const env = generateEnvContent({ ...base, discordToken: 'discord.bot.token' })
    // Org policy: anyone in an admin-approved channel may talk to the bot.
    // Safe as a seed: the '0' sentinel parses to no explicit channel ids and
    // '*' is never honored as a grant, so the flag grants nothing until an
    // operator approves concrete channels.
    expect(env).toMatch(/^DISCORD_CHANNEL_SCOPED_ACCESS=true$/m)
  })

  it('leaves discord vars commented out when no token is provided', () => {
    const env = generateEnvContent({ ...base })
    expect(env).toContain('# DISCORD_BOT_TOKEN=')
    expect(env).not.toMatch(/^DISCORD_BOT_TOKEN=/m)
  })

  it('writes slack env (both tokens) + secure policy defaults when both tokens provided', () => {
    const env = generateEnvContent({ ...base, slackBotToken: 'xoxb-x', slackAppToken: 'xapp-y' })
    expect(env).toContain('SLACK_BOT_TOKEN=xoxb-x')
    expect(env).toContain('SLACK_APP_TOKEN=xapp-y')
    expect(env).toContain('SLACK_ALLOWED_USERS=')
    expect(env).toContain('SLACK_ALLOWED_CHANNELS=')
    expect(env).toContain('SLACK_REQUIRE_MENTION=true')
  })

  it('writes SLACK_CHANNEL_POLICY=approved-only in the secure policy defaults', () => {
    // Secure-by-default: with the runtime contract, approved-only + empty
    // SLACK_ALLOWED_CHANNELS approves NO channels, so a fresh agent responds in
    // none until the operator approves them. Emitted unconditionally (like the
    // Signal group-invite default), independent of whether Slack tokens are set.
    const env = generateEnvContent({ ...base })
    expect(env).toContain('SLACK_CHANNEL_POLICY=approved-only')
  })

  it('leaves slack vars commented out when tokens are missing/partial', () => {
    // Only one token → not a usable Slack connection → stays commented.
    const env = generateEnvContent({ ...base, slackBotToken: 'xoxb-x' })
    expect(env).toContain('# SLACK_BOT_TOKEN=')
    expect(env).not.toMatch(/^SLACK_BOT_TOKEN=/m)
  })

  it('writes GITHUB_TOKEN and a literal GITHUB_PERSONAL_ACCESS_TOKEN when a github token is provided', () => {
    // The github MCP server reads GITHUB_PERSONAL_ACCESS_TOKEN; the compose sets
    // it via ${GITHUB_TOKEN} interpolation that resolves from process env (empty),
    // not env_file — so the token must ALSO be written as a literal PAT line.
    const env = generateEnvContent({ ...base, githubToken: 'ghp_test123' })
    expect(env).toContain('GITHUB_TOKEN=ghp_test123')
    expect(env).toContain('GITHUB_PERSONAL_ACCESS_TOKEN=ghp_test123')
    // Must be literal values, not shell interpolation placeholders.
    expect(env).not.toContain('${')
  })

  it('writes ONLY the canonical NOTION_API_KEY literal (not a duplicate NOTION_TOKEN)', () => {
    // NOTION_API_KEY is HSM's canonical var (the one the keys registry rotates/
    // revokes). The notion MCP server reads NOTION_TOKEN, but that's mapped from
    // NOTION_API_KEY in the config.yaml mcp_servers env block — single source of
    // truth. A second NOTION_TOKEN literal here would go stale on rotation.
    const env = generateEnvContent({ ...base, notionKey: 'ntn_test123' })
    expect(env).toContain('NOTION_API_KEY=ntn_test123')
    expect(env).not.toContain('NOTION_TOKEN')
    expect(env).not.toContain('${')
  })

  it('omits notion vars when no notion key is provided', () => {
    const env = generateEnvContent({ ...base })
    expect(env).not.toContain('NOTION_API_KEY')
    expect(env).not.toContain('NOTION_TOKEN')
  })

  // ── B2: Letta-brain "door" env seam ───────────────────────────────────────
  // A Hermes gateway becomes a Letta-brained door when LETTA_BRAIN_URL +
  // LETTA_BRAIN_AGENT_ID are set (B1 contract, gateway/letta_brain.py reads
  // exactly these names, plus optional LETTA_BRAIN_API_KEY).
  it('writes LETTA_BRAIN_URL + LETTA_BRAIN_AGENT_ID (and no API key line) when lettaBrain is set', () => {
    const env = generateEnvContent({
      ...base,
      lettaBrain: { url: 'http://host.docker.internal:8283', agentId: 'agent-x' },
    })
    expect(env).toMatch(/^LETTA_BRAIN_URL=http:\/\/host\.docker\.internal:8283$/m)
    expect(env).toMatch(/^LETTA_BRAIN_AGENT_ID=agent-x$/m)
    expect(env).not.toContain('LETTA_BRAIN_API_KEY')
  })

  it('writes LETTA_BRAIN_API_KEY when the brain apiKey is set', () => {
    const env = generateEnvContent({
      ...base,
      lettaBrain: { url: 'http://host.docker.internal:8283', agentId: 'agent-x', apiKey: 'sk-letta-1' },
    })
    expect(env).toMatch(/^LETTA_BRAIN_API_KEY=sk-letta-1$/m)
  })

  it('rejects a newline in the brain agentId (env-line injection guard)', () => {
    expect(() =>
      generateEnvContent({
        ...base,
        lettaBrain: { url: 'http://host.docker.internal:8283', agentId: 'agent-x\nEVIL=1' },
      }),
    ).toThrow()
  })

  it('emits no LETTA_BRAIN_* lines without lettaBrain', () => {
    const env = generateEnvContent({ ...base })
    expect(env).not.toContain('LETTA_BRAIN_')
  })
})

describe('generateAgentCompose', () => {
  const args = { slug: 'sci', port: 8642, agentDataDir: '/home/u/.hermes-sci', imageOrBuild: { image: 'ghcr.io/x:latest' } as const }

  it('omits the ollama sidecar by default', () => {
    const c = generateAgentCompose(args.slug, args.port, args.agentDataDir, args.imageOrBuild)
    expect(c).not.toContain('ollama-sci:')
    expect(c).toContain('hermes-sci:')
  })

  it('emits a healthy-gated ollama sidecar when bundledOllama is set', () => {
    const c = generateAgentCompose(args.slug, args.port, args.agentDataDir, args.imageOrBuild, { bundledOllama: true })
    expect(c).toContain('ollama-sci:')
    expect(c).toContain('image: ollama/ollama')
    expect(c).toContain('qwen2.5:0.5b')
    expect(c).toContain('/home/u/.hermes-sci/.ollama:/root/.ollama')
    // hermes waits for the sidecar
    expect(c).toMatch(/depends_on:\s*\n\s*ollama-sci:\s*\n\s*condition: service_healthy/)
  })

  it('does NOT set GITHUB_PERSONAL_ACCESS_TOKEN via a compose environment override', () => {
    // A compose `environment:` entry takes precedence over env_file, and
    // ${GITHUB_TOKEN} resolves from the (empty) process env — so this override
    // blanked the token the env_file supplies. The token now comes solely from
    // the agent .env (env_file); the compose must not re-declare it.
    const c = generateAgentCompose(args.slug, args.port, args.agentDataDir, args.imageOrBuild, { githubMcpEnabled: true })
    expect(c).not.toContain('GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_TOKEN}')
    expect(c).not.toContain('environment:')
    expect(c).toContain(`${args.agentDataDir}/.env`)
  })

  it('still mounts the google mcp volume when a dir is given', () => {
    const c = generateAgentCompose(args.slug, args.port, args.agentDataDir, args.imageOrBuild, { googleMcpDir: '/opt/gmcp' })
    expect(c).toContain('/opt/gmcp:/opt/google-multiplayer-mcp:ro')
  })

  it('mounts /run as exec so s6-overlay can boot under the read-only rootfs', () => {
    const c = generateAgentCompose(args.slug, args.port, args.agentDataDir, args.imageOrBuild)
    // We harden the container with a read-only rootfs...
    expect(c).toContain('read_only: true')
    // ...but s6-overlay execs /run/s6/basedir/bin/init. A bare `tmpfs: - /run`
    // is mounted noexec, so init fails with EACCES (exit 126) and the agent
    // restart-loops. /run must therefore be mounted exec.
    expect(c).toMatch(/-\s*\/run:exec\b/)
    expect(c).not.toMatch(/^\s*-\s*\/run\s*$/m)
  })
})
