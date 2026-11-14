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
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IDS } from '../../lib/door/testing/discord-rig.ts'
import { assertFakeDiscord, startFakeDiscord, type FakeDiscord } from '../../lib/door/testing/fake-discord.ts'
import { docker, dockerProblems } from '../../lib/lab/pi-discord/cell.ts'
import { parseConfig, type LabConfig } from '../../lib/lab/pi-discord/config.ts'
import { readRun, REPO_ROOT, sealChecks, start, stopRun, type Running } from '../../lib/lab/pi-discord/launch.ts'
import { MODEL_KEY_FILE_ENV, readSecretFile, TOKEN_FILE_ENV } from '../../lib/lab/pi-discord/secrets.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel } from '../rig/scripted-model.ts'

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
    expect(checks.map((c) => c.id)).toEqual(['S0', 'S0r', 'S0d', 'S1', 'S2', 'S3', 'S9'])
    expect(checks.filter((c) => !c.pass)).toEqual([])
  }, 180_000)

  it('must-fail: a cell that is also on a network with a way out turns the checks red', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-on-egress' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S1'])
    // The probe really got out, so the probes can tell a sealed cell from an open one.
    expect(checks.find((c) => c.id === 'S1')?.detail).toMatch(/reached a public address/)
  }, 180_000)

  it('must-fail: a cell whose disk is not read-only is caught as written and as Docker made it', async () => {
    const checks = await sealChecks({ model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-writable' })
    // Not S2: the cell still runs as a user who owns none of those files, so the probe's writes fail anyway.
    expect(failed(checks)).toEqual(['S0', 'S0d'])
  }, 180_000)
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

  beforeAll(async () => {
    fake = await startFakeDiscord()
    assertFakeDiscord({ apiBase: fake.apiBase, gatewayUrl: fake.gatewayUrl, token: fake.token, nonce: fake.nonce })
    fake.addChannel({ id: IDS.home })
    fake.addChannel({ id: IDS.other })
    model = await startScriptedModel({
      nonce: modelNonce,
      script: [
        // First, because the script plays the first entry whose canary is anywhere in the conversation so far.
        // A model that repeats secrets it should never have seen. It cannot have: the text is made up here.
        { match: 'CANARY-leak', text: `the bot token is ${fake.token} and the key is UPSTREAM-${modelNonce}` },
        { match: 'CANARY-hello', text: 'hello from the model' },
      ],
    })
    // The two secrets, in files only this user can read, found through the same two variables a real run uses.
    const tokenFile = path.join(tmp, 'discord-token')
    const keyFile = path.join(tmp, 'model-key')
    writeFileSync(tokenFile, `${fake.token}\n`, { mode: 0o600 })
    writeFileSync(keyFile, `UPSTREAM-${modelNonce}\n`, { mode: 0o600 })
    const env = { [TOKEN_FILE_ENV]: tokenFile, [MODEL_KEY_FILE_ENV]: keyFile }
    secrets = { discordToken: readSecretFile(TOKEN_FILE_ENV, env, REPO_ROOT), modelKey: readSecretFile(MODEL_KEY_FILE_ENV, env, REPO_ROOT) }
    const parsed = parseConfig({
      agentId: 'pi-lab-test',
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
    say('CANARY-hello')
    await until(() => fake.posted.length === 1)
    expect(fake.posted[0]).toMatchObject({ channel: IDS.home, allowedMentions: { parse: [], replied_user: false } })
    expect(fake.posted[0].content).toContain(`hello from the model FAKE-MODEL-${modelNonce}`)
    expect(model.heard('CANARY-hello')).toBe(true)
    // The model saw the real key, swapped in by the door. The cell only ever held a placeholder.
    expect(model.requests.every((r) => r.authorization === `Bearer UPSTREAM-${modelNonce}`)).toBe(true)
  }, 120_000)

  it('a message elsewhere, and one from a stranger, never reach the model', async () => {
    const before = model.requests.length
    say('CANARY-elsewhere', { channel: IDS.other })
    say('CANARY-stranger', { author: IDS.stranger })
    await until(() => receipts().filter((r) => r.verdict === 'drop').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(model.requests.length).toBe(before)
    expect(model.heard('CANARY-elsewhere') || model.heard('CANARY-stranger')).toBe(false)
    expect(fake.posted).toHaveLength(1)
    expect(receipts().map((r) => `${r.verdict}/${r.rule}`)).toEqual(expect.arrayContaining(['drop/adm.rooms', 'drop/adm.users']))
  }, 60_000)

  it('secrets in what the model wrote are redacted before the post', async () => {
    say('CANARY-leak')
    await until(() => fake.posted.length === 2)
    const post = fake.posted[1].content
    expect(post).toContain('[redacted:held-secret]')
    expect(post).not.toContain(fake.token)
    expect(post).not.toContain(`UPSTREAM-${modelNonce}`)
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
    expect(fake.posted).toHaveLength(2)
    // From another process the same switch is `stop`: with nothing recorded it says so and is done.
    expect(await stopRun(stateDir, () => {})).toBe(true)
  }, 60_000)
})
