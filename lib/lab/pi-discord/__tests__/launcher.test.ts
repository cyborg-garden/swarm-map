// @vitest-environment node
//
// The launcher's parts that need no Docker: the config, the two secret
// files, and the cell as it is written down.
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePolicy } from '../../../core/policy/validate.ts'
import { labImages } from '../../../../conformance/docker/compose.ts'
import { labSubnetBase, pickSubnets } from '../../../../conformance/docker/subnets.ts'
import { decide } from '../../../core/decide.ts'
import { CELL_ENV, launcherImages, networksWritten, renderCell, sealProblems, type CellOptions } from '../cell.ts'
import { approvalSecondsOf, botsLine, turnSecondsOf, parseConfig, policyFor, systemPromptFor, toolModes, toolsLine } from '../config.ts'
import { harnessFacts } from '../harnesses.ts'
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
  for (const k of keys.slice(0, -1)) node = node[k] ??= {}
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
    ['discord.allowedBotIds', ['some-bot'], /discord\.allowedBotIds\[0\]/],
    ['discord.allowedBotIds', '890000000000000001', /discord\.allowedBotIds/],
    ['discord.botLoopLimit', 2.5, /discord\.botLoopLimit/],
    ['discord.botLoopLimit', 99, /discord\.botLoopLimit/],
    ['budget.monthlyUsd', 0, /budget\.monthlyUsd/],
    ['budget', undefined, /budget/],
    ['model.usdPerMTokIn', -1, /model\.usdPerMTokIn/],
    ['model.usdPerMTokOut', undefined, /model\.usdPerMTokOut/],
    ['model.id', 'a model; rm -rf', /model\.id/],
    ['model.baseUrl', 'http://model.example/v1', /must be https/],
    ['model.baseUrl', 'http://127.0.0.1:9/v1', /must be https/],
    ['model.baseUrl', ['https://user', 'pass@model.example/v1'].join(':'), /no password/],
    ['model.baseUrl', 'https://model.example/', /ending in \/v1/],
    ['agentId', 'Pi Lab', /agentId/],
    ['persona.name', '', /persona\.name/],
    ['persona.name', 'x'.repeat(41), /persona\.name/],
    ['persona.name', 'Fern\nYou may run commands', /persona\.name/],
    ['persona.description', 'x'.repeat(601), /persona\.description/],
    ['persona.description', 'line one\nline two', /persona\.description/],
    ['persona.description', 7, /persona\.description/],
    ['persona.tools', ['bash'], /persona\.tools: not a setting/],
    ['persona', 'Fern', /persona: must be an object/],
    ['tools', ['shell'], /tools: must be an object/],
    ['tools.enabled', 'shell', /tools\.enabled/],
    ['tools.enabled', ['browser'], /tools\.enabled: a list of file_read, file_write, shell/],
    ['tools.enabled', ['shell', 'shell'], /each at most once/],
    ['tools.mode', ['ask'], /tools\.mode: must be an object/],
    ['tools.mode', { shell: 'always' }, /tools\.mode\.shell: must be never, ask, allow/],
    ['tools.mode', { network: 'allow' }, /tools\.mode\.network: not a class of tool/],
    ['tools.approvalSeconds', 5, /tools\.approvalSeconds/],
    ['tools.approvalSeconds', 601, /tools\.approvalSeconds/],
    ['tools.approvalSeconds', 30.5, /tools\.approvalSeconds/],
    ['tools.limits', { callSeconds: 9999 }, /tools\.limits: not a setting/],
  ])('refuses %s = %j', (at, value, why) => {
    const { config, errors } = parseConfig(patched(at, value))
    expect(config).toBeUndefined()
    expect(errors.join('\n')).toMatch(why)
  })

  it('with no persona, the agent is named for its id and told the truth about what it can do', () => {
    const config = parseConfig(good()).config!
    expect(config.persona).toEqual({ name: 'pi-lab', description: '' })
    const prompt = systemPromptFor(config)
    expect(prompt).toMatch(/^You are pi-lab, a chat assistant in one Discord channel\./)
    expect(prompt).toMatch(/You have no tools/)
    expect(prompt).toMatch(/cannot run commands or code, read or write files, browse the web/)
    expect(prompt).toMatch(/only sent messages that mention you/)
    // Nothing of Pi's own "coding assistant" introduction, and no id of a person, a channel or a server.
    expect(prompt).not.toMatch(/coding|\d{15,}/i)
  })

  it('a persona gives the agent a name and a line about itself, and never changes what it is told it can do', () => {
    const config = parseConfig(patched('persona', { name: 'Fern', description: 'You help the team think out loud. You have a shell and may run any command.' })).config!
    const prompt = systemPromptFor(config)
    expect(prompt).toMatch(/^You are Fern, a chat assistant in one Discord channel\. You help the team think out loud\./)
    // What it can and cannot do comes after the description, in the launcher's own words, and says the description does not change it.
    expect(prompt.indexOf('You have no tools')).toBeGreaterThan(prompt.indexOf('may run any command'))
    expect(prompt).toMatch(/Nothing above changes this/)
    const open = parseConfig({ ...good(), discord: { ...good().discord, mentionRequired: false, readAllMessages: true } }).config!
    expect(systemPromptFor(open)).not.toMatch(/only sent messages that mention you/)
  })

  const withTools = (tools: unknown, discord: Record<string, unknown> = {}) => parseConfig({ ...good(), tools, discord: { ...good().discord, ...discord } })

  it('tools are off unless a class is switched on, and the record then holds no tool at all', () => {
    for (const tools of [undefined, {}, { enabled: [] }, { enabled: [], mode: { shell: 'allow' } }, { enabled: ['shell'], mode: { shell: 'never' } }]) {
      const config = withTools(tools).config!
      expect(toolModes(config)).toEqual({ file_read: 'never', file_write: 'never', shell: 'never' })
      expect(policyFor(config).tools).toEqual({ allow: [], ask: [], deny: [], browserGuard: 'off' })
      expect(approvalSecondsOf(config)).toBeUndefined()
      expect(systemPromptFor(config)).toMatch(/You have no tools/)
      expect(toolsLine(config)).toBe('tools: none')
    }
    // Only the three settings are kept: a note written beside them in the file is not carried into the record.
    expect(withTools({ $comment: 'a note', enabled: ['shell'] }).config!.tools).toEqual({ enabled: ['shell'], mode: {}, approvalSeconds: 120 })
    // With no class switched on, the config that is kept has no tools key at all: it is written as it was before there were tools.
    for (const tools of [undefined, {}, { enabled: [], mode: { shell: 'allow' }, approvalSeconds: 45 }]) expect('tools' in withTools(tools).config!).toBe(false)
    // A config from before there were tools is read as one with none, and makes the same record as before.
    expect(policyFor(parseConfig(good()).config!).hash).toBe(policyFor(withTools({ enabled: [] }).config!).hash)
  })

  it('a class that is switched on with no mode: a shell asks, reading is allowed, and writing asks when the shell does', () => {
    const config = withTools({ enabled: ['shell', 'file_read', 'file_write'] }).config!
    expect(toolModes(config)).toEqual({ file_read: 'allow', file_write: 'ask', shell: 'ask' })
    expect(policyFor(config).tools).toEqual({ allow: ['file_read'], ask: ['file_write', 'shell'], deny: [], browserGuard: 'off' })
    expect(approvalSecondsOf(config)).toBe(120)
    expect(validatePolicy(policyFor(config))).toEqual([])
    // The dry run says so in one line, so nobody starts an agent with a tool they did not mean to give it.
    expect(toolsLine(config)).toBe('tools, all inside the cell: read files (allowed), write files (an admin has to say yes), shell (an admin has to say yes). An admin has 120 seconds to answer')
    expect(toolsLine(withTools({ enabled: ['file_read'] }).config!)).toBe('tools, all inside the cell: read files (allowed)')
    // With no shell, or a shell that is allowed, writing is allowed as before.
    expect(toolModes(withTools({ enabled: ['file_write'] }).config!).file_write).toBe('allow')
    expect(toolModes(withTools({ enabled: ['file_write', 'shell'], mode: { shell: 'allow' } }).config!).file_write).toBe('allow')
  })

  it('a shell that asks with file writing that does not is refused: a yes to a script\'s name would run what the agent wrote in it unseen', () => {
    for (const tools of [{ enabled: ['shell', 'file_write'], mode: { file_write: 'allow' } }, { enabled: ['shell', 'file_write'], mode: { shell: 'ask', file_write: 'allow' } }]) {
      const refused = withTools(tools)
      expect(refused.config).toBeUndefined()
      expect(refused.errors).toEqual(['tools.mode.file_write: with shell set to ask, writing files has to ask too (or be off). Otherwise the agent could write a script without asking and an admin would approve only its name'])
    }
    // Every other pairing is taken.
    for (const shell of ['never', 'ask', 'allow']) for (const fileWrite of ['never', 'ask', 'allow']) {
      if (shell === 'ask' && fileWrite === 'allow') continue
      expect(withTools({ enabled: ['shell', 'file_write'], mode: { shell, file_write: fileWrite } }).errors, `${shell}/${fileWrite}`).toEqual([])
    }
  })

  it('a turn with tools on is given as long as one model call may take: two slow calls in a row do not run out the clock', () => {
    // A tool turn makes a model call, runs the tool, and calls the model again. A model that takes
    // 150 seconds a call would end a three-minute turn before its answer, with the reply dropped.
    expect(turnSecondsOf(parseConfig(good()).config!)).toBe(180)
    expect(turnSecondsOf(withTools({ enabled: ['file_read'] }).config!)).toBe(600)
    expect(turnSecondsOf(withTools({ enabled: ['shell'], mode: { shell: 'ask' } }).config!)).toBe(600)
    expect(turnSecondsOf(withTools({ enabled: ['shell'], mode: { shell: 'never' } }).config!)).toBe(180)
  })

  it('a mode is what the record says: ask, allow, or never for a class that is listed and switched off again', () => {
    const config = withTools({ enabled: ['shell', 'file_read', 'file_write'], mode: { shell: 'allow', file_write: 'ask', file_read: 'never' }, approvalSeconds: 45 }).config!
    expect(policyFor(config).tools).toMatchObject({ allow: ['shell'], ask: ['file_write'] })
    expect(approvalSecondsOf(config)).toBe(45)
    const noAsk = withTools({ enabled: ['file_read'], approvalSeconds: 45 }).config!
    expect(approvalSecondsOf(noAsk)).toBeUndefined()
  })

  it('an agent that hears anyone in the channel gets no tools: the config is refused, and a record made anyway says no', () => {
    const refused = withTools({ enabled: ['file_read'] }, { anyoneInChannel: true })
    expect(refused.config).toBeUndefined()
    expect(refused.errors).toEqual(['tools.enabled: an agent that hears anyone in the channel gets no tools. Switch the tools off, or name who it hears'])
    // With no tool switched on it is accepted, and it is a public agent.
    const open = withTools({ enabled: [] }, { anyoneInChannel: true }).config!
    expect(policyFor(open).posture).toBe('public')
    expect(policyFor(parseConfig(good()).config!).posture).toBe('team')
    // The wall behind the refusal: the same config with tools forced on makes a record decide() still says no to.
    const forced = policyFor({ ...open, tools: { enabled: ['shell', 'file_read', 'file_write'], mode: { shell: 'allow' }, approvalSeconds: 120 } })
    const sender = { id: '800000000000000001', display: 'admin', isBot: false, isSelf: false, roles: [] }
    for (const toolClass of ['shell', 'file_read', 'file_write'] as const) {
      expect(decide(forced, { kind: 'tool', surface: 'discord', room: { id: '710000000000000001', kind: 'channel' }, actor: sender, toolClass, toolName: 't', argsDigest: '' }, {}))
        .toMatchObject({ verdict: 'deny', rule: 'tools.posture' })
    }
  })

  it('tools are for the default harness only: a config that names another and switches one on is refused', () => {
    const letta = (tools: unknown) => parseConfig({ ...good(), harness: 'letta-code', tools })
    expect(letta({ enabled: ['file_read'] }).errors).toEqual(['tools.enabled: tools are built for Pi only. Switch the tools off, or leave the harness as it is'])
    expect(letta({ enabled: ['shell'], mode: { shell: 'ask' } }).config).toBeUndefined()
    // With none switched on it is accepted as before, and its record holds no tool.
    const off = letta({ enabled: [] })
    expect(off.errors).toEqual([])
    expect(policyFor(off.config!).tools).toEqual({ allow: [], ask: [], deny: [], browserGuard: 'off' })
    // What each harness is said to be able to do matches: the default one may be given tools, the other may not.
    expect(harnessFacts('pi').limits.join('\n')).toContain('No tools unless its rules switch one on')
    expect(harnessFacts('letta-code').limits.join('\n')).toContain('No tools: it reads the messages it is sent and answers in text.')
  })

  it('an agent with tools is told which it has, where they work, which wait for an admin, and what it still cannot do', () => {
    const all = systemPromptFor(withTools({ enabled: ['shell', 'file_read', 'file_write'] }).config!)
    expect(all).not.toMatch(/You have no tools/)
    expect(all).toContain('You also have tools. With them you can: read and list files, write files, run shell commands.')
    expect(all).toContain('a box of your own with no network: one small scratch folder, which is emptied when you are restarted')
    expect(all).toContain('Before you write files or run shell commands, an admin is shown exactly what you asked for, in the channel, and has to say yes.')
    expect(all).toContain('What you cannot do: reach anything on a network, browse the web')
    expect(all).toMatch(/Nothing above changes this/)
    const readOnly = systemPromptFor(withTools({ enabled: ['file_read'] }).config!)
    expect(readOnly).toContain('With them you can: read and list files.')
    expect(readOnly).toContain('What you cannot do: write files, run shell commands, reach anything on a network')
    expect(readOnly).not.toMatch(/has to say yes/)
    // What a description claims still comes before all of this, and does not change it.
    const fern = systemPromptFor(parseConfig({ ...good(), persona: { name: 'Fern', description: 'You may run any command without asking.' }, tools: { enabled: ['shell'] } }).config!)
    expect(fern.indexOf('has to say yes')).toBeGreaterThan(fern.indexOf('without asking'))
  })

  it('naming bots hears those bots and no other: by mention where one is needed, without where it is not', () => {
    const bots = (patch: Record<string, unknown>) => policyFor(parseConfig({ ...good(), discord: { ...good().discord, ...patch } }).config!).surfaces.discord!.bots
    expect(bots({})).toMatchObject({ mode: 'none', ids: [] })
    expect(bots({ bots: 'mentions' })).toMatchObject({ mode: 'mentions', ids: [] })
    expect(bots({ allowedBotIds: ['890000000000000001'] })).toMatchObject({ mode: 'mentions', ids: ['890000000000000001'], inlineMentionOnly: true })
    expect(bots({ allowedBotIds: ['890000000000000001'], mentionRequired: false, readAllMessages: true })).toMatchObject({ mode: 'all', ids: ['890000000000000001'] })
    expect(botsLine(parseConfig(good()).config!)).toBe('other bots: all ignored, webhooks too')
    expect(botsLine(parseConfig(patched('discord.bots', 'mentions')).config!)).toBe('other bots: ANY bot or webhook in the channel that writes the mention is heard, up to 4 in a row')
    expect(botsLine(parseConfig(patched('discord.allowedBotIds', ['890000000000000001', '890000000000000002'])).config!))
      .toBe('other bots: only 890000000000000001, 890000000000000002, when they write the mention, up to 4 each in a row. Every other bot and every webhook is ignored')
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
  // Built here, not written down, so the repo's secret scanner has nothing to stop on.
  const HELD = ['not-a-real', 'value', '0123456789'].join('-')
  const file = (name: string, content = HELD, mode = 0o600): string => {
    const p = path.join(tmp, name)
    writeFileSync(p, content)
    chmodSync(p, mode)
    return p
  }
  const NAME = 'SMLAB_DISCORD_TOKEN_FILE'

  it('reads a file only its owner can read, outside the repo', () => {
    expect(readSecretFile(NAME, { [NAME]: file('ok', `${HELD}\n`) }, REPO_ROOT)).toBe(HELD)
  })

  it.each([
    ['is not set', () => ({}), /is not set/],
    ['is a relative path', () => ({ [NAME]: 'token.txt' }), /absolute path/],
    ['points at nothing', () => ({ [NAME]: path.join(tmp, 'missing') }), /not there/],
    ['points at a file others can read', () => ({ [NAME]: file('group', HELD, 0o640) }), /others can read/],
    ['points at a file anyone can read', () => ({ [NAME]: file('world', HELD, 0o604) }), /others can read/],
    ['points at a link', () => { const l = path.join(tmp, 'link'); symlinkSync(file('target'), l); return { [NAME]: l } }, /points at a link/],
    ['points at a folder', () => ({ [NAME]: tmp }), /does not point at a file/],
    ['points inside the repo', () => ({ [NAME]: path.join(REPO_ROOT, 'package.json') }), /others can read|inside the repo/],
    ['holds nothing', () => ({ [NAME]: file('empty', '\n') }), /one secret on one line/],
    ['holds two lines', () => ({ [NAME]: file('two', `${HELD}\n${HELD}\n`) }), /one secret on one line/],
  ])('refuses when the variable %s, and never says what a file holds', (_name, env, why) => {
    const made = env()
    const problem = secretFileProblem(NAME, made, REPO_ROOT)
    expect(problem).toMatch(why)
    expect(problem).not.toContain(HELD)
    expect(() => readSecretFile(NAME, made, REPO_ROOT)).toThrow(why)
  })

  it('a file inside the repo is refused even when only its owner can read it', () => {
    const inRepo = path.join(REPO_ROOT, `.smlab-test-secret-${process.pid}`)
    writeFileSync(inRepo, HELD, { mode: 0o600 })
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
  // Three blocks of whatever range this run takes its networks from, the first three in it.
  const [cellBlock, egressBlock, outsideBlock] = pickSubnets(3, [], labSubnetBase(), 0)
  const subnets = { cell: cellBlock, egress: egressBlock, outside: outsideBlock }
  const options: CellOptions = { nonce: '0badf00d', cellNonce, brainToken: `BRAIN-${cellNonce}-0123456789abcdef`, brainPort: 50001, routePort: 50002, model: 'lab/model', systemPrompt: 'You are Fern. You have no tools.', subnets }

  it('is sealed: one network with no way out, read-only, non-root, one folder of its own, no published port', () => {
    const file = renderCell(options)
    expect(sealProblems(file)).toEqual([])
    const { cell, door } = file.services
    expect(cell.networks).toEqual(['cell'])
    expect(file.networks.cell.internal).toBe(true)
    expect([cell.read_only, cell.user, cell.cap_drop, cell.volumes]).toEqual([true, 'node', ['ALL'], ['lab:/tmp/smlab']])
    // The scratch folder is where the harness is started: in memory, 64 MB, owned by the user the cell runs as.
    expect(cell.tmpfs).toEqual(['/tmp', '/tmp/smlab/work:size=64m,mode=0700,uid=1000,gid=1000'])
    // The cell's own folder is in memory too, with a size: a shell in the cell cannot fill this machine's Docker disk.
    expect(file.volumes.lab).toEqual({ driver: 'local', driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=256m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev' } })
    expect(cell.environment).toMatchObject({ SMLAB_TOOL_SECONDS: '60', SMLAB_TOOL_OUTPUT_BYTES: '16000', SMLAB_VERDICT_MS: '30000', SMLAB_VETO_MS: '35000' })
    expect([cell.pids_limit, cell.mem_limit, cell.cpus]).toEqual([256, '1g', 1])
    expect(Object.keys(cell.environment).sort()).toEqual(CELL_ENV)
    expect(cell.environment.SMLAB_SYSTEM_PROMPT).toBe('You are Fern. You have no tools.')
    expect(door.environment).toEqual({ SMLAB_RELAY: '7801=host.docker.internal:50001,7802=host.docker.internal:50002' })
    expect(JSON.stringify(file)).not.toMatch(/"ports"|docker\.sock|privileged/)
  })

  it('where a tool waits for an admin, the cell is told to wait longer than the door does, so the door is the first to give up', () => {
    const env = (approvalMs?: number) => renderCell({ ...options, approvalMs }).services.cell.environment
    expect([env(120_000).SMLAB_VERDICT_MS, env(120_000).SMLAB_VETO_MS]).toEqual(['130000', '135000'])
    expect([env(600_000).SMLAB_VERDICT_MS, env(600_000).SMLAB_VETO_MS]).toEqual(['610000', '615000'])
    // Never shorter than it was with no tool that asks.
    expect([env(10_000).SMLAB_VERDICT_MS, env(10_000).SMLAB_VETO_MS]).toEqual(['30000', '35000'])
    const limits = { callSeconds: 5, outputBytes: 900, callsPerHour: 3, workspaceMb: 8 }
    const small = renderCell({ ...options, limits }).services.cell
    expect(small.tmpfs[1]).toBe('/tmp/smlab/work:size=8m,mode=0700,uid=1000,gid=1000')
    expect(small.environment).toMatchObject({ SMLAB_TOOL_SECONDS: '5', SMLAB_TOOL_OUTPUT_BYTES: '900' })
    for (const bad of [{ ...limits, workspaceMb: 0 }, { ...limits, callSeconds: 1.5 }, { ...limits, outputBytes: -1 }, { ...limits, workspaceMb: 99_999 }]) {
      expect(() => renderCell({ ...options, limits: bad })).toThrow(/REFUSING TO RUN: F5/)
    }
    expect(() => renderCell({ ...options, approvalMs: 0 })).toThrow(/REFUSING TO RUN: F5/)
  })

  it('every network names a block of its own, so a start does not depend on what Docker\'s pools have left', () => {
    const file = renderCell(options)
    expect(file.networks).toEqual({
      cell: { internal: true, enable_ipv6: false, ipam: { config: [{ subnet: subnets.cell }] } },
      egress: { internal: false, enable_ipv6: false, ipam: { config: [{ subnet: subnets.egress }] } },
    })
    const dry = renderCell({ ...options, withSink: true })
    expect(dry.networks.outside).toEqual({ internal: true, enable_ipv6: false, ipam: { config: [{ subnet: subnets.outside }] } })
    expect(sealProblems(dry)).toEqual([])
    expect(networksWritten(dry)).toEqual({ cell: { internal: true, subnet: subnets.cell }, egress: { internal: false, subnet: subnets.egress }, outside: { internal: true, subnet: subnets.outside } })
    expect(JSON.stringify(dry.networks)).not.toMatch(/gateway|driver|ip_range|aux/)
    // With no blocks handed in, the file names none, and that is not a sealed cell.
    expect(sealProblems(renderCell({ ...options, subnets: undefined as unknown as CellOptions['subnets'] })).join('\n')).toMatch(/network cell does not name one block of its own/)
  })

  it('the images are named for the code they were built from, under the launcher\'s own prefix', () => {
    const images = launcherImages()
    expect(images.cell).toMatch(/^smlabpd-cell:pi-[0-9.]+-[0-9a-f]{12}$/)
    expect(images.rig).toMatch(/^smlabpd-rig:[0-9a-f]{12}$/)
    // The same code as the lab's own rig, so the same hash, but never the same name: cleaning up after a test run cannot remove them.
    const rig = labImages({})
    expect(images.source).toBe(rig.source)
    expect([images.cell, images.rig]).not.toContain(rig.cell)
    expect([images.cell, images.rig]).not.toContain(rig.rig)
    const file = renderCell(options)
    expect([file.services.cell.image, file.services.door.image]).toEqual([images.cell, images.rig])
    // A run is started from the images it was checked against, whatever is on disk by then.
    const pinned = { cell: 'smlabpd-cell:pi-0-000000000000', rig: 'smlabpd-rig:000000000000', source: '000000000000' }
    expect(renderCell({ ...options, images: pinned }).services.cell.image).toBe(pinned.cell)
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
    ['a scratch folder with no size', (f) => { f.services.cell.tmpfs[1] = '/tmp/smlab/work' }, /scratch folder is not a capped mount/],
    ['a scratch folder that is not a mount of its own', (f) => { f.services.cell.tmpfs = ['/tmp'] }, /scratch folder is not a capped mount/],
    ['a scratch folder somewhere else', (f) => { f.services.cell.tmpfs[1] = '/opt/swarm:size=64m,mode=0700,uid=1000,gid=1000' }, /scratch folder is not a capped mount/],
    ['one more place to write', (f) => { f.services.cell.tmpfs.push('/opt/swarm') }, /scratch folder is not a capped mount/],
    ['a credential-shaped variable in the cell', (f) => { f.services.cell.environment.DISCORD_BOT_TOKEN = 'x' }, /not on its list/],
    ['a published port', (f) => { (f.services.cell as unknown as Record<string, unknown>).ports = ['7801:7801'] }, /sets ports/],
    ['a capability handed back', (f) => { f.services.cell.cap_add = ['NET_ADMIN'] }, /sets cap_add/],
    ['a Docker socket for the relay', (f) => { f.services.door.volumes = ['/var/run/docker.sock:/var/run/docker.sock'] }, /Docker socket/],
    ['a relay handed more than its two ports', (f) => { f.services.door.environment.EXTRA = '1' }, /relay is handed/],
    ['a network left to Docker\'s own pools', (f) => { delete (f.networks.cell as unknown as Record<string, unknown>).ipam }, /network cell does not name one block of its own/],
    ['a network on one of Docker\'s own pools', (f) => { f.networks.egress.ipam.config[0].subnet = '172.20.0.0/16' }, /network egress is on 172\.20\.0\.0\/16, which is not a \/28 of /],
    ['two networks on the same block', (f) => { f.networks.egress.ipam.config[0].subnet = f.networks.cell.ipam.config[0].subnet }, /networks cell and egress share addresses/],
    ['a gateway of the file\'s own choosing', (f) => { Object.assign(f.networks.cell.ipam.config[0], { gateway: '10.213.0.1' }) }, /network cell does not name one block of its own/],
    ["a cell folder on Docker's disk", (f) => { f.volumes.lab = {} as never }, /the cell's own folder is not in memory with a size/],
    ['a cell folder with no size', (f) => { f.volumes.lab.driver_opts.o = 'uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev' }, /the cell's own folder is not in memory with a size/],
    ['a network with driver options', (f) => { Object.assign(f.networks.cell, { driver_opts: { 'com.docker.network.bridge.enable_ip_masquerade': 'true' } }) }, /network cell sets driver_opts/],
  ] as [string, (f: ReturnType<typeof renderCell>) => void, RegExp][])('refuses %s', (_name, breakIt, why) => {
    const file = renderCell(options)
    breakIt(file)
    expect(sealProblems(file).join('\n')).toMatch(why)
  })

  it('the two ways of breaking it on purpose are caught as written', () => {
    expect(sealProblems(renderCell({ ...options, broken: 'cell-on-egress' })).join()).toMatch(/the cell is on cell and egress/)
    expect(sealProblems(renderCell({ ...options, broken: 'cell-writable' })).join()).toMatch(/write its own disk/)
    expect(sealProblems(renderCell({ ...options, broken: 'cell-scratch-uncapped' })).join()).toMatch(/scratch folder is not a capped mount/)
    expect(sealProblems(renderCell({ ...options, broken: 'cell-folder-uncapped' })).join()).toMatch(/the cell's own folder is not in memory with a size/)
    // The third is a sealed cell as written, on other blocks than the ones meant for it: only Docker can show that.
    const swapped = renderCell({ ...options, broken: 'cell-other-subnet' })
    expect(sealProblems(swapped)).toEqual([])
    expect(networksWritten(swapped)).toEqual({ cell: { internal: true, subnet: subnets.egress }, egress: { internal: false, subnet: subnets.cell } })
    expect(swapped.services).toEqual(renderCell(options).services)
  })

  it('refuses a nonce or a port that is not one', () => {
    expect(() => renderCell({ ...options, nonce: 'prod' })).toThrow(/REFUSING TO RUN: F5/)
    expect(() => renderCell({ ...options, brainPort: 80 })).toThrow(/REFUSING TO RUN: F5/)
    expect(() => renderCell({ ...options, systemPrompt: '' })).toThrow(/REFUSING TO RUN: F5/)
    expect(() => renderCell({ ...options, systemPrompt: 'x'.repeat(16_001) })).toThrow(/REFUSING TO RUN: F5/)
    // The cell's placeholder must not be something a container name gives away.
    expect(() => renderCell({ ...options, cellNonce: '0badf00d', brainToken: ['BRAIN', '0badf00d', '0123456789abcdef'].join('-') })).toThrow(/REFUSING TO RUN: F5/)
    expect(JSON.stringify(renderCell(options).services.cell)).not.toContain('0badf00d')
  })
})
