// @vitest-environment node
//
// The real-run launcher, end to end, with nothing real at either edge: a fake
// Discord and a scripted model on this machine's loopback, and real Pi in the
// sealed cell. Not part of the default test run (CI has no Docker). Run with:
//
//   node lib/lab/pi-discord/cli.ts build     (once, and after a pull)
//   npx vitest run --config vitest.docker.config.ts conformance/suites/pi-discord.docker.test.ts
//
// It refuses to start unless the Discord it is pointed at proves it is the
// fake and no real-looking credential is in the environment.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOTICES } from '../../lib/door/door.ts'
import { IDS } from '../../lib/door/testing/discord-rig.ts'
import { assertFakeDiscord, startFakeDiscord, type FakeDiscord } from '../../lib/door/testing/fake-discord.ts'
import { docker, dockerProblems, networksWritten, runningCellProblems, type LiveFile } from '../../lib/lab/pi-discord/cell.ts'
import { connectShim } from '../../lib/door/shim-client.ts'
import { PI_CAPS, PI_REDUCED_TOOL_MAP } from '../../lib/runtimes/pi/caps.ts'
import { parseConfig, type LabConfig } from '../../lib/lab/pi-discord/config.ts'
import { readRun, REPO_ROOT, runFile, sealChecks, start, stopRun, type Running } from '../../lib/lab/pi-discord/launch.ts'
import { MODEL_KEY_FILE_ENV, readSecretFile, TOKEN_FILE_ENV } from '../../lib/lab/pi-discord/secrets.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startScriptedModel, type ScriptEntry, type ScriptedModel } from '../rig/scripted-model.ts'

armTripwire()

const tmp = mkdtempSync(path.join(os.tmpdir(), 'smlab-pi-discord-'))
const failed = (checks: { id: string; pass: boolean }[]): string[] => checks.filter((c) => !c.pass).map((c) => c.id)
const containersOf = (project: string): string[] =>
  docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean)

// It refuses to run, rather than fail slowly, when the launcher's images are missing or out of date.
beforeAll(() => { expect(dockerProblems()).toEqual([]) })

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})

describe('pi-discord dry run: the containment checks', () => {
  it('the cell a real run would start is sealed', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {} })
    expect(checks.map((c) => c.id)).toEqual(['S0', 'S0r', 'S0d', 'S1', 'S2', 'S3', 'S4', 'S9'])
    expect(checks.filter((c) => !c.pass)).toEqual([])
  }, 180_000)

  it('must-fail: a cell that is also on a network with a way out turns the checks red', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-on-egress' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S1'])
    // The probe really got out, so the probes can tell a sealed cell from an open one.
    expect(checks.find((c) => c.id === 'S1')?.detail).toMatch(/reached a public address/)
    // And the cell has what a sealed one never has: a route off its own network.
    expect(checks.find((c) => c.id === 'S1')?.detail).toMatch(/the container has a route off its own network/)
  }, 180_000)

  it('must-fail: a cell whose networks Docker made on other blocks than the ones written for them is caught', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-other-subnet' })
    // As written it is a sealed cell, and it is one: nothing gets out. Only what Docker made differs from what was meant.
    expect(failed(checks)).toEqual(['S0d'])
    const detail = checks.find((c) => c.id === 'S0d')?.detail ?? ''
    expect(detail).toMatch(/network smlab-[0-9a-f]{8}_cell was made on 10\.\d+\.\d+\.\d+\/28, not on 10\.\d+\.\d+\.\d+\/28 as written/)
    expect(detail).toMatch(/network smlab-[0-9a-f]{8}_egress was made on /)
    expect(detail).toMatch(/the cell has the address 10\.\d+\.\d+\.\d+, which is not in the block written for its network/)
  }, 180_000)

  it('must-fail: a cell whose disk is not read-only is caught as written and as Docker made it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-writable' })
    // Not S2: the cell still runs as a user who owns none of those files, so the probe's writes fail anyway.
    expect(failed(checks)).toEqual(['S0', 'S0d'])
  }, 180_000)

  it('must-fail: a cell folder that is a plain Docker volume, on Docker\'s disk with no size, is caught as written, as Docker made it, and by filling it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-folder-uncapped' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S4'])
    expect(checks.find((c) => c.id === 'S4')?.detail).toMatch(/the cell's own folder took \d+ bytes, which is more than its 256 MB/)
  }, 180_000)

  it('must-fail: a scratch folder that is a plain folder with no size of its own is caught as written, as Docker made it, and by filling it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-scratch-uncapped' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S4'])
    expect(checks.find((c) => c.id === 'S4')?.detail).toMatch(/the scratch folder took \d+ bytes, which is more than its 64 MB/)
  }, 180_000)

  it('must-fail: a /tmp with no size, as Docker gives one when asked for nothing more, is caught as written, as Docker made it, from inside, and by filling it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-tmp-uncapped' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S3', 'S4'])
    expect(checks.find((c) => c.id === 'S0d')?.detail).toMatch(/the cell as Docker made it: \/tmp has no size/)
    expect(checks.find((c) => c.id === 'S3')?.detail).toMatch(/inside the container: \/tmp is \d+ MB, more than its 32 MB|inside the container: \/tmp has no size/)
    expect(checks.find((c) => c.id === 'S4')?.detail).toMatch(/the cell's \/tmp took \d+ bytes, which is more than its 32 MB/)
  }, 180_000)
})

describe('pi-discord dry run: the second cell, for the channels with fewer tools', () => {
  it('the second cell a real run would start is sealed, and the door takes it as holding the web, search and notes only', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, role: 'reduced' })
    expect(checks.map((c) => c.id)).toEqual(['S0', 'S0r', 'S0t', 'S0d', 'S1', 'S2', 'S3', 'S4', 'S9'])
    expect(checks.filter((c) => !c.pass)).toEqual([])
  }, 180_000)

  it('must-fail: a second cell started with the shell and the file tools is caught as written, by the door at hello, and as Docker made it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, role: 'reduced', broken: 'reduced-with-shell' })
    expect(failed(checks)).toEqual(['S0', 'S0r', 'S0t', 'S0d'])
    expect(checks.find((c) => c.id === 'S0')?.detail).toMatch(/would hold the shell and the file tools/)
    expect(checks.find((c) => c.id === 'S0t')?.detail).toMatch(/the second cell holds file_read, file_write, shell tools/)
    expect(checks.find((c) => c.id === 'S0d')?.detail).toMatch(/not started to hold only the web, search and notes/)
  }, 180_000)
})

describe('pi-discord: tools, end to end, through real Pi in the sealed cell', () => {
  let fake: FakeDiscord
  let model: ScriptedModel
  let running: Running | undefined
  const stateDir = path.join(tmp, 'state-tools')
  const nonce = randomBytes(4).toString('hex')
  const script: ScriptEntry[] = []
  const WORK = '/tmp/smlab/work'

  beforeAll(async () => {
    fake = await startFakeDiscord()
    assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce })
    fake.addChannel({ id: IDS.home })
    model = await startScriptedModel({ nonce, script })
    const tokenFile = path.join(tmp, 'tools-discord-token')
    const keyFile = path.join(tmp, 'tools-model-key')
    writeFileSync(tokenFile, `${fake.token}\n`, { mode: 0o600 })
    writeFileSync(keyFile, `UPSTREAM-${nonce}\n`, { mode: 0o600 })
    const env = { [TOKEN_FILE_ENV]: tokenFile, [MODEL_KEY_FILE_ENV]: keyFile }
    const parsed = parseConfig({
      agentId: 'pi-lab-tools',
      discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member] },
      budget: { monthlyUsd: 5 },
      // Shell asks an admin, and so, by default, does writing a file. Reading is allowed.
      tools: { enabled: ['shell', 'file_read', 'file_write'], approvalSeconds: 60 },
      model: { baseUrl: model.baseUrl, id: 'scripted', usdPerMTokIn: 1, usdPerMTokOut: 2 },
    }, { allowLoopbackModel: true })
    expect(parsed.errors).toEqual([])
    const secrets = { discordToken: readSecretFile(TOKEN_FILE_ENV, env, REPO_ROOT), modelKey: readSecretFile(MODEL_KEY_FILE_ENV, env, REPO_ROOT) }
    running = await start({ config: parsed.config!, secrets, stateDir, log: () => {}, discord: { apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl } })
  }, 180_000)

  afterAll(async () => {
    await running?.stop()
    await model?.close()
    await fake?.close()
  }, 60_000)

  const say = (text: string): string => fake.post({ channel: IDS.home, guild: IDS.guild, author: { id: IDS.member }, content: `<@${fake.selfId}> ${text}`, mentions: [fake.selfId] })
  const until = async (what: () => boolean, ms = 90_000): Promise<void> => {
    const end = Date.now() + ms
    while (!what() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(what()).toBe(true)
  }
  const inCell = (command: string): string => docker(['exec', `${readRun(stateDir)!.project}-cell-1`, 'sh', '-c', command]).out
  const receipts = (): { verdict: string; rule: string; event: { kind: string; sender?: string } }[] =>
    readFileSync(path.join(stateDir, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // What tools handed back to the model: the tool results in the last request it was sent, which holds the whole conversation.
  const toolResults = (): string[] => (JSON.parse(model.requests.at(-1)!.body) as { messages: { role: string; content: unknown }[] }).messages
    .filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content))

  it('the model is offered the tools the rules switch on, and is told the truth about them', async () => {
    script.push({ match: 'CANARY-hello', text: 'hello' })
    say('CANARY-hello')
    await until(() => fake.posted.length === 1)
    const first = JSON.parse(model.requests[0].body) as { messages: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] }
    expect((first.tools ?? []).map((t) => t.function?.name).sort()).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
    const system = JSON.stringify(first.messages.filter((m) => m.role === 'system' || m.role === 'developer'))
    expect(system).toContain('You also have tools')
    expect(system).toContain('an admin is shown exactly what you asked for')
    // Discord was asked for reactions, because a class of tool asks.
    expect(fake.identifies[0].intents & (1 << 10)).toBe(1 << 10)
  }, 120_000)

  it('a shell command waits in the channel for an admin, and runs in the capped scratch folder only after the admin\'s tick', async () => {
    const command = `printf '%s%s\\n' RAN- ${nonce} > made.txt`
    script.unshift({ match: 'CANARY-shell', tools: [{ name: 'bash', args: { command } }], text: 'ran it' })
    const asked = say('CANARY-shell')
    await until(() => fake.posted.length === 2)
    const request = fake.posted[1]
    expect(request).toMatchObject({ channel: IDS.home, replyTo: asked, allowedMentions: { parse: [], replied_user: false } })
    expect(request.content.split('\n')[0]).toBe('Approval needed. The agent wants to run bash:')
    // What is shown is the whole call: the command, and the time limit the gate put on it.
    expect(JSON.parse(request.content.split('\n')[2])).toEqual({ command, timeout: 60 })
    expect(request.content).toContain('No answer in 60 seconds means no.')
    const on = { channel: IDS.home, guild: IDS.guild, messageId: request.id }
    // The person who asked, and a stranger, tick it. Nothing runs.
    fake.react({ ...on, author: { id: IDS.member }, emoji: '✅' })
    fake.react({ ...on, author: { id: IDS.stranger }, emoji: '✅' })
    await until(() => receipts().filter((r) => r.event.kind === 'approval' && r.verdict === 'deny').length === 2, 15_000)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(inCell(`ls ${WORK}; echo LISTED`)).not.toContain('made.txt')
    // The admin ticks it.
    fake.react({ ...on, author: { id: IDS.admin }, emoji: '✅' })
    await until(() => fake.posted.length === 3)
    expect(inCell(`cat ${WORK}/made.txt`).trim()).toBe(`RAN-${nonce}`)
    expect(fake.posted[2].content).toContain('ran it')
    expect(receipts().filter((r) => r.rule === 'priv.approval').map((r) => `${r.event.kind}:${r.verdict}`)).toEqual(['tool:ask', 'approval:deny', 'approval:deny', 'approval:allow', 'tool:allow'])
    // Where it ran: a mount in memory with a size of its own, in a cell whose disk is still read-only.
    expect(inCell(`df -k ${WORK} | tail -1`)).toMatch(/^tmpfs\s+65536\s/)
    expect(inCell('touch /opt/swarm/x 2>&1; touch /home/node/x 2>&1; echo TRIED')).toMatch(/Read-only file system[\s\S]*Read-only file system[\s\S]*TRIED/)
  }, 180_000)

  it('file tools work inside the scratch folder and are refused outside it, and a write waits for the admin as the shell does', async () => {
    const posts = fake.posted.length
    script.unshift({
      match: 'CANARY-files', text: 'filed',
      tools: [
        { name: 'write', args: { path: 'notes.txt', content: `kept ${nonce}` } },
        { name: 'read', args: { path: 'made.txt' } },
        { name: 'read', args: { path: '../agent/models.json' } },
        { name: 'read', args: { path: '/opt/swarm/lib/door/protocol.ts' } },
        { name: 'write', args: { path: '../planted.txt', content: 'planted' } },
        { name: 'ls', args: { path: '/tmp/smlab' } },
      ],
    })
    say('CANARY-files')
    // The write inside the folder is put to the admin, with what it would write. The one outside is refused before anyone is asked.
    await until(() => fake.posted.length === posts + 1)
    const request = fake.posted[posts]
    expect(request.content.split('\n')[0]).toBe('Approval needed. The agent wants to run write:')
    expect(JSON.parse(request.content.split('\n')[2])).toEqual({ path: `${WORK}/notes.txt`, content: `kept ${nonce}` })
    fake.react({ channel: IDS.home, guild: IDS.guild, messageId: request.id, author: { id: IDS.admin }, emoji: '✅' })
    await until(() => fake.posted.length === posts + 2)
    expect(fake.posted.at(-1)?.content).toContain('filed')
    expect(inCell(`cat ${WORK}/notes.txt`)).toBe(`kept ${nonce}`)
    expect(inCell('ls /tmp/smlab; echo LISTED')).not.toContain('planted.txt')
    const results = toolResults()
    // What the shell wrote before, read back by the file tool.
    expect(results.some((r) => r.includes(`RAN-${nonce}`))).toBe(true)
    // The cell's own stand-in for a key is in a file outside the scratch folder. A file tool does not get it.
    expect(results.some((r) => r.includes('PLACEHOLDER-') || r.includes('ToShim') || r.includes('sessions'))).toBe(false)
    expect(results.filter((r) => r.includes('the path is outside the scratch folder'))).toHaveLength(4)
    // One request was posted, for the one write that stayed inside the folder. Reading and listing ask nobody.
    expect(fake.posted.slice(posts).filter((p) => p.content.startsWith('Approval needed.'))).toHaveLength(1)
  }, 180_000)

  it('a model call the provider refuses is not silent: the channel is told why, and a receipt says so', async () => {
    script.unshift({ match: 'CANARY-refused', text: 'never said', status: 400 })
    const before = fake.posted.length
    const asked = say('CANARY-refused')
    await until(() => fake.posted.length === before + 1)
    expect(fake.posted.at(-1)).toMatchObject({ channel: IDS.home, replyTo: asked, content: NOTICES.failed('The model provider refused the call (status 400).') })
    expect(receipts().some((r) => r.event.kind === 'model' && r.verdict === 'deny' && r.rule === 'model.provider')).toBe(true)
  }, 120_000)

  it('stopping the agent takes the scratch folder with it', async () => {
    const project = readRun(stateDir)!.project
    await running!.stop()
    running = undefined
    expect(containersOf(project)).toEqual([])
    expect(docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']).out.trim()).toBe('')
  }, 60_000)
})

describe('pi-discord: one message, end to end, through real Pi in the sealed cell', () => {
  let fake: FakeDiscord
  let model: ScriptedModel
  let running: Running | undefined
  let config: LabConfig
  let secrets: { discordToken: string; modelKey: string }
  const stateDir = path.join(tmp, 'state')
  const modelNonce = randomBytes(4).toString('hex')
  const logs: string[] = []
  // First, because the script plays the first entry whose canary is anywhere in the conversation so far.
  // A test adds its own entry at the front.
  const script: ScriptEntry[] = []

  beforeAll(async () => {
    fake = await startFakeDiscord()
    assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce })
    fake.addChannel({ id: IDS.home })
    fake.addChannel({ id: IDS.other })
    model = await startScriptedModel({
      nonce: modelNonce,
      script,
    })
    script.push(
      // A model that repeats secrets it should never have seen. It cannot have: the text is made up here.
      { match: 'CANARY-leak', text: `the bot token is ${fake.token} and the key is UPSTREAM-${modelNonce}` },
      { match: 'CANARY-hello', text: 'hello from the model' },
    )
    // The two secrets, in files only this user can read, found through the same two variables a real run uses.
    const tokenFile = path.join(tmp, 'discord-token')
    const keyFile = path.join(tmp, 'model-key')
    writeFileSync(tokenFile, `${fake.token}\n`, { mode: 0o600 })
    writeFileSync(keyFile, `UPSTREAM-${modelNonce}\n`, { mode: 0o600 })
    const env = { [TOKEN_FILE_ENV]: tokenFile, [MODEL_KEY_FILE_ENV]: keyFile }
    secrets = { discordToken: readSecretFile(TOKEN_FILE_ENV, env, REPO_ROOT), modelKey: readSecretFile(MODEL_KEY_FILE_ENV, env, REPO_ROOT) }
    const parsed = parseConfig({
      agentId: 'pi-lab-test',
      persona: { name: 'Fern', description: 'You keep answers short.' },
      discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member] },
      budget: { monthlyUsd: 5 },
      model: { baseUrl: model.baseUrl, id: 'scripted', usdPerMTokIn: 1, usdPerMTokOut: 2 },
    }, { allowLoopbackModel: true })
    expect(parsed.errors).toEqual([])
    config = parsed.config!
    running = await start({ config, secrets, stateDir, log: (l) => logs.push(l), discord: { apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl } })
  }, 180_000)

  afterAll(async () => {
    await running?.stop()
    await model?.close()
    await fake?.close()
  }, 60_000)

  const say = (text: string, o: { channel?: string; author?: string } = {}): string => fake.post({
    channel: o.channel ?? IDS.home, guild: IDS.guild, author: { id: o.author ?? IDS.member },
    content: `<@${fake.selfId}> ${text}`, mentions: [fake.selfId],
  })
  const until = async (what: () => boolean, ms = 90_000): Promise<void> => {
    const end = Date.now() + ms
    while (!what() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(what()).toBe(true)
  }
  const receipts = (): { verdict: string; rule: string; event: { kind: string } }[] =>
    readFileSync(path.join(stateDir, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

  it('a mention in the allowed channel reaches the model through Pi, and the reply is posted there', async () => {
    const asked = say('CANARY-hello')
    await until(() => fake.posted.length === 1)
    // The launcher starts the door with status on, as the config leaves it: 👀 and typing, then ✅ once answered.
    await until(() => fake.reactionsOn(asked).join() === '✅', 10_000)
    expect(fake.status.some((c) => c.what === 'typing' && c.channel === IDS.home)).toBe(true)
    expect(fake.posted[0]).toMatchObject({ channel: IDS.home, allowedMentions: { parse: [], replied_user: false } })
    expect(fake.posted[0].content).toContain(`hello from the model FAKE-MODEL-${modelNonce}`)
    expect(model.heard('CANARY-hello')).toBe(true)
    // The model saw the real key, swapped in by the door. The cell only ever held a placeholder.
    expect(model.requests.every((r) => r.authorization === `Bearer UPSTREAM-${modelNonce}`)).toBe(true)
    // What Pi told the model it is: the persona and the truth about its tools, in place of Pi's own introduction.
    const first = JSON.parse(model.requests[0].body) as { messages: { role: string; content: unknown }[]; tools?: unknown[] }
    const system = JSON.stringify(first.messages.filter((m) => m.role === 'system' || m.role === 'developer'))
    expect(system).toContain('You are Fern, a chat assistant in one Discord channel. You keep answers short.')
    expect(system).toContain('You have no tools')
    expect(system).not.toMatch(/coding assistant|coding agent/i)
    // And the model is offered no tool to ask for.
    expect(first.tools ?? []).toEqual([])
  }, 120_000)

  it('a message elsewhere, and one from a stranger, never reach the model', async () => {
    const before = model.requests.length
    const elsewhere = say('CANARY-elsewhere', { channel: IDS.other })
    const stranger = say('CANARY-stranger', { author: IDS.stranger })
    await until(() => receipts().filter((r) => r.verdict === 'drop').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(model.requests.length).toBe(before)
    expect(model.heard('CANARY-elsewhere') || model.heard('CANARY-stranger')).toBe(false)
    expect(fake.posted).toHaveLength(1)
    expect(receipts().map((r) => `${r.verdict}/${r.rule}`)).toEqual(expect.arrayContaining(['drop/adm.rooms', 'drop/adm.users']))
    // Nothing is shown on a message the agent did not take.
    expect([...fake.reactionsOn(elsewhere), ...fake.reactionsOn(stranger)]).toEqual([])
    expect(fake.status.some((c) => c.channel === IDS.other)).toBe(false)
  }, 60_000)

  it('secrets in what the model wrote are redacted before the post', async () => {
    say('CANARY-leak')
    await until(() => fake.posted.length === 2)
    const post = fake.posted[1].content
    expect(post).toContain('[redacted:held-secret]')
    expect(post).not.toContain(fake.token)
    expect(post).not.toContain(`UPSTREAM-${modelNonce}`)
  }, 120_000)

  it('what the cell itself holds is redacted too: its token for the door and its stand-in for a key', async () => {
    const env = (JSON.parse(readFileSync(path.join(stateDir, 'compose.json'), 'utf8')) as { services: { cell: { environment: Record<string, string> } } }).services.cell.environment
    const held = [env.SWARMLAB_BRAIN, `PLACEHOLDER-${env.SWARMLAB_NONCE}`]
    expect(held.every((s) => s.length > 30)).toBe(true)
    script.unshift({ match: 'CANARY-cell', text: `my token is ${held[0]} and my key is ${held[1]}` })
    say('CANARY-cell')
    await until(() => fake.posted.length === 3)
    expect(fake.posted[2].content).toContain('[redacted:held-secret]')
    for (const s of [...held, env.SWARMLAB_NONCE]) expect(fake.posted[2].content).not.toContain(s)
  }, 120_000)

  it('a model that asks for a tool is offered none, and nothing runs in the cell', async () => {
    const mark = `RAN-${modelNonce}`
    script.unshift({ match: 'CANARY-tool', tool: { name: 'bash', args: { command: `touch /tmp/smlab/work/${mark}` } }, text: 'all done' })
    say('CANARY-tool')
    await until(() => fake.posted.length === 4)
    const project = readRun(stateDir)!.project
    const files = docker(['exec', `${project}-cell-1`, 'sh', '-c', 'find /tmp/smlab /tmp -name "RAN-*" 2>/dev/null; echo LISTED'])
    expect(files.out).toContain('LISTED')
    expect(files.out).not.toContain(mark)
    expect(receipts().filter((r) => r.event.kind === 'tool' && r.verdict === 'allow')).toEqual([])
    for (const r of model.requests) expect((JSON.parse(r.body) as { tools?: unknown[] }).tools ?? []).toEqual([])
  }, 120_000)

  it('neither secret is in the cell, the relay, the compose file, the receipts or the log', () => {
    const run = readRun(stateDir)!
    for (const service of ['cell', 'door']) {
      const inspected = docker(['inspect', `${run.project}-${service}-1`]).out
      expect(inspected.length).toBeGreaterThan(1000)
      for (const secret of Object.values(secrets)) expect(inspected).not.toContain(secret)
    }
    const written = [readFileSync(path.join(stateDir, 'compose.json'), 'utf8'), readFileSync(path.join(stateDir, 'receipts.jsonl'), 'utf8'), readFileSync(path.join(stateDir, 'run.json'), 'utf8'), logs.join('\n')].join('\n')
    for (const secret of Object.values(secrets)) expect(written).not.toContain(secret)
    expect(written).not.toContain('CANARY')
    // Spend was put on the books, on this machine, outside the cell.
    const spent = JSON.parse(readFileSync(path.join(stateDir, 'spend.json'), 'utf8')) as { months: Record<string, number> }
    expect(Object.values(spent.months)[0]).toBeGreaterThan(0)
  })

  it('a second start is refused while this one runs', async () => {
    await expect(start({ config, secrets, stateDir, log: () => {}, discord: { apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl } })).rejects.toThrow(/already running/)
    expect(containersOf(readRun(stateDir)!.project)).toHaveLength(2)
  })

  it('the kill switch stops the door and removes the cell, and nothing is heard after it', async () => {
    const project = readRun(stateDir)!.project
    expect(containersOf(project)).toHaveLength(2)
    await running!.stop()
    running = undefined
    expect(containersOf(project)).toEqual([])
    expect(readRun(stateDir)).toBeUndefined()
    await until(() => fake.connections() === 0, 3000)
    const before = model.requests.length
    say('CANARY-after-stop')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(model.requests.length).toBe(before)
    expect(fake.posted).toHaveLength(4)
    // From another process the same switch is `stop`: with nothing recorded it says so and is done.
    expect(await stopRun(stateDir, () => {})).toBe(true)
  }, 60_000)

  it('if the cell dies the door answers nobody; if the door dies its cell stays sealed and silent, and the next start removes it', async () => {
    const said: string[] = []
    const again = (o: { redialCell?: boolean } = {}): Promise<Running> => start({ config, secrets, stateDir, log: (l) => said.push(l), discord: { apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl }, ...o })
    // A cell that has to be started again after the door is up: the harder way, where it had reached the door, so
    // the door still holds its link when it is stopped. The cell that comes back is the same sealed cell, the door
    // takes it, and it answers.
    const first = await again({ redialCell: true })
    expect(said.filter((l) => l.includes('started again'))).toHaveLength(1)
    expect(said.at(-1)).toMatch(/^live: agent pi-lab-test, policy [0-9a-f]{12}, one channel$/)
    expect(runningCellProblems(readRun(stateDir)!.project, networksWritten(JSON.parse(readFileSync(path.join(stateDir, 'compose.json'), 'utf8')) as LiveFile))).toEqual([])
    const heardBefore = fake.posted.length
    say('CANARY-hello')
    await until(() => fake.posted.length === heardBefore + 1)
    const left = readRun(stateDir)!.project
    const posts = fake.posted.length
    const asked = model.requests.length

    // The cell dies. The door is still connected to Discord, and says nothing.
    expect(docker(['kill', `${left}-cell-1`]).ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    say('CANARY-no-cell')
    await until(() => receipts().some((r) => r.rule === 'turn.no-harness'), 15_000)
    expect(fake.posted).toHaveLength(posts)
    expect(model.requests).toHaveLength(asked)

    // The door dies without cleaning up: a run is still on record, under a pid that is gone, and its containers are still there.
    await first.door.close()
    const dead = spawnSync(process.execPath, ['-e', '']).pid as number
    writeFileSync(runFile(stateDir), JSON.stringify({ ...readRun(stateDir)!, pid: dead }))
    expect(containersOf(left)).toHaveLength(2)
    // What Docker gave that cell has not changed: one network with no way out, no host folder, no secret.
    const written = networksWritten(JSON.parse(readFileSync(path.join(stateDir, 'compose.json'), 'utf8')) as LiveFile)
    expect(Object.keys(written)).toEqual(['cell', 'egress'])
    expect(runningCellProblems(left, written).filter((p) => p !== 'the cell is not running')).toEqual([])
    say('CANARY-no-door')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(fake.posted).toHaveLength(posts)

    // The next start takes the place of the dead run, and takes its cell down first.
    running = await again()
    expect(readRun(stateDir)!.project).not.toBe(left)
    expect(containersOf(left)).toEqual([])
    expect(containersOf(readRun(stateDir)!.project)).toHaveLength(2)
    await running.stop()
    running = undefined
    await first.stop()
  }, 240_000)
})

describe('pi-discord: two cells, end to end: the agent\'s own, and a second for a channel with fewer tools', () => {
  let fake: FakeDiscord
  let model: ScriptedModel
  let running: Running | undefined
  const stateDir = path.join(tmp, 'state-two-cells')
  const nonce = randomBytes(4).toString('hex')
  const script: ScriptEntry[] = []

  beforeAll(async () => {
    fake = await startFakeDiscord()
    assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce })
    fake.addChannel({ id: IDS.home })
    fake.addChannel({ id: IDS.other })
    model = await startScriptedModel({ nonce, script })
    const tokenFile = path.join(tmp, 'two-discord-token')
    const keyFile = path.join(tmp, 'two-model-key')
    writeFileSync(tokenFile, `${fake.token}\n`, { mode: 0o600 })
    writeFileSync(keyFile, `UPSTREAM-${nonce}\n`, { mode: 0o600 })
    const env = { [TOKEN_FILE_ENV]: tokenFile, [MODEL_KEY_FILE_ENV]: keyFile }
    const parsed = parseConfig({
      agentId: 'pi-lab-two',
      discord: {
        guildId: IDS.guild, channelIds: [IDS.home, IDS.other], adminUserIds: [IDS.admin], allowedUserIds: [IDS.member],
        perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'web-only' } },
      },
      budget: { monthlyUsd: 5 },
      tools: { enabled: ['shell', 'file_read'], approvalSeconds: 60 },
      model: { baseUrl: model.baseUrl, id: 'scripted', usdPerMTokIn: 1, usdPerMTokOut: 2 },
    }, { allowLoopbackModel: true })
    expect(parsed.errors).toEqual([])
    const secrets = { discordToken: readSecretFile(TOKEN_FILE_ENV, env, REPO_ROOT), modelKey: readSecretFile(MODEL_KEY_FILE_ENV, env, REPO_ROOT) }
    running = await start({ config: parsed.config!, secrets, stateDir, log: () => {}, discord: { apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl } })
  }, 240_000)

  afterAll(async () => {
    const run = readRun(stateDir)
    await running?.stop()
    // Both cells are gone, whatever was done to the second below.
    if (run) expect([...containersOf(run.project), ...containersOf(run.reducedProject ?? 'smlab-00000000')]).toEqual([])
    await model?.close()
    await fake?.close()
  }, 60_000)

  const say = (channel: string, author: string, text: string): string =>
    fake.post({ channel, guild: IDS.guild, author: { id: author }, content: `<@${fake.selfId}> ${text}`, mentions: [fake.selfId] })
  const until = async (what: () => boolean, ms = 90_000): Promise<void> => {
    const end = Date.now() + ms
    while (!what() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(what()).toBe(true)
  }
  const receipts = (): { verdict: string; rule: string; event: { kind: string; turnId?: string; room?: string } }[] =>
    readFileSync(path.join(stateDir, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const inCell = (project: string, command: string): string => docker(['exec', `${project}-cell-1`, 'sh', '-c', command]).out

  it('two cells are up and sealed, each as written: the second is on its own networks and told to hold fewer tools', () => {
    const run = readRun(stateDir)!
    expect(run.reducedProject).toMatch(/^smlab-[0-9a-f]{8}$/)
    expect(run.reducedProject).not.toBe(run.project)
    expect(running!.reducedProject).toBe(run.reducedProject)
    const own = JSON.parse(readFileSync(path.join(stateDir, 'compose.json'), 'utf8')) as LiveFile
    const second = JSON.parse(readFileSync(path.join(stateDir, 'compose-reduced.json'), 'utf8')) as LiveFile
    expect(runningCellProblems(run.project, networksWritten(own))).toEqual([])
    expect(runningCellProblems(run.reducedProject!, networksWritten(second), 'reduced')).toEqual([])
    // The two cells share no network and no folder.
    expect(Object.values(second.networks).map((n) => n.ipam.config[0].subnet)).not.toContain(own.networks.cell.ipam.config[0].subnet)
  })

  it('a turn from the channel with fewer tools runs in the second cell, offered no shell or file tool; one from the agent\'s own runs in its own', async () => {
    const run = readRun(stateDir)!
    script.push({ match: 'CANARY-public', text: 'hello from the second cell' })
    script.push({ match: 'CANARY-own', text: 'hello from the own cell' })
    say(IDS.other, IDS.stranger, 'CANARY-public')
    await until(() => fake.posted.length === 1)
    expect(fake.posted[0]).toMatchObject({ channel: IDS.other })
    const asked = JSON.parse(model.requests.at(-1)!.body) as { tools?: { function?: { name?: string } }[] }
    expect((asked.tools ?? []).map((t) => t.function?.name)).not.toEqual(expect.arrayContaining(['bash']))
    expect((asked.tools ?? []).map((t) => t.function?.name).filter((n) => ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'].includes(n ?? ''))).toEqual([])
    // Pi kept its session in the second cell, and the own cell has none yet.
    expect(inCell(run.reducedProject!, 'ls /tmp/smlab/sessions; echo LISTED').replace('LISTED', '').trim()).not.toBe('')
    expect(inCell(run.project, 'ls /tmp/smlab/sessions; echo LISTED').replace('LISTED', '').trim()).toBe('')
    say(IDS.home, IDS.member, 'CANARY-own')
    await until(() => fake.posted.length === 2)
    expect(fake.posted[1]).toMatchObject({ channel: IDS.home })
    expect(inCell(run.project, 'ls /tmp/smlab/sessions; echo LISTED').replace('LISTED', '').trim()).not.toBe('')
  }, 180_000)

  it('must-fail: a call filed by the second cell under a live turn of the agent\'s own cell is refused, and the turn goes on', async () => {
    const run = readRun(stateDir)!
    // The second cell is stopped, and a client with its token, on the door's port for it, plays a second cell that knows an own turn's id.
    expect(docker(['stop', '-t', '1', `${run.reducedProject}-cell-1`]).ok).toBe(true)
    const second = JSON.parse(readFileSync(path.join(stateDir, 'compose-reduced.json'), 'utf8')) as LiveFile
    const token = second.services.cell.environment.SWARMLAB_BRAIN
    let forger: Awaited<ReturnType<typeof connectShim>> | undefined
    const end = Date.now() + 15_000
    // The door lets the stopped cell's link go first; until then a second hello is turned away.
    while (!forger && Date.now() < end) {
      const c = await connectShim({ host: '127.0.0.1', port: running!.door.reducedPort!, token, caps: { ...PI_CAPS, toolMap: PI_REDUCED_TOOL_MAP }, verdictTimeoutMs: 5000 }).catch(() => undefined)
      if (c && await Promise.race([running!.door.reducedConnected!().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000))])) forger = c
      else { c?.close(); await new Promise((resolve) => setTimeout(resolve, 300)) }
    }
    expect(forger).toBeDefined()
    try {
      // The own cell's turn waits for an admin on a shell call, so it is live.
      script.unshift({ match: 'CANARY-held', tools: [{ name: 'bash', args: { command: 'ls' } }], text: 'listed' })
      const posts = fake.posted.length
      say(IDS.home, IDS.member, 'CANARY-held')
      await until(() => fake.posted.length === posts + 1)
      const turnId = receipts().filter((r) => r.event.kind === 'tool' && r.rule === 'priv.approval' && r.event.room === IDS.home).at(-1)?.event.turnId
      expect(turnId).toMatch(/^[0-9a-f-]{36}$/)
      const answer = await forger!.requestTool(turnId!, 'web_fetch', { url: 'https://example.org/' })
      expect(answer).toMatchObject({ allow: false, reason: 'not a turn of this cell' })
      forger!.send({ t: 'reply', turnId: turnId!, text: 'forged', attachments: [] })
      forger!.send({ t: 'settled', turnId: turnId! })
      await until(() => receipts().filter((r) => r.rule === 'turn.cell').length === 3, 10_000)
      expect(fake.posted.map((p) => p.content)).not.toContain('forged')
      // Positive control: the admin's tick still runs the call in the own cell, and its reply is posted.
      fake.react({ channel: IDS.home, guild: IDS.guild, messageId: fake.posted[posts].id, author: { id: IDS.admin }, emoji: '✅' })
      await until(() => fake.posted.length === posts + 2)
      expect(fake.posted.at(-1)?.content).toContain('listed')
    } finally { forger?.close() }
  }, 180_000)
})
