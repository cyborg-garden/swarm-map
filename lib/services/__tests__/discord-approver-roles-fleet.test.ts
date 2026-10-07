// @vitest-environment node
// Fleet wiring for the approver-role setting: startup sync, and the
// GET (report) / POST (apply now) route.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const listMock = vi.hoisted(() => vi.fn())
const getSettingsMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services', () => ({
  services: {
    harness: { list: listMock },
    config: { getSettings: getSettingsMock },
  },
}))

import { syncFleetDiscordApproverRolesAtStartup } from '../discord-approver-roles-fleet'
import { GET, POST } from '@/app/api/fleet/discord-approver-roles/route'

const OPERATOR = '1533670688001495051'
const APPROVER = '1534000000000000001'
const YAML = `platforms:\n  discord:\n    extra:\n      require_admin_for_exec_approval: true\n      allow_admin_from: '111111111111111111'\n      approver_roles: '${OPERATOR}'\n`

let home: string
const dir = (n: string) => path.join(home, `.hermes-${n}`)
const yamlOf = (n: string) => fs.readFileSync(path.join(dir(n), 'config.yaml'), 'utf-8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'approver-fleet-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  for (const n of ['iris', 'mare']) {
    fs.mkdirSync(dir(n), { recursive: true })
    fs.writeFileSync(path.join(dir(n), '.env'), 'DISCORD_BOT_TOKEN=t\n')
    fs.writeFileSync(path.join(dir(n), 'config.yaml'), YAML)
  }
  listMock.mockReturnValue([
    { id: 'h_iris', name: 'iris', runtime: 'hermes' },
    { id: 'h_mare', name: 'mare', runtime: 'hermes' },
    { id: 'h_l', name: 'l', runtime: 'letta' },
  ])
  getSettingsMock.mockReturnValue({ discordApproverRoles: [APPROVER] })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('syncFleetDiscordApproverRolesAtStartup', () => {
  it('writes the setting into every Discord agent', () => {
    expect(syncFleetDiscordApproverRolesAtStartup()?.updated).toEqual(['iris', 'mare'])
    expect(yamlOf('iris')).toContain(`approver_roles: '${APPROVER}'`)
    expect(yamlOf('iris')).toContain("allow_admin_from: '111111111111111111'")
  })

  it('ignores a hand-edited setting that is not a list of role IDs, writing nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const bad of [["1'\n      require_admin_for_exec_approval: false"], ['operator'], 'x', [123]]) {
      getSettingsMock.mockReturnValue({ discordApproverRoles: bad })
      expect(syncFleetDiscordApproverRolesAtStartup()).toBeNull()
    }
    expect(yamlOf('iris')).toBe(YAML)
    expect(yamlOf('mare')).toBe(YAML)
  })

  it('does nothing when the setting is unset or null (unmanaged)', () => {
    getSettingsMock.mockReturnValue({})
    expect(syncFleetDiscordApproverRolesAtStartup()).toBeNull()
    getSettingsMock.mockReturnValue({ discordApproverRoles: null })
    expect(syncFleetDiscordApproverRolesAtStartup()).toBeNull()
    expect(yamlOf('iris')).toBe(YAML)
  })

  it('never throws', () => {
    listMock.mockImplementation(() => { throw new Error('boom') })
    expect(syncFleetDiscordApproverRolesAtStartup()).toBeNull()
  })
})

describe('/api/fleet/discord-approver-roles', () => {
  it('GET reports drift without writing', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.desired).toEqual([APPROVER])
    expect(body.drift).toEqual(['iris', 'mare'])
    expect(yamlOf('iris')).toBe(YAML)
  })

  it('POST applies the setting and says a restart is needed', async () => {
    const res = await POST()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toEqual(['iris', 'mare'])
    expect(body.restartNeeded).toEqual(['iris', 'mare'])
    expect(yamlOf('mare')).toContain(`approver_roles: '${APPROVER}'`)
  })

  it('POST refuses when the setting is unmanaged', async () => {
    getSettingsMock.mockReturnValue({})
    const res = await POST()
    expect(res.status).toBe(409)
    expect(yamlOf('iris')).toBe(YAML)
  })
})
