// @vitest-environment node
//
// The real-run launcher with Letta Code as its harness, end to end, with
// nothing real at either edge: a fake Discord and a scripted model on this
// machine's loopback, and real Letta Code in the sealed cell. It is the Pi
// suite (pi-discord.docker.test.ts) with `harness: 'letta-code'` in the
// config, plus what is Letta Code's own: it is given one room and no other.
// Not part of the default test run (CI has no Docker). Run with:
//
//   node lib/lab/pi-discord/cli.ts build --harness letta-code     (once, and after a pull)
//   npx vitest run --config vitest.docker.config.ts conformance/suites/letta-code-discord.docker.test.ts
//
// It refuses to start unless the Discord it is pointed at proves it is the
// fake and no real-looking credential is in the environment.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IDS } from '../../lib/door/testing/discord-rig.ts'
import { assertFakeDiscord, startFakeDiscord, type FakeDiscord } from '../../lib/door/testing/fake-discord.ts'
import { docker, dockerProblems, launcherImages, networksWritten, runningCellProblems, type LiveFile } from '../../lib/lab/pi-discord/cell.ts'
import { harnessOf, parseConfig, policyFor, type LabConfig } from '../../lib/lab/pi-discord/config.ts'
import { readRun, REPO_ROOT, runFile, sealChecks, start, stopRun, type Running } from '../../lib/lab/pi-discord/launch.ts'
import { MODEL_KEY_FILE_ENV, readSecretFile, TOKEN_FILE_ENV } from '../../lib/lab/pi-discord/secrets.ts'
import { LETTA_CODE_VERSION } from '../../lib/runtimes/letta-code/caps.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startScriptedModel, type ScriptEntry, type ScriptedModel } from '../rig/scripted-model.ts'

armTripwire()

const HARNESS = 'letta-code'
const tmp = mkdtempSync(path.join(os.tmpdir(), 'smlab-letta-code-discord-'))
const failed = (checks: { id: string; pass: boolean }[]): string[] => checks.filter((c) => !c.pass).map((c) => c.id)
const containersOf = (project: string): string[] =>
  docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean)

// It refuses to run, rather than fail slowly, when the launcher's images are missing or out of date.
beforeAll(() => { expect(dockerProblems(launcherImages(HARNESS), HARNESS)).toEqual([]) })

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})

describe('letta-code in the launcher, dry run: the containment checks', () => {
  it('the cell a real run would start is sealed', async () => {
    const checks = await sealChecks({ harness: HARNESS, model: 'lab/model', workDir: tmp, log: () => {} })
    expect(checks.map((c) => c.id)).toEqual(['S0', 'S0r', 'S0d', 'S1', 'S2', 'S3', 'S9'])
    expect(checks.filter((c) => !c.pass)).toEqual([])
    // The cell that was checked is Letta Code's, and the check that names the harness says so.
    expect(checks.find((c) => c.id === 'S2')?.title).toBe('the shim, the gate and Letta Code cannot be changed from inside the cell')
  }, 180_000)

  it('must-fail: a cell that is also on a network with a way out turns the checks red', async () => {
    const checks = await sealChecks({ harness: HARNESS, model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-on-egress' })
    expect(failed(checks)).toEqual(['S0', 'S0d', 'S1'])
    // The probe really got out, so the probes can tell a sealed cell from an open one.
    expect(checks.find((c) => c.id === 'S1')?.detail).toMatch(/reached a public address/)
    // And the cell has what a sealed one never has: a route off its own network.
    expect(checks.find((c) => c.id === 'S1')?.detail).toMatch(/the container has a route off its own network/)
  }, 180_000)

  it('must-fail: a cell whose networks Docker made on other blocks than the ones written for them is caught', async () => {
    const checks = await sealChecks({ harness: HARNESS, model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-other-subnet' })
    // As written it is a sealed cell, and it is one: nothing gets out. Only what Docker made differs from what was meant.
    expect(failed(checks)).toEqual(['S0d'])
    const detail = checks.find((c) => c.id === 'S0d')?.detail ?? ''
    expect(detail).toMatch(/network smlab-[0-9a-f]{8}_cell was made on 10\.\d+\.\d+\.\d+\/28, not on 10\.\d+\.\d+\.\d+\/28 as written/)
    expect(detail).toMatch(/network smlab-[0-9a-f]{8}_egress was made on /)
    expect(detail).toMatch(/the cell has the address 10\.\d+\.\d+\.\d+, which is not in the block written for its network/)
  }, 180_000)

  it('must-fail: a cell whose disk is not read-only is caught as written and as Docker made it', async () => {
    const checks = await sealChecks({ harness: HARNESS, model: 'lab/model', workDir: tmp, log: () => {}, broken: 'cell-writable' })
    // Not S2: the cell still runs as a user who owns none of those files, so the probe's writes fail anyway.
    expect(failed(checks)).toEqual(['S0', 'S0d'])
  }, 180_000)
})

describe('letta-code in the launcher: one message, end to end, through real Letta Code in the sealed cell', () => {
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
      agentId: 'lc-lab-test',
      harness: HARNESS,
      persona: { name: 'Fern', description: 'You keep answers short.' },
      discord: { guildId: IDS.guild, channelId: IDS.home, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member] },
      budget: { monthlyUsd: 5 },
      // Not the name a cell asks for when it is told none: the model's name has to reach Letta Code from the config.
      model: { baseUrl: model.baseUrl, id: 'lab/model-a', usdPerMTokIn: 1, usdPerMTokOut: 2 },
    }, { allowLoopbackModel: true })
    expect(parsed.errors).toEqual([])
    config = parsed.config!
    expect(harnessOf(config)).toBe(HARNESS)
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

  it('a mention in the allowed channel reaches the model through Letta Code, and the reply is posted there', async () => {
    say('CANARY-hello')
    await until(() => fake.posted.length === 1)
    expect(fake.posted[0]).toMatchObject({ channel: IDS.home, allowedMentions: { parse: [], replied_user: false } })
    expect(fake.posted[0].content).toContain(`hello from the model FAKE-MODEL-${modelNonce}`)
    expect(model.heard('CANARY-hello')).toBe(true)
    // The model saw the real key, swapped in by the door. The cell only ever held a placeholder.
    expect(model.requests.every((r) => r.authorization === `Bearer UPSTREAM-${modelNonce}`)).toBe(true)
    // The cell that is running is Letta Code's, of the pinned version, and the log says which harness is live.
    const project = readRun(stateDir)!.project
    expect(docker(['inspect', '--format', '{{.Config.Image}}', `${project}-cell-1`]).out.trim()).toBe(launcherImages(HARNESS).cell)
    expect(docker(['exec', `${project}-cell-1`, 'env', 'HOME=/tmp/smlab/home', 'DISABLE_AUTOUPDATER=1', 'LETTA_CODE_TELEM=0', 'DO_NOT_TRACK=1', '/usr/local/bin/letta', '--version']).out).toContain(LETTA_CODE_VERSION)
    expect(logs.join('\n')).toContain(`on Letta Code ${LETTA_CODE_VERSION}`)
    // What Letta Code told the model it is: the persona and the truth about its tools, in place of its own introduction.
    const first = JSON.parse(model.requests[0].body) as { model?: string; messages: { role: string; content: unknown }[]; tools?: unknown[] }
    const turn = model.requests.map((r) => JSON.parse(r.body) as typeof first).find((b) => JSON.stringify(b.messages).includes('CANARY-hello'))!
    const system = JSON.stringify(turn.messages.filter((m) => m.role === 'system' || m.role === 'developer'))
    expect(system).toContain('You are Fern, a chat assistant in one Discord channel. You keep answers short.')
    expect(system).toContain('You have no tools')
    // Letta Code adds its own starting notes after that, and one of them calls it a coding assistant. They
    // cannot be left out, so the agent is told what they are, before them, in the launcher's own words.
    const told = system.indexOf('the harness adds notes of its own, inside <human>, <persona> and <memory> tags')
    expect(told).toBeGreaterThan(system.indexOf('You have no tools'))
    expect(system.indexOf('<persona>')).toBeGreaterThan(told)
    // Nothing of Letta Code's own system prompt is there: what comes before its notes is the launcher's text alone.
    expect(system.slice(0, told)).not.toMatch(/coding assistant|coding agent|Letta/i)
    // And the model is offered no tool to ask for.
    expect(turn.tools ?? []).toEqual([])
    // It asked for the model the config names, by that name, and every call it made was that one.
    expect(first.model).toBe('lab/model-a')
    expect(new Set(model.requests.map((r) => (JSON.parse(r.body) as { model?: string }).model))).toEqual(new Set(['lab/model-a']))
  }, 120_000)

  it('it is given its one room and no other: a second room is refused even after the rules are changed to name it', async () => {
    // The config can only ever ask for one room, so its policy fits. The door also remembers the room it gave this
    // harness: what it learned there is in its memory. A policy that moves the room is taken, and the new room is refused.
    const before = model.requests.length
    const posts = fake.posted.length
    running!.door.setPolicy(policyFor({ ...config, discord: { ...config.discord, channelId: IDS.other } }))
    say('CANARY-moved', { channel: IDS.other })
    await until(() => receipts().some((r) => r.rule === 'mem.one-scope'), 15_000)
    expect(receipts().filter((r) => r.rule === 'mem.one-scope').map((r) => r.verdict)).toEqual(['drop'])
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(model.requests.length).toBe(before)
    expect(model.heard('CANARY-moved')).toBe(false)
    expect(fake.posted).toHaveLength(posts)
    running!.door.setPolicy(policyFor(config))
  }, 60_000)

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
    script.unshift({ match: 'CANARY-tool', tool: { name: 'Bash', args: { command: `touch /tmp/smlab/work/${mark}` } }, text: 'all done' })
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

  it('the start does not depend on the cell dialling after the door is up: a cell that dialled too early is started again', () => {
    // Which of the two came first is a matter of milliseconds, so this start may have gone either way.
    // Both end with the cell connected. The other way is forced in the last test of this file.
    expect(logs.filter((l) => l.startsWith('live: agent'))).toHaveLength(1)
    expect(logs.filter((l) => l.includes('started again')).length).toBeLessThanOrEqual(1)
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
    // The harder of the two ways a cell can need starting again: it had reached the door, so the door still
    // holds its link when it is stopped. The cell that comes back is the same sealed cell, and the door takes it.
    const first = await again({ redialCell: true })
    expect(said.filter((l) => l.includes('started again'))).toHaveLength(1)
    expect(said.at(-1)).toMatch(/^live: agent lc-lab-test on Letta Code/)
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
