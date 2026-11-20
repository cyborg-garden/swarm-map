// @vitest-environment node
//
// The second cell: when a channel has fewer tools than the agent's own, its turns go to a cell of
// their own, built with the web, search and the door's notes only. Here without Docker: which
// channels go there, the cell as written, and the door end to end with two echo shims against a
// fake Discord on loopback. The tripwire is armed and must record nothing.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../../conformance/guards/tripwire.ts'
import { labSubnetBase, pickSubnets } from '../../../../conformance/docker/subnets.ts'
import { reducedCapsProblem, type Capabilities, type ToShim } from '../../../door/protocol.ts'
import { connectShim, type ShimClient } from '../../../door/shim-client.ts'
import { IDS, startDiscordRig, type DiscordRig } from '../../../door/testing/discord-rig.ts'
import { ECHO_CAPS, startEchoShim, type EchoShim } from '../../../door/testing/echo-shim.ts'
import { createBrainServer } from '../../../door/brain-server.ts'
import { PI_CAPS, PI_REDUCED_TOOL_MAP } from '../../../runtimes/pi/caps.ts'
import { startPiShim } from '../../../runtimes/pi/shim.ts'
import { CELL_ENV, REDUCED_CELL_ENV, renderCell, sealProblems, type CellOptions } from '../cell.ts'
import { channelIdsOf, parseConfig, policyFor, reducedRoomsOf, type LabConfig } from '../config.ts'

armTripwire()

/** A cell's token for one run of these tests, made the way the rigs make theirs. */
const cellToken = (): string => `cell-${randomBytes(8).toString('hex')}`

const base = (discord: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: 'pi-lab',
  discord: { guildId: IDS.guild, adminUserIds: [IDS.admin], allowedUserIds: [IDS.member], ...discord },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 2 },
  ...rest,
})
const parsed = (raw: Record<string, unknown>): LabConfig => {
  const { config, errors } = parseConfig(raw)
  expect(errors).toEqual([])
  return config as LabConfig
}
const SHELL_AND_FILES = { enabled: ['shell', 'file_read'], web: { allow: ['example.org'], approval: 'ask' } }
const twoChannels = (tools: string, anyone = true, agentTools: Record<string, unknown> = SHELL_AND_FILES): LabConfig => parsed(base({
  channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: anyone, tools } },
}, { tools: agentTools }))

describe('which channels go to the second cell', () => {
  it('none with one channel, or where every channel has the agent\'s own tools', () => {
    expect(reducedRoomsOf(parsed(base({ channelId: IDS.home }, { tools: SHELL_AND_FILES })))).toEqual([])
    expect(reducedRoomsOf(twoChannels('inherit', false))).toEqual([])
  })

  it('a channel with the web only, or no tools, beside an agent with a shell or file tool', () => {
    expect(reducedRoomsOf(twoChannels('web-only'))).toEqual([IDS.other])
    expect(reducedRoomsOf(twoChannels('none', false))).toEqual([IDS.other])
  })

  it('none when the agent itself has no shell or file tool: its cell holds nothing that runs in it', () => {
    expect(reducedRoomsOf(twoChannels('none', false, { enabled: [], web: { allow: ['example.org'] } }))).toEqual([])
    expect(reducedRoomsOf(parsed(base({ channelIds: [IDS.home, IDS.other], perChannel: { [IDS.other]: { anyoneInChannel: true, tools: 'none' } } })))).toEqual([])
  })

  it('the policy is the same whether or not a second cell is started: the cells are not in it', () => {
    const one = parsed(base({ channelId: IDS.home }, { tools: SHELL_AND_FILES }))
    expect(policyFor(one).hash).toBe(policyFor(parsed(base({ channelIds: [IDS.home] }, { tools: SHELL_AND_FILES }))).hash)
    expect(channelIdsOf(one)).toEqual([IDS.home])
  })
})

describe('the second cell, as written', () => {
  const cellNonce = '0123456789abcdef'.repeat(2)
  const [cell, egress, outside] = pickSubnets(3, [], labSubnetBase(), 0)
  const options: CellOptions = { nonce: '0badf00d', cellNonce, brainToken: `BRAIN-${cellNonce}-0123456789abcdef`, brainPort: 50001, routePort: 50002, model: 'lab/model', systemPrompt: 'You are Fern.', subnets: { cell, egress, outside } }

  it('the agent\'s own cell is as it always was: no tool set in its environment', () => {
    const own = renderCell(options)
    expect(Object.keys(own.services.cell.environment).sort()).toEqual(CELL_ENV)
    expect(sealProblems(own)).toEqual([])
  })

  it('is told to hold the web, search and notes only, and is sealed as the second cell', () => {
    const file = renderCell({ ...options, tools: 'reduced' })
    expect(file.services.cell.environment.SMLAB_TOOLS).toBe('reduced')
    expect(Object.keys(file.services.cell.environment).sort()).toEqual(REDUCED_CELL_ENV)
    expect(sealProblems(file, [], 'reduced')).toEqual([])
  })

  it('must-fail: a second cell started without its tool set, so with the shell and the file tools, is caught as written', () => {
    const file = renderCell({ ...options, tools: 'reduced', broken: 'reduced-with-shell' })
    expect(file.services.cell.environment.SMLAB_TOOLS).toBeUndefined()
    expect(sealProblems(file, [], 'reduced').join('\n')).toMatch(/would hold the shell and the file tools/)
  })

  it('must-fail: each cell is checked as the one it is meant to be', () => {
    expect(sealProblems(renderCell(options), [], 'reduced').join('\n')).toMatch(/not on its list/)
    expect(sealProblems(renderCell({ ...options, tools: 'reduced' })).join('\n')).toMatch(/own cell is told to hold fewer tools/)
  })

  it('is built for Pi only', () => {
    expect(() => renderCell({ ...options, harness: 'letta-code', tools: 'reduced' })).toThrow(/REFUSING TO RUN: F5/)
  })
})

describe('what the second cell may declare', () => {
  it('Pi\'s second cell holds the web, search and the notes tool, and nothing else', () => {
    expect(PI_REDUCED_TOOL_MAP).toEqual({ memory_note: 'memory', web_fetch: 'network', web_search: 'search' })
    expect(reducedCapsProblem({ ...PI_CAPS, toolMap: PI_REDUCED_TOOL_MAP })).toBeUndefined()
  })

  it('the Pi shim told the second cell\'s tools declares those at hello, and refuses a map that is not Pi\'s own', async () => {
    const seen: Capabilities[] = []
    const token = cellToken()
    const brain = await createBrainServer({ token, onShim: (_link, caps) => { seen.push(caps) }, accept: reducedCapsProblem })
    const dirs = { agentDir: '/nonexistent/a', sessionsDir: '/nonexistent/s', workDir: '/nonexistent/w', homeDir: '/nonexistent/h' }
    const shim = await startPiShim({ host: '127.0.0.1', port: brain.port, token, piCommand: ['/nonexistent/pi'], gate: { path: '/nonexistent/gate.ts' }, ...dirs, toolMap: PI_REDUCED_TOOL_MAP })
    try {
      await brain.connected()
      expect(seen.map((c) => c.toolMap)).toEqual([PI_REDUCED_TOOL_MAP])
    } finally { shim.close(); await brain.close() }
    await expect(startPiShim({ host: '127.0.0.1', port: 1, token, piCommand: ['/nonexistent/pi'], gate: { path: '/nonexistent/gate.ts' }, ...dirs, toolMap: { bash: 'network' } })).rejects.toThrow(/not one of Pi's tools/)
  })

  it('must-fail: a cell that declares a shell or a file tool is not one', () => {
    expect(reducedCapsProblem(PI_CAPS)).toMatch(/holds file_read, file_write, shell tools/)
    expect(reducedCapsProblem({ ...PI_CAPS, toolMap: { ...PI_REDUCED_TOOL_MAP, go: 'unknown' } })).toMatch(/holds unknown tools/)
  })
})

// --- the door, with two cells --------------------------------------------------

const REDUCED_CAPS: Partial<Capabilities> = { approvalRoundTrip: true, toolMap: { fetch: 'network', search: 'search' } }
const REDUCED_TOKEN = cellToken()

let rig: DiscordRig | undefined
const closers: Array<() => void> = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

interface Two { r: DiscordRig; own: EchoShim; reduced: EchoShim; refused: string[] }
async function startTwo(o: { ownMode?: EchoShim['mode']; reducedCaps?: Partial<Capabilities>; noReduced?: boolean } = {}): Promise<Two> {
  const config = twoChannels('web-only')
  const refused: string[] = []
  rig = await startDiscordRig(policyFor(config), {
    mode: o.ownMode, shimCaps: { approvalRoundTrip: true }, verdictTimeoutMs: 3000, connector: { sendScope: channelIdsOf(config) },
    door: { reducedCell: { brainToken: REDUCED_TOKEN, rooms: reducedRoomsOf(config) }, onCellRefused: (cell, why) => { refused.push(`${cell}: ${why}`) } },
  })
  let reduced: EchoShim | undefined
  if (!o.noReduced) {
    reduced = await startEchoShim({ port: rig.door.reducedPort!, token: REDUCED_TOKEN, caps: o.reducedCaps ?? REDUCED_CAPS, verdictTimeoutMs: 3000 })
    closers.push(() => reduced!.close())
    if (o.reducedCaps === undefined) await rig.door.reducedConnected!()
  }
  return { r: rig, own: rig.shim, reduced: reduced as EchoShim, refused }
}
const say = (r: DiscordRig, channel: string, text: string, author: string = IDS.member): string =>
  r.fake.post({ channel, guild: IDS.guild, author: { id: author }, content: `<@${r.fake.selfId}> ${text}`, mentions: [r.fake.selfId] })
const rules = (r: DiscordRig, kind?: string): string[] =>
  r.receipts.all().filter((x) => kind === undefined || x.event.kind === kind).map((x) => `${x.verdict}/${x.rule}`)
const arrive = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

describe('the door, with a second cell', () => {
  it('a turn from a channel with fewer tools goes to the second cell only, its threads too; the agent\'s own channel goes to its own', async () => {
    const { r, own, reduced } = await startTwo()
    say(r, IDS.home, 'in my own channel')
    await r.posts(1)
    say(r, IDS.other, 'in the public one', IDS.stranger)
    await r.posts(2)
    say(r, IDS.strayThread, 'in a thread of the public one', IDS.stranger)
    await r.posts(3)
    expect(own.heard.map((e) => e.room.id)).toEqual([IDS.home])
    expect(reduced.heard.map((e) => e.room.id)).toEqual([IDS.other, IDS.strayThread])
    // What each is offered is what its own cell holds, and what the room allows.
    expect(own.heard[0].tools).toEqual(expect.arrayContaining(['bash', 'read', 'fetch']))
    expect(reduced.heard.map((e) => e.tools)).toEqual([['fetch'], ['fetch']])
    expect(r.fake.posted.map((p) => p.channel)).toEqual([IDS.home, IDS.other, IDS.strayThread])
  })

  it('must-fail: a second cell that declares a shell or a file tool is turned away at hello, and its channel is not delivered to anyone', async () => {
    const { r, own, refused } = await startTwo({ reducedCaps: {} })
    await arrive()
    expect(refused.join('\n')).toMatch(/^reduced: bad capabilities: the second cell holds chat_post, file_read, shell tools/)
    say(r, IDS.other, 'hello', IDS.stranger)
    await r.settle()
    expect(own.heard).toEqual([])
    expect(rules(r, 'inbound')).toEqual(['deliver/addr.mention', 'drop/turn.no-harness'])
    expect(r.fake.posted).toEqual([])
  })

  it('must-fail: the second cell cannot ask for a tool, answer, or end a turn that was sent to the agent\'s own cell', async () => {
    // The own cell holds its turn open; a client with the second cell's token plays a cell that knows the turn's id.
    const { r, own } = await startTwo({ ownMode: 'silent-later', noReduced: true })
    const forger: ShimClient = await connectShim({ host: '127.0.0.1', port: r.door.reducedPort!, token: REDUCED_TOKEN, caps: { ...ECHO_CAPS, ...REDUCED_CAPS } as Capabilities, verdictTimeoutMs: 3000 })
    closers.push(() => forger.close())
    await r.door.reducedConnected!()
    say(r, IDS.home, 'hold on')
    await expect.poll(() => own.heard.length).toBe(1)
    const turnId = own.heard[0].turnId

    const asked = await forger.requestTool(turnId, 'fetch', { url: 'https://example.org/' })
    expect(asked).toMatchObject({ allow: false, reason: 'not a turn of this cell' })
    forger.send({ t: 'reply', turnId, text: 'forged', attachments: [] })
    forger.send({ t: 'settled', turnId })
    forger.send({ t: 'error', turnId, message: 'forged' })
    await arrive()
    expect(rules(r).filter((x) => x.endsWith('turn.cell'))).toEqual(['deny/turn.cell', 'drop/turn.cell', 'drop/turn.cell', 'drop/turn.cell'])
    expect(r.fake.posted).toEqual([])

    // Positive control: the turn is still live, and its own cell can still answer it.
    own.client.send({ t: 'reply', turnId, text: 'from the own cell', attachments: [] })
    own.client.send({ t: 'settled', turnId })
    await r.posts(1)
    expect(r.fake.posted.map((p) => p.content)).toEqual(['from the own cell'])
  })

  it('must-fail: the agent\'s own cell cannot act under a turn that was sent to the second cell', async () => {
    const { r } = await startTwo({ noReduced: true })
    // A raw client in the second cell that holds its turn.
    const second: ShimClient = await connectShim({ host: '127.0.0.1', port: r.door.reducedPort!, token: REDUCED_TOKEN, caps: { ...ECHO_CAPS, ...REDUCED_CAPS } as Capabilities, verdictTimeoutMs: 3000 })
    closers.push(() => second.close())
    const heard: string[] = []
    second.onMessage((msg: ToShim) => { if (msg.t === 'turn') heard.push(msg.env.turnId) })
    await r.door.reducedConnected!()
    say(r, IDS.other, 'hold on', IDS.stranger)
    await expect.poll(() => heard.length).toBe(1)
    const asked = await r.shim.client.requestTool(heard[0], 'bash', { command: 'ls' })
    expect(asked).toMatchObject({ allow: false })
    r.shim.client.send({ t: 'reply', turnId: heard[0], text: 'forged', attachments: [] })
    r.shim.client.send({ t: 'settled', turnId: heard[0] })
    await arrive()
    expect(rules(r).filter((x) => x.endsWith('turn.cell'))).toEqual(['deny/turn.cell', 'drop/turn.cell', 'drop/turn.cell'])
    expect(r.fake.posted).toEqual([])
  })

  it('the second cell asks for nothing but the web, search and notes: a tool it never declared is refused before the rules are asked', async () => {
    const { r, reduced } = await startTwo()
    say(r, IDS.other, '!tool bash=ls', IDS.admin)
    await r.posts(1)
    expect(reduced.verdicts).toMatchObject([{ tool: 'bash', allow: false }])
    expect(reduced.toolsRan).toEqual([])
    expect(rules(r, 'tool')).toEqual(['deny/tools.cell'])
  })

  it('a door with no second cell is as it always was: one port, every room to the one cell', async () => {
    const config = twoChannels('web-only')
    rig = await startDiscordRig(policyFor(config), { connector: { sendScope: channelIdsOf(config) } })
    expect(rig.door.reducedPort).toBeUndefined()
    expect(rig.door.reducedConnected).toBeUndefined()
    say(rig, IDS.other, 'hello', IDS.stranger)
    await rig.posts(1)
    expect(rig.shim.heard.map((e) => e.room.id)).toEqual([IDS.other])
  })

  it('refuses a second cell with the first cell\'s token', async () => {
    const config = twoChannels('web-only')
    const same = cellToken()
    await expect(startDiscordRig(policyFor(config), { door: { brainToken: same, reducedCell: { brainToken: same, rooms: [IDS.other] } } })).rejects.toThrow(/token of its own/)
  })
})
