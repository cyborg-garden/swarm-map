// @vitest-environment node
//
// U: one agent in more than one room, with rules that differ by room. A room can hear anyone
// (`rooms[].anyone`), and a room can have fewer tools than the agent has (`tools.perRoom`).
// Both only ever narrow: a room cannot be given a tool the agent does not have, and a room that
// hears anyone loses the same tools a public agent does, whatever its own list says.
import { describe, expect, it } from 'vitest'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { decide } from '../decide.ts'
import type { Event, Principal, RoomRef } from '../events.ts'
import { withHash } from '../policy/canonical.ts'
import type { PolicyRecord, ToolClass } from '../policy/types.ts'
import { validatePolicy } from '../policy/validate.ts'

const person = (id: string): Principal => ({ id, display: id, isBot: false, isSelf: false, roles: [] })
const ROOT = person('u-root')
const ALICE = person('u-alice')
const STRANGER = person('u-mallory')
const room = (id: string): RoomRef => ({ id, kind: 'channel' })
const thread = (id: string, parentId: string): RoomRef => ({ id, kind: 'thread', parentId })

/** A team agent in two rooms: r-general for its listed people, r-public open to anyone, by mention, web only. */
const twoRooms = (patch: Record<string, unknown> = {}): PolicyRecord => withHash(applyPatch(loadFixturePolicy('policy-team.json'), {
  'surfaces.fake.rooms': [
    { match: { room: 'r-general' }, mode: 'mention' },
    { match: { room: 'r-public' }, mode: 'mention', anyone: true },
  ],
  'tools.allow': ['file_read', 'network', 'search', 'memory'],
  'tools.ask': ['shell', 'file_write'],
  'tools.perRoom': { 'r-public': { allow: ['network', 'search', 'memory'] } },
  ...patch,
}))

const inbound = (r: RoomRef, sender: Principal, mention = true): Event => ({
  kind: 'inbound', surface: 'fake', room: r, sender, isDm: false, mention, inlineMention: mention, replyToAgent: false, text: 'hi', attachments: [],
})
const tool = (r: RoomRef, actor: Principal, toolClass: ToolClass, command?: string): Event => ({
  kind: 'tool', surface: 'fake', room: r, actor, toolClass, toolName: toolClass, argsDigest: '', ...(command === undefined ? {} : { command }),
})
const verdict = (p: PolicyRecord, e: Event): string => { const d = decide(p, e, {}); return `${d.verdict}/${d.rule}` }

describe('a room that hears anyone', () => {
  it('[U:anyone-per-room] is a valid record', () => {
    expect(validatePolicy(twoRooms(), { testing: true })).toEqual([])
  })

  it('[U:anyone-per-room] a stranger is heard there, as a guest, and only there', () => {
    const p = twoRooms()
    const d = decide(p, inbound(room('r-public'), STRANGER), {})
    expect([d.verdict, d.privilege]).toEqual(['deliver', 'guest'])
    expect(d.trace.map((t) => t.rule)).toContain('adm.anyone-in-room')
    expect(verdict(p, inbound(room('r-general'), STRANGER))).toBe('drop/adm.users')
    expect(verdict(p, inbound(room('r-elsewhere'), STRANGER))).toBe('drop/adm.rooms')
    // Twin: the same room without `anyone` does not hear the stranger.
    const closed = twoRooms({ 'surfaces.fake.rooms': [{ match: { room: 'r-general' }, mode: 'mention' }, { match: { room: 'r-public' }, mode: 'mention' }] })
    expect(verdict(closed, inbound(room('r-public'), STRANGER))).toBe('drop/adm.users')
  })

  it('[U:anyone-per-room] it still needs a mention there, in its threads too, whatever the agent-wide thread setting says', () => {
    const p = twoRooms({ 'surfaces.fake.threadsRequireMention': false })
    expect(verdict(p, inbound(room('r-public'), STRANGER, false))).toBe('drop/addr.mention')
    expect(verdict(p, inbound(thread('t-1', 'r-public'), STRANGER, false))).toBe('drop/addr.threads')
    expect(verdict(p, inbound(thread('t-1', 'r-public'), STRANGER, true))).toBe('deliver/addr.threads')
    // Positive control: a thread in the agent's own room follows the agent-wide setting.
    expect(verdict(p, inbound(thread('t-2', 'r-general'), ALICE, false))).toBe('deliver/addr.threads')
  })

  it('[U:tools-posture] in a room that hears anyone, shell and file tools are refused to anyone, an admin too, whatever the room\'s own list says', () => {
    // The room's list is left out: it would inherit every tool the agent has.
    const p = twoRooms({ 'tools.perRoom': {} })
    for (const actor of [STRANGER, ALICE, ROOT]) {
      for (const k of ['shell', 'file_read', 'file_write', 'code_exec', 'chat_admin'] as ToolClass[]) {
        expect(verdict(p, tool(room('r-public'), actor, k)), `${actor.id} ${k}`).toBe('deny/tools.posture')
        expect(verdict(p, tool(thread('t-1', 'r-public'), actor, k)), `${actor.id} ${k} in a thread`).toBe('deny/tools.posture')
      }
      expect(verdict(p, tool(room('r-public'), actor, 'unknown'))).toBe('deny/tools.unknown')
    }
    // A command the shell's allow list would run without a yes is refused there too.
    const commands = twoRooms({ 'tools.perRoom': {}, 'tools.commands': { allow: ['ls'], block: [] } })
    expect(verdict(commands, tool(room('r-public'), ROOT, 'shell', 'ls'))).toBe('deny/tools.posture')
    // Positive control: in the agent's own room they are as the lists say.
    expect(verdict(p, tool(room('r-general'), ROOT, 'shell'))).toBe('ask/priv.approval')
    expect(verdict(p, tool(room('r-general'), ALICE, 'file_read'))).toBe('allow/tools.lists')
    expect(verdict(commands, tool(room('r-general'), ROOT, 'shell', 'ls'))).toBe('allow/tools.commands')
  })

  it('[U:tools-posture] in a room that hears anyone, the public web is read only with an admin\'s yes', () => {
    const p = twoRooms({ 'egress.default': 'public' })
    expect(verdict(p, tool(room('r-public'), STRANGER, 'network'))).toBe('deny/tools.posture')
    expect(verdict(p, tool(room('r-general'), ALICE, 'network'))).toBe('allow/tools.lists')
    const asks = twoRooms({ 'egress.default': 'public', 'tools.perRoom': { 'r-public': { allow: ['search', 'memory'], ask: ['network'] } } })
    expect(verdict(asks, tool(room('r-public'), STRANGER, 'network'))).toBe('ask/priv.approval')
  })

  it('[U:tools-posture] with the public web opened to anyone (egress.openToAnyone), it is read there with no yes, and nothing else changes', () => {
    const open = twoRooms({ 'egress.default': 'public', 'egress.openToAnyone': true })
    expect(validatePolicy(open, { testing: true })).toEqual([])
    for (const actor of [STRANGER, ALICE, ROOT]) {
      expect(verdict(open, tool(room('r-public'), actor, 'network')), actor.id).toBe('allow/tools.lists')
      expect(verdict(open, tool(thread('t-1', 'r-public'), actor, 'network')), `${actor.id} in a thread`).toBe('allow/tools.lists')
      // Still no shell, file, code-exec or chat-admin tools there, for anyone.
      for (const k of ['shell', 'file_read', 'file_write', 'code_exec', 'chat_admin'] as ToolClass[]) {
        expect(verdict(open, tool(room('r-public'), actor, k)), `${actor.id} ${k}`).toBe('deny/tools.posture')
      }
    }
    // The room's list still decides: a room without network on its list does not get it.
    const listed = twoRooms({ 'egress.default': 'public', 'egress.openToAnyone': true, 'tools.perRoom': { 'r-public': { allow: ['search', 'memory'] } } })
    expect(verdict(listed, tool(room('r-public'), STRANGER, 'network'))).toBe('deny/tools.lists')
    // An agent-wide ask still asks, and only an admin answers it.
    const asks = twoRooms({ 'egress.default': 'public', 'egress.openToAnyone': true, 'tools.allow': ['file_read', 'search', 'memory'], 'tools.ask': ['shell', 'file_write', 'network'] })
    expect(verdict(asks, tool(room('r-public'), STRANGER, 'network'))).toBe('ask/priv.approval')
    for (const approver of [STRANGER, ALICE]) expect(verdict(open, { kind: 'approval', surface: 'fake', room: room('r-public'), approver })).toBe('deny/priv.approval')
    expect(verdict(open, { kind: 'approval', surface: 'fake', room: room('r-public'), approver: ROOT })).toBe('allow/priv.approval')
    // A public agent too.
    const pub = twoRooms({ posture: 'public', 'egress.default': 'public', 'egress.openToAnyone': true })
    expect(verdict(pub, tool(room('r-general'), STRANGER, 'network'))).toBe('allow/tools.lists')
    expect(verdict({ ...pub, egress: { ...pub.egress, openToAnyone: undefined } }, tool(room('r-general'), STRANGER, 'network'))).toBe('deny/tools.posture')
  })

  it('[U:tools-posture] egress.openToAnyone is true or left out: any other value is refused, and decide() denies on a bad record', () => {
    for (const v of [false, 'true', 1]) {
      const bad = twoRooms({ 'egress.default': 'public', 'egress.openToAnyone': v })
      expect(validatePolicy(bad, { testing: true }).join(' ')).toContain('egress.openToAnyone')
      expect(decide(bad, tool(room('r-public'), STRANGER, 'network'), {}).verdict).toBe('deny')
    }
  })

  it('[U:anyone-per-room] only an admin answers a request there: not the person who asked, not anyone else', () => {
    const p = twoRooms()
    const answer = (approver: Principal): string => verdict(p, { kind: 'approval', surface: 'fake', room: room('r-public'), approver })
    expect(answer(STRANGER)).toBe('deny/priv.approval')
    expect(answer(ALICE)).toBe('deny/priv.approval')
    expect(answer(ROOT)).toBe('allow/priv.approval')
  })
})

describe('tools that differ by room', () => {
  it('[U:tools-per-room] a class missing from a room\'s list is refused in that room and its threads, and nowhere else', () => {
    const p = twoRooms({ 'surfaces.fake.rooms': [{ match: { room: 'r-general' }, mode: 'mention' }, { match: { room: 'r-public' }, mode: 'mention' }] })
    expect(verdict(p, tool(room('r-public'), ROOT, 'shell'))).toBe('deny/tools.lists')
    expect(verdict(p, tool(room('r-public'), ALICE, 'file_read'))).toBe('deny/tools.lists')
    expect(verdict(p, tool(thread('t-1', 'r-public'), ALICE, 'file_read'))).toBe('deny/tools.lists')
    expect(verdict(p, tool(room('r-public'), ALICE, 'network'))).toBe('allow/tools.lists')
    expect(verdict(p, tool(room('r-public'), ALICE, 'memory'))).toBe('allow/tools.lists')
    // Twin: the room with no entry has every tool the agent has.
    const inherit = twoRooms({ 'surfaces.fake.rooms': [{ match: { room: 'r-general' }, mode: 'mention' }, { match: { room: 'r-public' }, mode: 'mention' }], 'tools.perRoom': {} })
    expect(verdict(inherit, tool(room('r-public'), ROOT, 'shell'))).toBe('ask/priv.approval')
    expect(verdict(inherit, tool(room('r-public'), ALICE, 'file_read'))).toBe('allow/tools.lists')
  })

  it('[U:tools-per-room] the room\'s list comes before the shell\'s command allow list', () => {
    const p = twoRooms({ 'tools.commands': { allow: ['ls'], block: [] } })
    expect(verdict(p, tool(room('r-public'), ROOT, 'shell', 'ls'))).toBe('deny/tools.posture')
    const closed = twoRooms({ 'tools.commands': { allow: ['ls'], block: [] }, 'surfaces.fake.rooms': [{ match: { room: 'r-general' }, mode: 'mention' }, { match: { room: 'r-public' }, mode: 'mention' }] })
    expect(verdict(closed, tool(room('r-public'), ROOT, 'shell', 'ls'))).toBe('deny/tools.lists')
  })

  it('[U:tools-per-room] a room\'s list never adds a tool the agent does not have, and its own deny and ask hold', () => {
    const p = twoRooms({ 'tools.perRoom': { 'r-general': { allow: ['code_exec', 'file_read'], ask: ['network'], deny: ['search'] } } })
    expect(verdict(p, tool(room('r-general'), ROOT, 'code_exec'))).toBe('deny/tools.lists')
    expect(verdict(p, tool(room('r-general'), ROOT, 'file_read'))).toBe('allow/tools.lists')
    expect(verdict(p, tool(room('r-general'), ROOT, 'network'))).toBe('ask/priv.approval')
    expect(verdict(p, tool(room('r-general'), ROOT, 'search'))).toBe('deny/tools.lists')
    // An empty entry is no tools at all in that room.
    const none = twoRooms({ 'tools.perRoom': { 'r-general': { allow: [] } } })
    for (const k of ['file_read', 'network', 'search', 'memory', 'shell'] as ToolClass[]) expect(verdict(none, tool(room('r-general'), ROOT, k))).toBe('deny/tools.lists')
  })
})
