// @vitest-environment node
// Fleet-wide Discord approver role for dangerous-command (DCG) approval:
// the config.yaml writer for platforms.discord.extra.approver_roles.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  setApproverRolesYaml,
  readApproverRoles,
  syncDiscordApproverRoles,
  discordApproverPosture,
} from '../discord-approver-roles'

const OPERATOR = '1533670688001495051'
const APPROVER = '1534000000000000001'

// Real fleet shape (cryptids/mare): a nested `  platforms:` block under
// display:, a top-level `discord:` block, then the real top-level platforms:.
const FLEET_YAML = [
  'display:',
  '  platforms:',
  '    discord:',
  '      streaming: false',
  'discord:',
  '  require_mention: true',
  'platforms:',
  '  mattermost:',
  '    extra:',
  '      approver_roles: should-not-change',
  '  discord:',
  '    enabled: true',
  '    extra:',
  '      require_admin_for_exec_approval: true',
  "      allow_admin_from: '111111111111111111,222222222222222222'",
  `      approver_roles: '${OPERATOR}'`,
  'plugins:',
  '  enabled:',
  '    - iris',
  '',
].join('\n')

describe('setApproverRolesYaml', () => {
  it('replaces only platforms.discord.extra.approver_roles and keeps allow_admin_from', () => {
    const r = setApproverRolesYaml(FLEET_YAML, [APPROVER])
    expect(r.status).toBe('updated')
    expect(r.yaml).toContain(`      approver_roles: '${APPROVER}'`)
    expect(r.yaml).not.toContain(OPERATOR)
    expect(r.yaml).toContain("      allow_admin_from: '111111111111111111,222222222222222222'")
    expect(r.yaml).toContain('      approver_roles: should-not-change')
    // Nothing else moved.
    expect(r.yaml.split('\n').length).toBe(FLEET_YAML.split('\n').length)
    expect(r.yaml.replace(APPROVER, OPERATOR)).toBe(FLEET_YAML)
  })

  it('is a no-op when the value already matches', () => {
    const r = setApproverRolesYaml(FLEET_YAML, [OPERATOR])
    expect(r.status).toBe('unchanged')
    expect(r.yaml).toBe(FLEET_YAML)
  })

  it('writes several roles as one comma list', () => {
    const r = setApproverRolesYaml(FLEET_YAML, [APPROVER, OPERATOR])
    expect(r.yaml).toContain(`      approver_roles: '${APPROVER},${OPERATOR}'`)
    expect(readApproverRoles(r.yaml).roles).toEqual([APPROVER, OPERATOR])
  })

  it('empty list writes an explicit empty value (nobody approves by role), not a removal', () => {
    const r = setApproverRolesYaml(FLEET_YAML, [])
    expect(r.status).toBe('updated')
    expect(r.yaml).toContain("      approver_roles: ''")
    expect(readApproverRoles(r.yaml)).toEqual({ found: true, roles: [] })
  })

  it('inserts the key when extra has none', () => {
    const yaml = FLEET_YAML.replace(`      approver_roles: '${OPERATOR}'\n`, '')
    const r = setApproverRolesYaml(yaml, [APPROVER])
    expect(r.status).toBe('updated')
    expect(readApproverRoles(r.yaml).roles).toEqual([APPROVER])
    expect(r.yaml).toContain("      allow_admin_from: '111111111111111111,222222222222222222'")
  })

  it('replaces a block-list value whole', () => {
    const yaml = FLEET_YAML.replace(
      `      approver_roles: '${OPERATOR}'\n`,
      `      approver_roles:\n        - "operator"\n        - "${OPERATOR}"\n`,
    )
    const r = setApproverRolesYaml(yaml, [APPROVER])
    expect(r.status).toBe('updated')
    expect(r.yaml).not.toContain('- "operator"')
    expect(r.yaml).toContain('plugins:\n  enabled:\n    - iris')
    expect(readApproverRoles(r.yaml).roles).toEqual([APPROVER])
  })

  it('never creates a platforms.discord.extra block that is not there', () => {
    const yaml = 'platforms:\n  discord:\n    enabled: true\nplugins: {}\n'
    expect(setApproverRolesYaml(yaml, [APPROVER])).toEqual({ status: 'no-extra-block', yaml })
    expect(setApproverRolesYaml('model: x\n', [APPROVER]).status).toBe('no-extra-block')
  })

  it('does not touch the nested display.platforms.discord block', () => {
    const yaml = 'display:\n  platforms:\n    discord:\n      extra:\n        approver_roles: x\n'
    expect(setApproverRolesYaml(yaml, [APPROVER]).status).toBe('no-extra-block')
  })

  it('refuses duplicate keys and flow-style extra rather than guess', () => {
    const dup = FLEET_YAML + 'platforms:\n  discord:\n    extra:\n      approver_roles: x\n'
    expect(setApproverRolesYaml(dup, [APPROVER]).status).toBe('unsupported')
    const flow = 'platforms:\n  discord:\n    extra: {approver_roles: x}\n'
    expect(setApproverRolesYaml(flow, [APPROVER]).status).toBe('unsupported')
  })

  it('reports shadowed when the top-level discord: block sets approver_roles (it overrides extra)', () => {
    const yaml = FLEET_YAML.replace('discord:\n  require_mention: true', `discord:\n  approver_roles: '${OPERATOR}'`)
    const r = setApproverRolesYaml(yaml, [APPROVER])
    expect(r.status).toBe('shadowed')
    expect(r.yaml).toBe(yaml)
  })

  it('keeps CRLF line endings', () => {
    const r = setApproverRolesYaml(FLEET_YAML.replace(/\n/g, '\r\n'), [APPROVER])
    expect(r.status).toBe('updated')
    expect(r.yaml).toContain(`      approver_roles: '${APPROVER}'\r\n`)
    expect(r.yaml.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('syncDiscordApproverRoles / discordApproverPosture', () => {
  let home: string
  const dir = (n: string) => path.join(home, `.hermes-${n}`)
  function mk(name: string, env: string, yaml?: string) {
    fs.mkdirSync(dir(name), { recursive: true })
    fs.writeFileSync(path.join(dir(name), '.env'), env, { mode: 0o600 })
    if (yaml !== undefined) fs.writeFileSync(path.join(dir(name), 'config.yaml'), yaml, { mode: 0o600 })
  }
  const yamlOf = (n: string) => fs.readFileSync(path.join(dir(n), 'config.yaml'), 'utf-8')
  const targets = () => ['iris', 'mare', 'signal-only', 'bare', 'missing'].map((name) => ({ name, dataDir: dir(name) }))

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'approver-roles-'))
    mk('iris', 'DISCORD_BOT_TOKEN=t\n', FLEET_YAML)
    mk('mare', 'DISCORD_BOT_TOKEN=t\n', FLEET_YAML.replace(`approver_roles: '${OPERATOR}'`, `approver_roles: '${APPROVER}'`))
    mk('signal-only', 'SIGNAL_ACCOUNT=+64\n', FLEET_YAML)
    mk('bare', 'DISCORD_BOT_TOKEN=t\n', 'platforms:\n  discord:\n    enabled: true\n')
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('writes Discord agents only, skips the rest with a reason, keeps file mode', () => {
    const res = syncDiscordApproverRoles(targets(), [APPROVER])
    expect(res.updated).toEqual(['iris'])
    expect(res.unchanged).toEqual(['mare'])
    expect(res.skipped).toEqual([
      { name: 'signal-only', reason: 'no-discord' },
      { name: 'bare', reason: 'no-extra-block' },
      { name: 'missing', reason: 'no-env' },
    ])
    expect(res.failed).toEqual([])
    expect(readApproverRoles(yamlOf('iris')).roles).toEqual([APPROVER])
    expect(yamlOf('signal-only')).toBe(FLEET_YAML)
    expect(fs.statSync(path.join(dir('iris'), 'config.yaml')).mode & 0o777).toBe(0o600)
  })

  it('posture reports each agent without writing', () => {
    const before = yamlOf('iris')
    const p = discordApproverPosture(targets(), [APPROVER])
    expect(yamlOf('iris')).toBe(before)
    expect(p.desired).toEqual([APPROVER])
    expect(p.drift).toEqual(['iris'])
    const iris = p.agents.find((a) => a.name === 'iris')!
    expect(iris).toMatchObject({ status: 'drift', roles: [OPERATOR], gateOn: true })
    expect(p.agents.find((a) => a.name === 'mare')).toMatchObject({ status: 'ok', roles: [APPROVER] })
    expect(p.agents.find((a) => a.name === 'bare')).toMatchObject({ status: 'no-extra-block', gateOn: false })
  })

  it('posture with no desired value (unmanaged) reports current roles and no drift', () => {
    const p = discordApproverPosture(targets(), null)
    expect(p.desired).toBeNull()
    expect(p.drift).toEqual([])
    expect(p.agents.find((a) => a.name === 'iris')).toMatchObject({ status: 'unmanaged', roles: [OPERATOR] })
  })
})
