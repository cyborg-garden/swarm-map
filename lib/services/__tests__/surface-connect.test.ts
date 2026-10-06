import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// We test the env-merging logic directly since route handlers need Next.js runtime.
// Extract the logic into a helper and test that.
import { mergeEnvVars, buildConnectEnvVars, ensurePolicyDefaults, buildSettingsEnvValue } from '../../env-helpers'

describe('surface connect env merging', () => {
  let tmpDir: string
  let envPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-connect-'))
    envPath = path.join(tmpDir, '.env')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('preserves existing SIGNAL_ALLOWED_USERS when connecting signal surface', () => {
    // User previously set allowed users via settings
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=sk-test',
      'SIGNAL_ALLOWED_USERS=+15551234567,+15559876543',
      'SIGNAL_GROUP_ALLOWED_USERS=group1,group2',
      'SIGNAL_HTTP_URL=http://old-url:8080',
      'SIGNAL_ACCOUNT=+15550000000',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('signal', {
      url: 'http://host.docker.internal:8080',
      phone: '+15551112222',
    })

    const content = fs.readFileSync(envPath, 'utf-8')
    const result = mergeEnvVars(content, connectVars)

    // Connection vars should update
    expect(result).toContain('SIGNAL_HTTP_URL=http://host.docker.internal:8080')
    expect(result).toContain('SIGNAL_ACCOUNT=+15551112222')

    // Policy vars should be PRESERVED (not overwritten)
    expect(result).toContain('SIGNAL_ALLOWED_USERS=+15551234567,+15559876543')
    expect(result).toContain('SIGNAL_GROUP_ALLOWED_USERS=group1,group2')
  })

  it('sets empty ALLOWED_USERS for new signal connection (secure default)', () => {
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=sk-test',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('signal', {
      url: 'http://host.docker.internal:8080',
      phone: '+15551112222',
    })

    const content = fs.readFileSync(envPath, 'utf-8')
    let result = mergeEnvVars(content, connectVars)
    result = ensurePolicyDefaults(result, 'signal')

    // New connection should get empty allowed users (approved-only default)
    expect(result).toContain('SIGNAL_ALLOWED_USERS=')
    expect(result).not.toContain('SIGNAL_ALLOWED_USERS=*')
  })

  it('preserves existing TELEGRAM_ALLOWED_USERS when connecting telegram', () => {
    fs.writeFileSync(envPath, [
      'ANTHROPIC_API_KEY=sk-test',
      'TELEGRAM_BOT_TOKEN=old-token',
      'TELEGRAM_ALLOWED_USERS=12345,67890',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('telegram', {
      token: 'new-bot-token-123',
    })

    const content = fs.readFileSync(envPath, 'utf-8')
    const result = mergeEnvVars(content, connectVars)

    // Token should update
    expect(result).toContain('TELEGRAM_BOT_TOKEN=new-bot-token-123')

    // Policy should be preserved
    expect(result).toContain('TELEGRAM_ALLOWED_USERS=12345,67890')
  })

  it('preserves existing MATTERMOST policy vars when reconnecting', () => {
    fs.writeFileSync(envPath, [
      'MATTERMOST_URL=http://old.mm.local',
      'MATTERMOST_TOKEN=old-token',
      'MATTERMOST_ALLOWED_USERS=admin,user1',
      'MATTERMOST_ALLOWED_CHANNELS=general,random',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('mattermost', {
      url: 'http://new.mm.local',
      token: 'new-token',
    })

    const content = fs.readFileSync(envPath, 'utf-8')
    const result = mergeEnvVars(content, connectVars)

    expect(result).toContain('MATTERMOST_URL=http://new.mm.local')
    expect(result).toContain('MATTERMOST_TOKEN=new-token')
    expect(result).toContain('MATTERMOST_ALLOWED_USERS=admin,user1')
    expect(result).toContain('MATTERMOST_ALLOWED_CHANNELS=general,random')
  })

  it('preserves existing DISCORD policy vars when reconnecting', () => {
    fs.writeFileSync(envPath, [
      'DISCORD_BOT_TOKEN=old-token',
      'DISCORD_ALLOWED_USERS=111,222',
      'DISCORD_ALLOWED_CHANNELS=chan1,chan2',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('discord', { token: 'new-token' })

    const content = fs.readFileSync(envPath, 'utf-8')
    const result = mergeEnvVars(content, connectVars)

    // Token updates; the user/channel allowlists are preserved.
    expect(result).toContain('DISCORD_BOT_TOKEN=new-token')
    expect(result).toContain('DISCORD_ALLOWED_USERS=111,222')
    expect(result).toContain('DISCORD_ALLOWED_CHANNELS=chan1,chan2')
  })

  it('preserves existing SLACK policy vars when reconnecting (both tokens)', () => {
    fs.writeFileSync(envPath, [
      'SLACK_BOT_TOKEN=xoxb-old',
      'SLACK_APP_TOKEN=xapp-old',
      'SLACK_ALLOWED_USERS=U111,U222',
      'SLACK_ALLOWED_CHANNELS=C111,C222',
    ].join('\n'))

    const connectVars = buildConnectEnvVars('slack', { botToken: 'xoxb-new', appToken: 'xapp-new' })

    const content = fs.readFileSync(envPath, 'utf-8')
    const result = mergeEnvVars(content, connectVars)

    // Both tokens update; the user/channel allowlists are preserved.
    expect(result).toContain('SLACK_BOT_TOKEN=xoxb-new')
    expect(result).toContain('SLACK_APP_TOKEN=xapp-new')
    expect(result).toContain('SLACK_ALLOWED_USERS=U111,U222')
    expect(result).toContain('SLACK_ALLOWED_CHANNELS=C111,C222')
  })

  describe('buildConnectEnvVars', () => {
    it('only returns connection vars, not policy vars, for signal', () => {
      const vars = buildConnectEnvVars('signal', {
        url: 'http://host.docker.internal:8080',
        phone: '+15551112222',
      })

      expect(vars).toHaveProperty('SIGNAL_HTTP_URL')
      expect(vars).toHaveProperty('SIGNAL_ACCOUNT')
      expect(vars).not.toHaveProperty('SIGNAL_ALLOWED_USERS')
      expect(vars).not.toHaveProperty('SIGNAL_GROUP_ALLOWED_USERS')
    })

    it('only returns connection vars for telegram', () => {
      const vars = buildConnectEnvVars('telegram', { token: 'abc' })

      expect(vars).toHaveProperty('TELEGRAM_BOT_TOKEN')
      expect(vars).not.toHaveProperty('TELEGRAM_ALLOWED_USERS')
      expect(vars).not.toHaveProperty('TELEGRAM_GROUP_ALLOWED_CHATS')
    })

    it('only returns connection vars for mattermost', () => {
      const vars = buildConnectEnvVars('mattermost', { url: 'http://mm', token: 'tok' })

      expect(vars).toHaveProperty('MATTERMOST_URL')
      expect(vars).toHaveProperty('MATTERMOST_TOKEN')
      expect(vars).not.toHaveProperty('MATTERMOST_ALLOWED_USERS')
      expect(vars).not.toHaveProperty('MATTERMOST_ALLOWED_CHANNELS')
    })

    it('only returns the bot token for discord, not policy vars', () => {
      const vars = buildConnectEnvVars('discord', { token: 'bot.token.xyz' })

      expect(vars).toHaveProperty('DISCORD_BOT_TOKEN')
      expect(vars).not.toHaveProperty('DISCORD_ALLOWED_USERS')
      expect(vars).not.toHaveProperty('DISCORD_ALLOWED_CHANNELS')
    })

    it('returns both tokens for slack, no policy vars', () => {
      const vars = buildConnectEnvVars('slack', { botToken: 'xoxb-x', appToken: 'xapp-y' })

      expect(vars).toHaveProperty('SLACK_BOT_TOKEN', 'xoxb-x')
      expect(vars).toHaveProperty('SLACK_APP_TOKEN', 'xapp-y')
      expect(vars).not.toHaveProperty('SLACK_ALLOWED_USERS')
      expect(vars).not.toHaveProperty('SLACK_ALLOWED_CHANNELS')
    })
  })

  describe('mergeEnvVars', () => {
    it('updates existing keys', () => {
      const content = 'FOO=old\nBAR=keep\n'
      const result = mergeEnvVars(content, { FOO: 'new' })
      expect(result).toContain('FOO=new')
      expect(result).toContain('BAR=keep')
    })

    it('appends new keys', () => {
      const content = 'FOO=old\n'
      const result = mergeEnvVars(content, { BAR: 'new' })
      expect(result).toContain('FOO=old')
      expect(result).toContain('BAR=new')
    })
  })
})

describe('settings PUT defaults', () => {
  // Test that approved-only with empty user list writes empty string, not *
  it('approved-only with no users should write empty string, not wildcard', () => {
    // approved-only + empty user list = empty string (no one allowed until explicitly added)
    expect(buildSettingsEnvValue('approved-only', false, [])).toBe('')

    // approved-only with specific users = comma-joined
    expect(buildSettingsEnvValue('approved-only', false, ['user1', 'user2'])).toBe('user1,user2')

    // per-surface allowAll override
    expect(buildSettingsEnvValue('approved-only', true, [])).toBe('*')
  })

  it('does NOT derive a wildcard from the DM policy', () => {
    // Previously `allow-all` + an empty list produced '*'. These vars are the
    // general user allowlist — DISCORD_ALLOWED_USERS gates guild messages, slash
    // commands and buttons, not just DMs — so a toggle the UI labels "DM Access
    // Policy" silently granted every member of a Discord server command access
    // to the agent. Only the explicit per-surface allowAll opts into a wildcard.
    expect(buildSettingsEnvValue('allow-all', false, [])).toBe('')
    expect(buildSettingsEnvValue('allow-all', true, [])).toBe('*')
    expect(buildSettingsEnvValue('allow-all', false, ['user1'])).toBe('user1')
  })
})

describe('ensurePolicyDefaults — Discord deny sentinel (drift D1)', () => {
  it('seeds DISCORD_ALLOWED_CHANNELS=0, never empty (empty = no channel gate)', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_BOT_TOKEN=tok\n', 'discord')
    expect(out).toMatch(/^DISCORD_ALLOWED_CHANNELS=0$/m)
    expect(out).not.toMatch(/^DISCORD_ALLOWED_CHANNELS=$/m)
    // Users still seeds empty (empty users = nobody, genuinely secure).
    expect(out).toMatch(/^DISCORD_ALLOWED_USERS=$/m)
  })

  it('never overwrites an existing channel list', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_ALLOWED_CHANNELS=555\n', 'discord')
    expect(out).toMatch(/^DISCORD_ALLOWED_CHANNELS=555$/m)
  })

  it('seeds DISCORD_BOTS_REQUIRE_INLINE_MENTION=true (org default, parity with deploy template)', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_BOT_TOKEN=tok\n', 'discord')
    expect(out).toMatch(/^DISCORD_BOTS_REQUIRE_INLINE_MENTION=true$/m)
  })

  it('never overwrites an existing DISCORD_BOTS_REQUIRE_INLINE_MENTION value', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_BOTS_REQUIRE_INLINE_MENTION=false\n', 'discord')
    expect(out).toMatch(/^DISCORD_BOTS_REQUIRE_INLINE_MENTION=false$/m)
    expect(out).not.toMatch(/^DISCORD_BOTS_REQUIRE_INLINE_MENTION=true$/m)
  })

  it('does not seed the inline-mention gate on non-discord platforms', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('SIGNAL_ACCOUNT=+1555\n', 'signal')
    expect(out).not.toContain('DISCORD_BOTS_REQUIRE_INLINE_MENTION')
  })
})

describe('ensurePolicyDefaults — Discord thread mention gate (2026-10-06)', () => {
  it('seeds DISCORD_THREAD_REQUIRE_MENTION=true (mention required in threads too)', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_BOT_TOKEN=tok\n', 'discord')
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('seeds DISCORD_REQUIRE_MENTION=true, never empty (empty reads as false at runtime)', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_BOT_TOKEN=tok\n', 'discord')
    expect(out).toMatch(/^DISCORD_REQUIRE_MENTION=true$/m)
    expect(out).not.toMatch(/^DISCORD_REQUIRE_MENTION=$/m)
  })

  it('seeds every surface\'s REQUIRE_MENTION as true, matching the deploy template', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    for (const [platform, v] of [
      ['signal', 'SIGNAL_REQUIRE_MENTION'],
      ['telegram', 'TELEGRAM_REQUIRE_MENTION'],
      ['mattermost', 'MATTERMOST_REQUIRE_MENTION'],
      ['slack', 'SLACK_REQUIRE_MENTION'],
    ] as const) {
      expect(ensurePolicyDefaults('', platform)).toMatch(new RegExp(`^${v}=true$`, 'm'))
    }
  })

  it('never overwrites an explicit thread gate value (deliberate opt-out)', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const out = ensurePolicyDefaults('DISCORD_THREAD_REQUIRE_MENTION=false\nDISCORD_REQUIRE_MENTION=false\n', 'discord')
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=false$/m)
    expect(out).toMatch(/^DISCORD_REQUIRE_MENTION=false$/m)
    expect(out).not.toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('does not seed the thread gate on non-discord platforms', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    expect(ensurePolicyDefaults('SIGNAL_ACCOUNT=+1555\n', 'signal')).not.toContain('DISCORD_THREAD_REQUIRE_MENTION')
  })
})

describe('Discord seed parity — deploy template vs connect (the D1 lesson)', () => {
  it('both creation paths seed the same value for every Discord posture var', async () => {
    const { ensurePolicyDefaults } = await import('@/lib/env-helpers')
    const { generateEnvContent } = await import('@/lib/services/agent-deploy-templates')
    const deploy = generateEnvContent({
      name: 'parity', port: 8642, provider: 'anthropic', primaryModel: 'claude-opus-4-6', discordToken: 'tok',
    })
    const connect = ensurePolicyDefaults('DISCORD_BOT_TOKEN=tok\n', 'discord')
    const val = (env: string, k: string) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]
    for (const k of [
      'DISCORD_ALLOWED_CHANNELS',
      'DISCORD_REQUIRE_MENTION',
      'DISCORD_THREAD_REQUIRE_MENTION',
      'DISCORD_BOTS_REQUIRE_INLINE_MENTION',
    ]) {
      expect(val(deploy, k), `deploy ${k}`).toBeDefined()
      expect(val(connect, k), `connect ${k}`).toBe(val(deploy, k))
    }
    expect(val(connect, 'DISCORD_THREAD_REQUIRE_MENTION')).toBe('true')
  })
})

describe('buildConnectEnvVars parity with the replaced switch', () => {
  it('signal: url default applied when config.url is falsy', () => {
    expect(buildConnectEnvVars('signal', { phone: '+15551112222' })).toEqual({
      SIGNAL_ACCOUNT: '+15551112222',
      SIGNAL_HTTP_URL: 'http://host.docker.internal:8080',
    })
  })

  it('signal: profileName written only when truthy', () => {
    expect(
      buildConnectEnvVars('signal', { phone: '+1', url: 'http://x:1', profileName: 'Iris' }),
    ).toEqual({
      SIGNAL_ACCOUNT: '+1',
      SIGNAL_HTTP_URL: 'http://x:1',
      SIGNAL_PROFILE_NAME: 'Iris',
    })
    expect(
      buildConnectEnvVars('signal', { phone: '+1', url: 'http://x:1', profileName: '' }),
    ).not.toHaveProperty('SIGNAL_PROFILE_NAME')
  })

  it('telegram / mattermost / discord / slack map exactly their credential vars', () => {
    expect(buildConnectEnvVars('telegram', { token: 't1' })).toEqual({ TELEGRAM_BOT_TOKEN: 't1' })
    expect(buildConnectEnvVars('mattermost', { url: 'http://mm', token: 't2' })).toEqual({
      MATTERMOST_URL: 'http://mm',
      MATTERMOST_TOKEN: 't2',
    })
    expect(buildConnectEnvVars('discord', { token: 't3' })).toEqual({ DISCORD_BOT_TOKEN: 't3' })
    expect(buildConnectEnvVars('slack', { botToken: 'xoxb-1', appToken: 'xapp-1' })).toEqual({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_APP_TOKEN: 'xapp-1',
    })
  })

  it('extra config keys are ignored; unknown platform returns {}', () => {
    expect(buildConnectEnvVars('discord', { token: 't', url: 'http://x', junk: 'y' })).toEqual({
      DISCORD_BOT_TOKEN: 't',
    })
    expect(buildConnectEnvVars('whatsapp', { token: 't' })).toEqual({})
  })

  it('missing non-optional credentials stay present-with-undefined (route empty-check unchanged)', () => {
    // A future `if (!value) continue` applied to non-optional entries would
    // silently flip the connect route's Object.keys().length check.
    const vars = buildConnectEnvVars('telegram', {})
    expect(Object.keys(vars)).toEqual(['TELEGRAM_BOT_TOKEN'])
    expect(vars.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })
})
