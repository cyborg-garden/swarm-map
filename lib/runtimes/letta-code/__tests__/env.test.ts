// @vitest-environment node
//
// What Letta Code is started with. Its environment is listed by hand, and
// three of its lines are the only thing that tells a real Letta Code to stay
// off the network at start-up. Its flags are the other half: one puts it in
// the permission mode where it asks before every tool, and the rest switch
// off ways for it to pick up tools or instructions the door never saw.
// Nothing else in the lab would notice one going missing, so they are pinned here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lettaCodeArgs, lettaCodeEnv, lettaCodeProviderFile, writeLettaCodeProvider } from '../shim.ts'

const base = { homeDir: '/cell/home' }

describe('the environment the shim gives Letta Code', () => {
  it('[U:letta-code-env] tells it to stay offline: no update check, no telemetry', () => {
    expect(lettaCodeEnv(base)).toMatchObject({ DISABLE_AUTOUPDATER: '1', LETTA_CODE_TELEM: '0', DO_NOT_TRACK: '1' })
  })

  it('[U:letta-code-env] extra rig variables cannot switch those off', () => {
    const env = lettaCodeEnv({ ...base, rigEnv: { DISABLE_AUTOUPDATER: '0', LETTA_CODE_TELEM: '1', DO_NOT_TRACK: '0', EXTRA: 'kept' } })
    expect(env).toMatchObject({ DISABLE_AUTOUPDATER: '1', LETTA_CODE_TELEM: '0', DO_NOT_TRACK: '1', EXTRA: 'kept' })
  })

  it('[U:letta-code-env] is listed by hand: exactly these names, and nothing from the process that starts it', () => {
    process.env.LETTA_CODE_ENV_TEST_CANARY = 'from-the-host'
    try {
      expect(Object.keys(lettaCodeEnv(base)).sort()).toEqual(['DISABLE_AUTOUPDATER', 'DO_NOT_TRACK', 'HOME', 'LETTA_CODE_TELEM', 'PATH'])
    } finally {
      delete process.env.LETTA_CODE_ENV_TEST_CANARY
    }
  })

  it('[U:letta-code-env] HOME and PATH are the cell\'s own, never the host\'s', () => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
    process.env.HOME = '/Users/host-person'
    process.env.PATH = '/host/only/bin:/usr/bin'
    try {
      const env = lettaCodeEnv(base)
      expect(env.HOME).toBe('/cell/home')
      expect(env.PATH).toBe([path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'))
    } finally {
      process.env.HOME = saved.HOME
      process.env.PATH = saved.PATH
    }
  })

  it('[U:letta-code-env] its provider file points at the model route and holds the placeholder, nothing else', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-lc-provider-'))
    try {
      writeLettaCodeProvider(home, { baseUrl: 'http://127.0.0.1:1/v1', placeholder: 'PLACEHOLDER-test' })
      expect(path.relative(home, lettaCodeProviderFile(home))).toBe(path.join('.letta', 'lc-local-backend', 'providers', 'auth.json'))
      const file = JSON.parse(readFileSync(lettaCodeProviderFile(home), 'utf8'))
      expect(Object.keys(file.providers)).toEqual(['openai-compatible'])
      expect(file.providers['openai-compatible']).toMatchObject({
        provider_type: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', auth: { type: 'api', key: 'PLACEHOLDER-test' },
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the flags the shim gives Letta Code', () => {
  const rest = [
    '--model', 'openai-compatible/scripted', '--permission-mode', 'strict', '--toolset', 'default',
  ]
  const tail = ['--reflection-trigger', 'off', '--no-system-info-reminder', '--no-skills', '--no-bundled-skills', '--no-mods']
  const head = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--backend', 'local']

  it('[U:letta-code-args] the first session makes the agent: exactly these flags, in this order', () => {
    expect(lettaCodeArgs({ tools: ['Bash', 'Read'], model: 'scripted' })).toEqual([...head, '--new-agent', ...rest, '--tools', 'Bash,Read', ...tail])
  })

  it('[U:letta-code-args] a later session is a new conversation of the same agent', () => {
    expect(lettaCodeArgs({ tools: ['Bash'], model: 'scripted', agentId: 'agent-1' })).toEqual([...head, '--agent', 'agent-1', '--new', ...rest, '--tools', 'Bash', ...tail])
  })

  it('[U:letta-code-args] a session that is picked up again names its conversation, and only that', () => {
    const args = lettaCodeArgs({ tools: [], model: 'scripted', agentId: 'agent-1', conversationId: 'conv-1' })
    expect(args).toEqual([...head, '--conversation', 'conv-1', ...rest, '--tools', '', ...tail])
    // Letta Code refuses a conversation and an agent together.
    expect(args).not.toContain('--agent')
  })

  it('[U:letta-code-args] with no tools allowed it is told to load none, not left to its default set', () => {
    const args = lettaCodeArgs({ tools: [], model: 'scripted' })
    expect(args[args.indexOf('--tools') + 1]).toBe('')
  })

  it('[U:letta-code-args] it is always in strict permission mode, always headless, and never the server where the chat channels live', () => {
    for (const o of [{}, { agentId: 'a' }, { agentId: 'a', conversationId: 'c' }]) {
      const args = lettaCodeArgs({ tools: ['Bash'], model: 'scripted', ...o })
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('strict')
      expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1)
      expect(args[0]).toBe('-p')
      for (const never of ['server', '--channels', '--yolo', 'unrestricted', '--computer', '--memfs']) expect(args, never).not.toContain(never)
    }
  })
})
