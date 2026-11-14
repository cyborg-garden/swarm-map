// @vitest-environment node
//
// The launcher's parts that need no Docker: the config, the two secret
// files, and the cell as it is written down.
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePolicy } from '../../../core/policy/validate.ts'
import { CELL_ENV, renderCell, sealProblems, type CellOptions } from '../cell.ts'
import { parseConfig, policyFor } from '../config.ts'
import { prepareStateDir, REPO_ROOT } from '../launch.ts'
import { readSecretFile, secretFileProblem } from '../secrets.ts'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'smlab-launcher-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const good = (): Record<string, any> => ({ // eslint-disable-line @typescript-eslint/no-explicit-any -- a config under test is patched freely
  agentId: 'pi-lab',
  discord: { guildId: '700000000000000001', channelId: '710000000000000001', adminUserIds: ['800000000000000001'] },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 5 },
})
const patched = (at: string, value: unknown): unknown => {
  const c = good()
  const keys = at.split('.')
  let node = c
  for (const k of keys.slice(0, -1)) node = node[k]
  if (value === undefined) delete node[keys.at(-1) as string]
  else node[keys.at(-1) as string] = value
  return c
}

describe('pi-discord config', () => {
  it('a filled-in config is accepted, with the closed settings as defaults', () => {
    const { config, errors } = parseConfig(good())
    expect(errors).toEqual([])
    expect(config?.discord).toMatchObject({ mentionRequired: true, anyoneInChannel: false, bots: 'none', botLoopLimit: 4, readAllMessages: false, allowedUserIds: [] })
  })

  it('the example file is refused until its ids are filled in, and holds no id, token or key', () => {
    const text = readFileSync(path.join(import.meta.dirname, '..', 'config.example.json'), 'utf8')
    const { config, errors } = parseConfig(JSON.parse(text))
    expect(config).toBeUndefined()
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('discord.guildId'), expect.stringContaining('discord.channelId'), expect.stringContaining('discord.adminUserIds[0]')]))
    expect(text).not.toMatch(/\d{15,}/)
    expect(text).not.toMatch(/"(token|key|secret)"/i)
  })

  it.each([
    ['discord.token', 'x', /discord\.token: not a setting/],
    ['token', 'x', /config\.token: not a setting/],
    ['discord.guildId', 'my-server', /discord\.guildId/],
    ['discord.channelId', 710000000000000001, /discord\.channelId/],
    ['discord.adminUserIds', [], /name at least one admin/],
    ['discord.adminUserIds', undefined, /discord\.adminUserIds/],
    ['discord.allowedUserIds', ['@someone'], /discord\.allowedUserIds\[0\]/],
    ['discord.mentionRequired', 'yes', /discord\.mentionRequired/],
    ['discord.mentionRequired', false, /needs discord\.readAllMessages/],
    ['discord.bots', 'all', /discord\.bots/],
    ['discord.botLoopLimit', 2.5, /discord\.botLoopLimit/],
    ['discord.botLoopLimit', 99, /discord\.botLoopLimit/],
    ['budget.monthlyUsd', 0, /budget\.monthlyUsd/],
    ['budget', undefined, /budget/],
    ['model.usdPerMTokIn', -1, /model\.usdPerMTokIn/],
    ['model.usdPerMTokOut', undefined, /model\.usdPerMTokOut/],
    ['model.id', 'a model; rm -rf', /model\.id/],
    ['model.baseUrl', 'http://model.example/v1', /must be https/],
    ['model.baseUrl', 'http://127.0.0.1:9/v1', /must be https/],
    ['model.baseUrl', 'https://user:pass@model.example/v1', /no password/],
    ['model.baseUrl', 'https://model.example/', /ending in \/v1/],
    ['agentId', 'Pi Lab', /agentId/],
  ])('refuses %s = %j', (at, value, why) => {
    const { config, errors } = parseConfig(patched(at, value))
    expect(config).toBeUndefined()
    expect(errors.join('\n')).toMatch(why)
  })

  it('a model on this machine is accepted only when a test says so', () => {
    const local = patched('model.baseUrl', 'http://127.0.0.1:9/v1')
    expect(parseConfig(local, { allowLoopbackModel: true }).errors).toEqual([])
    expect(parseConfig(patched('model.baseUrl', 'http://192.0.2.1/v1'), { allowLoopbackModel: true }).errors.join()).toMatch(/must be https/)
  })

  it('the policy it becomes is valid and closed: one room, no DMs, no tools, a cap that refuses', () => {
    const policy = policyFor(parseConfig(good()).config!)
    expect(validatePolicy(policy)).toEqual([])
    const s = policy.surfaces.discord!
    expect(Object.keys(policy.surfaces)).toEqual(['discord'])
    expect(s.rooms).toEqual([{ match: { room: '710000000000000001' }, mode: 'mention' }])
    expect(s.dm).toEqual({ mode: 'closed', users: [] })
    expect(s.users).toEqual([{ kind: 'user', id: '800000000000000001' }])
    expect(s.admins).toEqual(s.users)
    expect([s.anyoneInAllowedRoom, s.observeUnmentioned, s.threadsRequireMention, s.bots.mode]).toEqual([false, false, true, 'none'])
    expect(policy.tools.allow).toEqual([])
    expect(policy.budget).toEqual({ monthlyUsd: 5, onExceed: 'refuse' })
  })
})

describe('pi-discord secret files', () => {
  const SECRET = 'not-a-real-secret-0123456789'
  const file = (name: string, content = SECRET, mode = 0o600): string => {
    const p = path.join(tmp, name)
    writeFileSync(p, content)
    chmodSync(p, mode)
    return p
  }
  const NAME = 'SMLAB_DISCORD_TOKEN_FILE'

  it('reads a file only its owner can read, outside the repo', () => {
    expect(readSecretFile(NAME, { [NAME]: file('ok', `${SECRET}\n`) }, REPO_ROOT)).toBe(SECRET)
  })

  it.each([
    ['is not set', () => ({}), /is not set/],
    ['is a relative path', () => ({ [NAME]: 'token.txt' }), /absolute path/],
    ['points at nothing', () => ({ [NAME]: path.join(tmp, 'missing') }), /not there/],
    ['points at a file others can read', () => ({ [NAME]: file('group', SECRET, 0o640) }), /others can read/],
    ['points at a file anyone can read', () => ({ [NAME]: file('world', SECRET, 0o604) }), /others can read/],
    ['points at a link', () => { const l = path.join(tmp, 'link'); symlinkSync(file('target'), l); return { [NAME]: l } }, /points at a link/],
    ['points at a folder', () => ({ [NAME]: tmp }), /does not point at a file/],
    ['points inside the repo', () => ({ [NAME]: path.join(REPO_ROOT, 'package.json') }), /others can read|inside the repo/],
    ['holds nothing', () => ({ [NAME]: file('empty', '\n') }), /one secret on one line/],
    ['holds two lines', () => ({ [NAME]: file('two', `${SECRET}\n${SECRET}\n`) }), /one secret on one line/],
  ])('refuses when the variable %s, and never says what a file holds', (_name, env, why) => {
    const made = env()
    const problem = secretFileProblem(NAME, made, REPO_ROOT)
    expect(problem).toMatch(why)
    expect(problem).not.toContain(SECRET)
    expect(() => readSecretFile(NAME, made, REPO_ROOT)).toThrow(why)
  })

  it('a file inside the repo is refused even when only its owner can read it', () => {
    const inRepo = path.join(REPO_ROOT, `.smlab-test-secret-${process.pid}`)
    writeFileSync(inRepo, SECRET, { mode: 0o600 })
    try { expect(secretFileProblem(NAME, { [NAME]: inRepo }, REPO_ROOT)).toMatch(/inside the repo/) } finally { rmSync(inRepo, { force: true }) }
  })

  it('the state folder is refused inside the repo, and made private outside it', () => {
    expect(() => prepareStateDir(path.join(REPO_ROOT, 'lib', 'lab'))).toThrow(/inside the repo/)
    expect(() => prepareStateDir('relative')).toThrow(/absolute/)
    expect(prepareStateDir(path.join(tmp, 'state'))).toBe(path.join(tmp, 'state'))
  })
})

describe('pi-discord cell, as written', () => {
  const cellNonce = '0123456789abcdef'.repeat(2)
  const options: CellOptions = { nonce: '0badf00d', cellNonce, brainToken: `BRAIN-${cellNonce}-0123456789abcdef`, brainPort: 50001, routePort: 50002, model: 'lab/model' }

  it('is sealed: one network with no way out, read-only, non-root, one folder of its own, no published port', () => {
    const file = renderCell(options)
    expect(sealProblems(file)).toEqual([])
    const { cell, door } = file.services
    expect(cell.networks).toEqual(['cell'])
    expect(file.networks.cell.internal).toBe(true)
    expect([cell.read_only, cell.user, cell.cap_drop, cell.volumes]).toEqual([true, 'node', ['ALL'], ['lab:/tmp/smlab']])
    expect(Object.keys(cell.environment).sort()).toEqual(CELL_ENV)
    expect(door.environment).toEqual({ SMLAB_RELAY: '7801=host.docker.internal:50001,7802=host.docker.internal:50002' })
    expect(JSON.stringify(file)).not.toMatch(/"ports"|docker\.sock|privileged/)
  })

  it('a secret anywhere in the file is caught', () => {
    const file = renderCell(options)
    expect(sealProblems(file, ['the-bot-token-value'])).toEqual([])
    file.services.door.environment.NOTE = 'the-bot-token-value'
    expect(sealProblems(file, ['the-bot-token-value'])).toEqual(expect.arrayContaining(['a secret is in the file']))
  })

  it.each([
    ['the cell also on the network with a way out', (f: ReturnType<typeof renderCell>) => { f.services.cell.networks.push('egress') }, /the cell is on cell and egress/],
    ['the cell network given a way out', (f) => { f.networks.cell.internal = false }, /not internal/],
    ['a writable cell', (f) => { f.services.cell.read_only = false }, /can write its own disk/],
    ['a cell run as root', (f) => { f.services.cell.user = '0' }, /runs as 0/],
    ['a host folder in the cell', (f) => { f.services.cell.volumes!.push('/Users:/mnt/host:ro') }, /mounts something other/],
    ['a credential-shaped variable in the cell', (f) => { f.services.cell.environment.DISCORD_BOT_TOKEN = 'x' }, /not on its list/],
    ['a published port', (f) => { (f.services.cell as unknown as Record<string, unknown>).ports = ['7801:7801'] }, /sets ports/],
    ['a capability handed back', (f) => { f.services.cell.cap_add = ['NET_ADMIN'] }, /sets cap_add/],
    ['a Docker socket for the relay', (f) => { f.services.door.volumes = ['/var/run/docker.sock:/var/run/docker.sock'] }, /Docker socket/],
    ['a relay handed more than its two ports', (f) => { f.services.door.environment.EXTRA = '1' }, /relay is handed/],
  ] as [string, (f: ReturnType<typeof renderCell>) => void, RegExp][])('refuses %s', (_name, breakIt, why) => {
    const file = renderCell(options)
    breakIt(file)
    expect(sealProblems(file).join('\n')).toMatch(why)
  })

  it('the two ways of breaking it on purpose are caught as written', () => {
    expect(sealProblems(renderCell({ ...options, broken: 'cell-on-egress' })).join()).toMatch(/the cell is on cell and egress/)
    expect(sealProblems(renderCell({ ...options, broken: 'cell-writable' })).join()).toMatch(/write its own disk/)
  })

  it('refuses a nonce or a port that is not one', () => {
    expect(() => renderCell({ ...options, nonce: 'prod' })).toThrow(/REFUSING TO RUN: F5/)
    expect(() => renderCell({ ...options, brainPort: 80 })).toThrow(/REFUSING TO RUN: F5/)
    // The cell's placeholder must not be something a container name gives away.
    expect(() => renderCell({ ...options, cellNonce: '0badf00d', brainToken: 'BRAIN-0badf00d-0123456789abcdef' })).toThrow(/REFUSING TO RUN: F5/)
    expect(JSON.stringify(renderCell(options).services.cell)).not.toContain('0badf00d')
  })
})
