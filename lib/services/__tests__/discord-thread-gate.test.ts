// Discord thread mention gate (2026-10-06 #bounties-work incident).
//
// Two bots answered un-mentioned messages inside a thread because
// DISCORD_THREAD_REQUIRE_MENTION was absent from their .env and the adapter
// default is "false" (once a bot has "participated" in a thread it answers
// everything there). swarm-map had no knob for the var at all. These tests pin:
//   - the .env heal (adds `true` when absent/empty, never overrides a value),
//   - the effective-gate resolver, which mirrors the adapter's precedence
//     (platforms.discord.extra > .env > top-level yaml `discord:` > default),
//   - the fleet heal + the read-only posture report.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  DISCORD_THREAD_GATE_VAR,
  ensureDiscordThreadGate,
  effectiveDiscordThreadGate,
  readYamlScalar,
  healDiscordThreadGates,
  discordThreadPosture,
} from '../discord-thread-gate'

const DISCORD_ENV = 'DISCORD_BOT_TOKEN=tok\nDISCORD_REQUIRE_MENTION=true\n'

describe('ensureDiscordThreadGate (.env heal)', () => {
  it('uses the registry var name', () => {
    expect(DISCORD_THREAD_GATE_VAR).toBe('DISCORD_THREAD_REQUIRE_MENTION')
  })

  it('adds DISCORD_THREAD_REQUIRE_MENTION=true to a Discord agent that lacks it', () => {
    const out = ensureDiscordThreadGate(DISCORD_ENV)
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    // Everything else is preserved verbatim.
    expect(out.startsWith(DISCORD_ENV.trimEnd())).toBe(true)
  })

  it('never overrides an explicit false (a deliberate opt-out)', () => {
    const env = DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=false\n'
    expect(ensureDiscordThreadGate(env)).toBe(env)
  })

  it('never overrides an explicit true', () => {
    const env = DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=true\n'
    expect(ensureDiscordThreadGate(env)).toBe(env)
  })

  it('heals an EMPTY value — the adapter reads "" as false when yaml is silent', () => {
    const out = ensureDiscordThreadGate(DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=\n')
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    expect(out.match(/DISCORD_THREAD_REQUIRE_MENTION/g)).toHaveLength(1)
  })

  it('heals an empty CRLF value too', () => {
    const out = ensureDiscordThreadGate('DISCORD_BOT_TOKEN=tok\r\nDISCORD_THREAD_REQUIRE_MENTION=\r\n')
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true/m)
  })

  it('leaves an agent without a Discord token alone', () => {
    const env = 'SIGNAL_ACCOUNT=+1555\n'
    expect(ensureDiscordThreadGate(env)).toBe(env)
  })

  it('treats a commented-out or empty token as no Discord surface', () => {
    for (const env of ['# DISCORD_BOT_TOKEN=\n', 'DISCORD_BOT_TOKEN=\n']) {
      expect(ensureDiscordThreadGate(env)).toBe(env)
    }
  })

  it('a commented-out gate line does not count as present', () => {
    const out = ensureDiscordThreadGate(DISCORD_ENV + '# DISCORD_THREAD_REQUIRE_MENTION=false\n')
    expect(out).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
  })

  it('is idempotent', () => {
    const once = ensureDiscordThreadGate(DISCORD_ENV)
    expect(ensureDiscordThreadGate(once)).toBe(once)
  })
})

describe('readYamlScalar', () => {
  // Real fleet shape: a NESTED `  platforms:` block sits under another section
  // before the real top-level one (the nested-platforms trap). The reader must
  // only match keys at the exact path, never a same-named key elsewhere.
  const yaml = [
    'display:',
    '  platforms:',
    '    discord:',
    '      extra:',
    '        thread_require_mention: false',
    'discord:',
    '  require_mention: true',
    "  free_response_channels: ''",
    '  thread_require_mention: false  # legacy',
    '  auto_thread: true',
    'platforms:',
    '  api_server:',
    '    extra:',
    '      port: 8642',
    '  discord:',
    '    enabled: true',
    '    extra:',
    '      require_admin_for_exec_approval: true',
    "      thread_require_mention: 'yes'",
    '',
  ].join('\n')

  it('reads a top-level block child and strips an inline comment', () => {
    expect(readYamlScalar(yaml, ['discord', 'thread_require_mention'])).toEqual({ found: true, value: false })
  })

  it('reads the real top-level platforms.discord.extra, not the nested one', () => {
    expect(readYamlScalar(yaml, ['platforms', 'discord', 'extra', 'thread_require_mention']))
      .toEqual({ found: true, value: 'yes' })
  })

  it('ignores a nested same-named block that comes AFTER the real one', () => {
    const y = [
      'platforms:',
      '  discord:',
      '    extra:',
      '      thread_require_mention: true',
      'streaming:',
      '  platforms:',
      '    discord:',
      '      extra:',
      '        thread_require_mention: false',
      '',
    ].join('\n')
    expect(readYamlScalar(y, ['platforms', 'discord', 'extra', 'thread_require_mention']))
      .toEqual({ found: true, value: true })
  })

  it('reports absent keys as not found', () => {
    expect(readYamlScalar(yaml, ['discord', 'nope']).found).toBe(false)
    expect(readYamlScalar('model:\n  x: 1\n', ['discord', 'thread_require_mention']).found).toBe(false)
  })

  it('types YAML 1.1 scalars the way PyYAML does', () => {
    const y = 'a:\n  t: yes\n  f: Off\n  n: ~\n  z: 0\n  s: "false"\n'
    expect(readYamlScalar(y, ['a', 't']).value).toBe(true)
    expect(readYamlScalar(y, ['a', 'f']).value).toBe(false)
    expect(readYamlScalar(y, ['a', 'n']).value).toBe(null)
    expect(readYamlScalar(y, ['a', 'z']).value).toBe(0)
    expect(readYamlScalar(y, ['a', 's']).value).toBe('false')
  })
})

describe('effectiveDiscordThreadGate — mirrors the adapter precedence', () => {
  const env = (v?: string) => 'DISCORD_BOT_TOKEN=tok\n' + (v === undefined ? '' : `DISCORD_THREAD_REQUIRE_MENTION=${v}\n`)
  const yamlTop = (v: string) => `discord:\n  thread_require_mention: ${v}\n`
  const yamlExtra = (v: string) => `platforms:\n  discord:\n    enabled: true\n    extra:\n      thread_require_mention: ${v}\n`

  it('nothing set → the adapter default (false on today\'s adapter)', () => {
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: '' }))
      .toEqual({ requireMention: false, source: 'adapter-default' })
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: '', adapterDefault: true }).requireMention).toBe(true)
  })

  it('.env beats the top-level yaml discord: block (nimbleco: yaml false, env true)', () => {
    expect(effectiveDiscordThreadGate({ env: env('true'), configYaml: yamlTop('false') }))
      .toEqual({ requireMention: true, source: 'env' })
  })

  it('yaml discord: applies when .env is silent (the 2026-10-06 nimbleco shape)', () => {
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: yamlTop('false') }))
      .toEqual({ requireMention: false, source: 'yaml discord:' })
  })

  it('an EMPTY .env value falls through to yaml, and with no yaml reads false — not the default', () => {
    expect(effectiveDiscordThreadGate({ env: env(''), configYaml: yamlTop('true') }).requireMention).toBe(true)
    expect(effectiveDiscordThreadGate({ env: env(''), configYaml: '', adapterDefault: true }))
      .toEqual({ requireMention: false, source: 'env-empty' })
  })

  it('platforms.discord.extra beats .env', () => {
    expect(effectiveDiscordThreadGate({ env: env('true'), configYaml: yamlExtra('false') }))
      .toEqual({ requireMention: false, source: 'platforms.discord.extra' })
  })

  it('extra: any string except a falsy word is true; .env: only a truthy word is true', () => {
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: yamlExtra("'maybe'") }).requireMention).toBe(true)
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: yamlExtra("'off'") }).requireMention).toBe(false)
    expect(effectiveDiscordThreadGate({ env: env('maybe'), configYaml: '' }).requireMention).toBe(false)
    expect(effectiveDiscordThreadGate({ env: env('ON'), configYaml: '' }).requireMention).toBe(true)
  })

  it('a null yaml value reads false (python str(None) is "none")', () => {
    expect(effectiveDiscordThreadGate({ env: env(), configYaml: yamlTop('~') }).requireMention).toBe(false)
  })
})

describe('fleet heal + posture report', () => {
  let root: string
  const mk = (name: string, env: string, yaml?: string) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), env)
    if (yaml !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), yaml)
    return { name, dataDir: dir }
  }
  const readEnv = (t: { dataDir: string }) => fs.readFileSync(path.join(t.dataDir, '.env'), 'utf-8')

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-gate-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('heal writes only the Discord agents that lack the key, and skips opt-outs', () => {
    const lacking = mk('nimbleco', DISCORD_ENV, 'discord:\n  thread_require_mention: false\n')
    const explicit = mk('cyborg', DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=false\n')
    const optedOut = mk('blackhouse', DISCORD_ENV)
    const noDiscord = mk('signal-only', 'SIGNAL_ACCOUNT=+1\n')
    const missing = { name: 'ghost', dataDir: path.join(root, 'ghost') }

    const before = { explicit: readEnv(explicit), optedOut: readEnv(optedOut), noDiscord: readEnv(noDiscord) }
    const res = healDiscordThreadGates([lacking, explicit, optedOut, noDiscord, missing], ['blackhouse'])

    expect(res.healed).toEqual(['nimbleco'])
    expect(res.failed).toEqual([])
    expect(readEnv(lacking)).toMatch(/^DISCORD_THREAD_REQUIRE_MENTION=true$/m)
    expect(readEnv(explicit)).toBe(before.explicit)
    expect(readEnv(optedOut)).toBe(before.optedOut)
    expect(readEnv(noDiscord)).toBe(before.noDiscord)
    // The yaml is never touched — .env is the only thing the heal writes.
    expect(fs.readFileSync(path.join(lacking.dataDir, 'config.yaml'), 'utf-8'))
      .toBe('discord:\n  thread_require_mention: false\n')
  })

  it('heal preserves the .env file mode', () => {
    const t = mk('iris', DISCORD_ENV)
    fs.chmodSync(path.join(t.dataDir, '.env'), 0o600)
    healDiscordThreadGates([t], [])
    expect(fs.statSync(path.join(t.dataDir, '.env')).mode & 0o777).toBe(0o600)
  })

  it('posture flags an open thread gate unless the agent is opted out, and never writes', () => {
    const open = mk('nimbleco', DISCORD_ENV, 'discord:\n  thread_require_mention: false\n')
    const closed = mk('cyborg', DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=true\n')
    const optedOut = mk('blackhouse', DISCORD_ENV + 'DISCORD_FREE_RESPONSE_CHANNELS=1542418448368271420\n',
      'discord:\n  thread_require_mention: false\n')
    const noDiscord = mk('signal-only', 'SIGNAL_ACCOUNT=+1\n')
    const extraOverride = mk('iris', DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=true\n',
      'platforms:\n  discord:\n    extra:\n      thread_require_mention: false\n')

    const snapshot = () => [open, closed, optedOut, noDiscord, extraOverride].map(readEnv)
    const before = snapshot()
    const report = discordThreadPosture([open, closed, optedOut, noDiscord, extraOverride], ['blackhouse'])
    expect(snapshot()).toEqual(before)

    const byName = Object.fromEntries(report.agents.map((a) => [a.name, a]))
    expect(byName.nimbleco).toMatchObject({ status: 'open', requireMention: false, source: 'yaml discord:' })
    expect(byName.cyborg).toMatchObject({ status: 'ok', requireMention: true, source: 'env' })
    expect(byName.blackhouse).toMatchObject({
      status: 'opted-out', requireMention: false, freeResponseChannels: ['1542418448368271420'],
    })
    expect(byName['signal-only']).toMatchObject({ status: 'no-discord' })
    // The one layer that outranks .env — a heal can't fix this, so it must be visible.
    expect(byName.iris).toMatchObject({ status: 'open', source: 'platforms.discord.extra' })
    expect(report.open.sort()).toEqual(['iris', 'nimbleco'])
    expect(report.ok).toBe(false)
  })

  it('posture is ok when every Discord agent is gated or opted out', () => {
    const a = mk('cyborg', DISCORD_ENV + 'DISCORD_THREAD_REQUIRE_MENTION=true\n')
    const report = discordThreadPosture([a], [])
    expect(report.ok).toBe(true)
    expect(report.open).toEqual([])
  })
})
