// @vitest-environment node
/**
 * The rules record for a door agent, and what is rendered from it.
 *
 * The record is the only thing edited. The launcher's config and the start
 * script are written from it. The record names two secret files by path and
 * never holds what is in them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseConfig } from '@/lib/lab/pi-discord/config'
import {
  checkRecordInput, draftRecord, renderConfig, renderStartScript, rulesProblems, secretProblems, supervisorCommand,
} from '../door-record'

const RULES = {
  agentId: 'pi-one',
  persona: { name: 'Pi', description: 'Answers questions.' },
  discord: {
    guildId: '100000000000000000', channelId: '100000000000000001', adminUserIds: ['100000000000000002'],
    allowedUserIds: [], allowedRoleIds: [], anyoneInChannel: false, mentionRequired: true,
    bots: 'none', allowedBotIds: ['100000000000000003'], botLoopLimit: 2, readAllMessages: false,
  },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'provider/model-a', usdPerMTokIn: 1, usdPerMTokOut: 5 },
}

let tmp: string
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-record-'))) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('a draft', () => {
  it('is named, typed and not yet startable', () => {
    const draft = draftRecord('h_pi_one', 'pi-one', 'pi')
    expect(draft).toMatchObject({ schema: 1, id: 'h_pi_one', name: 'pi-one', runtime: 'pi', version: 1 })
    expect(draft.rules.agentId).toBe('pi-one')
    expect(draft.secrets).toEqual({ discordTokenFile: '', modelKeyFile: '' })
    expect(rulesProblems(draft).length).toBeGreaterThan(0)
  })

  it('starts closed: mention needed, no other bots, nobody but admins', () => {
    const d = draftRecord('h_pi_one', 'pi-one', 'pi').rules.discord
    expect(d).toMatchObject({ mentionRequired: true, bots: 'none', anyoneInChannel: false, allowedUserIds: [], allowedBotIds: [], readAllMessages: false })
  })
})

describe('checking an edit', () => {
  const draft = () => draftRecord('h_pi_one', 'pi-one', 'pi')

  it('accepts rules the launcher accepts', () => {
    const { errors, rules } = checkRecordInput(draft(), { rules: RULES, secrets: { discordTokenFile: '', modelKeyFile: '' } })
    expect(errors).toEqual([])
    expect(rules).toEqual(parseConfig(RULES).config)
  })

  it('lists every problem the launcher finds', () => {
    const bad = { ...RULES, discord: { ...RULES.discord, channelId: 'general', botLoopLimit: 99 }, budget: { monthlyUsd: 0 } }
    const { errors, rules } = checkRecordInput(draft(), { rules: bad, secrets: { discordTokenFile: '', modelKeyFile: '' } })
    expect(rules).toBeUndefined()
    expect(errors.join('\n')).toMatch(/discord\.channelId/)
    expect(errors.join('\n')).toMatch(/discord\.botLoopLimit/)
    expect(errors.join('\n')).toMatch(/budget\.monthlyUsd/)
  })

  it('refuses a setting the launcher does not have', () => {
    const { errors } = checkRecordInput(draft(), { rules: { ...RULES, tools: ['shell'] }, secrets: { discordTokenFile: '', modelKeyFile: '' } })
    expect(errors.join('\n')).toMatch(/tools/)
  })

  it('keeps the agent id the record was made with', () => {
    const { rules } = checkRecordInput(draft(), { rules: { ...RULES, agentId: 'someone-else' }, secrets: { discordTokenFile: '', modelKeyFile: '' } })
    expect(rules?.agentId).toBe('pi-one')
  })

  it.each([
    ['relative', 'secrets/token'],
    ['with a line break', '/tmp/a\nb'],
    ['not text', 7],
  ])('refuses a secret path that is %s', (_what, value) => {
    const { errors } = checkRecordInput(draft(), { rules: RULES, secrets: { discordTokenFile: value, modelKeyFile: '' } })
    expect(errors.join('\n')).toMatch(/bot token file/)
  })

  it('refuses anything in the secrets but the two paths', () => {
    const { errors } = checkRecordInput(draft(), { rules: RULES, secrets: { discordTokenFile: '', modelKeyFile: '', discordToken: 'x' } })
    expect(errors.join('\n')).toMatch(/discordToken/)
  })
})

describe('the secret files', () => {
  const withFiles = (mode: number) => {
    const token = path.join(tmp, 'token')
    const key = path.join(tmp, 'key')
    fs.writeFileSync(token, 'FAKE-TOKEN-VALUE-1\n', { mode })
    fs.writeFileSync(key, 'FAKE-KEY-VALUE-22\n', { mode })
    return { ...draftRecord('h_pi_one', 'pi-one', 'pi'), secrets: { discordTokenFile: token, modelKeyFile: key } }
  }

  const elsewhere = () => { const repo = path.join(tmp, 'repo-elsewhere'); fs.mkdirSync(repo, { recursive: true }); return repo }

  it('are fine when only the owner can read them and they sit outside the repo', () => {
    expect(secretProblems(withFiles(0o600), elsewhere())).toEqual([])
  })

  it('are refused when others can read them, without saying what they hold', () => {
    const problems = secretProblems(withFiles(0o644), elsewhere())
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toMatch(/bot token file/)
    expect(problems.join('\n')).toMatch(/model key file/)
    expect(problems.join('\n')).not.toMatch(/FAKE-/)
  })

  it('are refused inside the repo', () => {
    expect(secretProblems(withFiles(0o600), tmp).join('\n')).toMatch(/inside the repo/)
  })

  it('are reported when not set', () => {
    expect(secretProblems(draftRecord('h_pi_one', 'pi-one', 'pi'), tmp)).toHaveLength(2)
  })
})

describe('what is rendered', () => {
  const record = () => {
    const d = draftRecord('h_pi_one', 'pi-one', 'pi')
    const checked = checkRecordInput(d, { rules: RULES, secrets: { discordTokenFile: '/keys/it\'s token', modelKeyFile: '/keys/model-key' } })
    return { ...d, rules: checked.rules!, secrets: checked.secrets! }
  }

  it('is a config the launcher reads back as the same rules', () => {
    const text = renderConfig(record())
    const back = parseConfig(JSON.parse(text))
    expect(back.errors).toEqual([])
    expect(back.config).toEqual(record().rules)
    expect(text).toMatch(/Do not edit/)
  })

  it('holds no secret path and no secret in the config', () => {
    expect(renderConfig(record())).not.toMatch(/keys\//)
  })

  it('is a start script that names the files by path and runs the launcher', () => {
    const script = renderStartScript(record(), { node: '/usr/bin/node', cli: '/repo/lib/lab/pi-discord/cli.ts', configPath: '/data/a/config.json', stateDir: '/data/a/state' })
    expect(script).toMatch(/^#!\/bin\/sh\n/)
    expect(script).toContain(`export SMLAB_DISCORD_TOKEN_FILE='/keys/it'\\''s token'`)
    expect(script).toContain(`export SMLAB_MODEL_KEY_FILE='/keys/model-key'`)
    expect(script).toContain(`export SMLAB_STATE_DIR='/data/a/state'`)
    expect(script).toContain(`exec '/usr/bin/node' '/repo/lib/lab/pi-discord/cli.ts' start --config '/data/a/config.json'`)
  })

  it('gives a pm2 command that runs the script from the data folder and leaves a clean stop stopped', () => {
    const command = supervisorCommand(record(), { startScript: '/data/a/start.sh', logPath: '/data/a/door.log' })
    expect(command).toBe(`pm2 start '/data/a/start.sh' --name 'door-pi-one' --interpreter sh --stop-exit-codes 0 --output '/data/a/door.log' --error '/data/a/door.log'`)
  })
})
