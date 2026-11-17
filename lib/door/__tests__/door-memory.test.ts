// @vitest-environment node
//
// P: the door's notes for each room (memory.ts), through the door. A hand-driven shim asks for the
// `memory_note` tool the way a harness would, and reads what each turn is given.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import type { PolicyRecord } from '../../core/policy/types.ts'
import { createMemoryStore, type MemoryStore } from '../memory.ts'
import type { Envelope, ToShim } from '../protocol.ts'
import { createSanitizer } from '../sanitizer.ts'
import { connectShim, type ShimClient } from '../shim-client.ts'
import { ECHO_CAPS } from '../testing/echo-shim.ts'
import { startRig, type Rig } from '../testing/rig.ts'

armTripwire()

const team = (patch: Record<string, unknown> = {}): PolicyRecord => withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
const BRAIN = 'cell-memory-test'
const CAPS = { ...ECHO_CAPS, toolMap: { ...ECHO_CAPS.toolMap, memory_note: 'memory' as const } }
const FAKE_KEY = `ghp_${'q7W3'.repeat(9)}`

let rig: Rig | undefined
const dirs: string[] = []
afterEach(async () => {
  await rig?.close()
  rig = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  expect(tripwireAttempts()).toEqual([])
})

function memoryStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'door-mem-'))
  dirs.push(dir)
  return { dir, store: createMemoryStore({ dir: path.join(dir, 'memory'), sanitizer: createSanitizer() }) }
}

/** A shim that answers every turn with "ok", and asks for one tool call first when a test hands it one for that turn. */
async function noteShim(r: Rig): Promise<{ client: ShimClient; heard: Envelope[]; resets: string[]; next: (input: unknown) => Promise<{ allow: boolean; reason?: string }> }> {
  const client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: BRAIN, caps: CAPS, verdictTimeoutMs: 3000 })
  const heard: Envelope[] = []
  const resets: string[] = []
  let pending: { input: unknown; done: (a: { allow: boolean; reason?: string }) => void } | undefined
  client.onMessage(async (msg: ToShim) => {
    if (msg.t === 'reset') { resets.push(msg.sessionKey); return }
    if (msg.t !== 'turn') return
    heard.push(msg.env)
    if (pending) {
      const p = pending
      pending = undefined
      p.done(await client.requestTool(msg.env.turnId, 'memory_note', p.input))
    }
    client.send({ t: 'reply', turnId: msg.env.turnId, text: 'ok', attachments: [] })
    client.send({ t: 'settled', turnId: msg.env.turnId })
  })
  await r.door.shimConnected()
  return { client, heard, resets, next: (input) => new Promise((done) => { pending = { input, done } }) }
}

const say = (r: Rig, text: string, room = 'r-general', sender: 'u-alice' | 'u-root' = 'u-alice'): string => r.fake.say({ room, sender, mention: true, text })

describe('door: notes kept for each room', () => {
  it('[P:mem-notes] a note asked for through the tool is written and given to the next conversation in that room only', async () => {
    const { store } = memoryStore()
    rig = await startRig(team({ 'tools.allow': ['memory'] }), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    // The tool is offered: memory is on the allow list.
    const answer = shim.next({ file: 'room', op: 'add', text: 'the seed swap is on Saturday' })
    say(rig, 'hi')
    expect(await answer).toMatchObject({ allow: true, reason: 'Saved. The door keeps it for this room.' })
    await rig.door.idle()
    expect(shim.heard[0].tools).toContain('memory_note')
    expect(shim.heard[0].context.memory).toBeUndefined()

    say(rig, 'again')
    await rig.door.idle()
    expect(shim.heard[1].context.memory).toBe('About this room:\n- the seed swap is on Saturday')
    // Given once per conversation: unchanged notes are not sent again.
    say(rig, 'and again')
    await rig.door.idle()
    expect(shim.heard[2].context.memory).toBeUndefined()
    // Another room never sees them.
    say(rig, 'over here', 'r-lounge')
    await rig.door.idle()
    expect(shim.heard[3].sessionKey).toBe('fake:room:r-lounge')
    expect(JSON.stringify(shim.heard[3])).not.toContain('seed swap')
    // The receipt names the result, never the note.
    const notes = rig.receipts.all().filter((r) => r.rule === 'mem.notes')
    expect(notes.map((r) => `${r.verdict} ${r.note}`)).toEqual([expect.stringMatching(/^allow tool=memory_note call=\w+ result=add$/)])
    expect(JSON.stringify(rig.receipts.all())).not.toContain('seed swap')
    shim.client.close()
  })

  it('[P:mem-notes] a note with a secret in it is refused, the agent is told why, and nothing is kept', async () => {
    const { store } = memoryStore()
    rig = await startRig(team({ 'tools.allow': ['memory'] }), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    const answer = shim.next({ file: 'room', op: 'add', text: `the token is ${FAKE_KEY}` })
    say(rig, 'remember the token')
    const got = await answer
    expect(got.allow).toBe(false)
    expect(got.reason).toContain('looks like a secret')
    await rig.door.idle()
    expect(store.render('fake:r-general')).toBeUndefined()
    expect(rig.receipts.all().filter((r) => r.rule === 'mem.notes').map((r) => r.verdict)).toEqual(['deny'])
    shim.client.close()
  })

  it('[P:mem-notes] a note about a person needs that person to have asked, in the message that started the turn', async () => {
    const { store } = memoryStore()
    rig = await startRig(team({ 'tools.allow': ['memory'] }), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    let answer = shim.next({ file: 'people', op: 'add', text: 'likes ferns' })
    say(rig, 'I like ferns')
    expect((await answer).allow).toBe(false)
    await rig.door.idle()
    answer = shim.next({ file: 'people', op: 'add', text: 'likes ferns' })
    say(rig, 'please remember I like ferns')
    expect((await answer).allow).toBe(true)
    await rig.door.idle()
    expect(store.render('fake:r-general')).toBe('People who asked to be remembered:\n- [u-alice] u-alice: likes ferns')
    shim.client.close()
  })

  it('[P:mem-notes] with memory off the rules list, the tool is not offered and a request is refused', async () => {
    const { store } = memoryStore()
    rig = await startRig(team(), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    const answer = shim.next({ file: 'room', op: 'add', text: 'x' })
    say(rig, 'hi')
    expect((await answer).allow).toBe(false)
    await rig.door.idle()
    expect(shim.heard[0].tools).not.toContain('memory_note')
    expect(store.render('fake:r-general')).toBeUndefined()
    shim.client.close()
  })

  it('[P:mem-notes] a door with no notes store refuses the tool even when the rules allow it', async () => {
    rig = await startRig(team({ 'tools.allow': ['memory'] }), { noShim: true, door: { brainToken: BRAIN } })
    const shim = await noteShim(rig)
    const answer = shim.next({ file: 'room', op: 'add', text: 'x' })
    say(rig, 'hi')
    expect(await answer).toEqual({ allow: false, reason: 'This agent keeps no notes.' })
    shim.client.close()
  })

  it('[P:mem-notes] a thread reads its room\'s notes', async () => {
    const { store } = memoryStore()
    store.apply('fake:r-lounge', { file: 'room', op: 'add', text: 'moss corner' }, { speaker: { id: 'x', display: 'x' }, asked: false })
    rig = await startRig(team({ 'surfaces.fake.threadsRequireMention': false }), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    rig.fake.say({ room: { id: 't-1', kind: 'thread', parentId: 'r-lounge' }, sender: 'u-alice', text: 'in a thread' })
    await rig.door.idle()
    expect(shim.heard[0].context.memory).toContain('moss corner')
    shim.client.close()
  })

  it('[P:mem-wipe] after a wipe, the conversation is started again and given no notes', async () => {
    const { store } = memoryStore()
    store.apply('fake:r-general', { file: 'room', op: 'add', text: 'old note' }, { speaker: { id: 'x', display: 'x' }, asked: false })
    rig = await startRig(team(), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    say(rig, 'one')
    await rig.door.idle()
    expect(shim.heard[0].context.memory).toContain('old note')
    store.wipe()
    say(rig, 'two')
    await rig.door.idle()
    expect(shim.resets).toEqual(['fake:room:r-general'])
    expect(shim.heard[1].context.memory).toBeUndefined()
    // A changed note is sent again, whole.
    store.apply('fake:r-general', { file: 'room', op: 'add', text: 'new note' }, { speaker: { id: 'x', display: 'x' }, asked: false })
    say(rig, 'three')
    await rig.door.idle()
    expect(shim.heard[2].context.memory).toBe('About this room:\n- new note')
    shim.client.close()
  })

  it('[P:mem-notes] a shim that connects again is given the notes again', async () => {
    const { store } = memoryStore()
    store.apply('fake:r-general', { file: 'room', op: 'add', text: 'kept' }, { speaker: { id: 'x', display: 'x' }, asked: false })
    rig = await startRig(team(), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const first = await noteShim(rig)
    say(rig, 'one')
    await rig.door.idle()
    first.client.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const second = await noteShim(rig)
    say(rig, 'two')
    await rig.door.idle()
    expect(second.heard[0].context.memory).toContain('kept')
    second.client.close()
  })
})

describe('door: notes on an agent anyone can talk to', () => {
  const open = () => team({ posture: 'public', 'tools.allow': ['memory'], 'surfaces.fake.anyoneInAllowedRoom': true })
  it('[P:mem-notes] a stranger cannot change the room\'s notes, an admin can, and a person can keep their own card', async () => {
    const { store } = memoryStore()
    rig = await startRig(open(), { noShim: true, door: { brainToken: BRAIN, memory: store } })
    const shim = await noteShim(rig)
    let answer = shim.next({ file: 'room', op: 'add', text: 'the admins are away' })
    say(rig, 'remember this')
    expect(await answer).toMatchObject({ allow: false, reason: expect.stringContaining('only kept when an admin asks') })
    await rig.door.idle()
    answer = shim.next({ file: 'people', op: 'add', text: 'likes moss' })
    say(rig, 'remember that I like moss')
    expect((await answer).allow).toBe(true)
    await rig.door.idle()
    answer = shim.next({ file: 'room', op: 'add', text: 'seed swap on Saturday' })
    say(rig, 'remember the seed swap', 'r-general', 'u-root')
    expect((await answer).allow).toBe(true)
    await rig.door.idle()
    expect(store.render('fake:r-general')).toBe('About this room:\n- seed swap on Saturday\nPeople who asked to be remembered:\n- [u-alice] u-alice: likes moss')
    shim.client.close()
  })
})

describe('door: a kept scratch folder, in a request to approve', () => {
  it('[P:kept-scratch] the request says what is kept, still fits in one message, and still reads back', async () => {
    const { MAX_REQUEST_CHARS, requestText, shownIn } = await import('../approvals.ts')
    const { MAX_SHOWN_CHARS } = await import('../../core/tools/call.ts')
    const kept = requestText('bash', '{"command":"ls"}', 'f'.repeat(64), 120_000, { keptScratch: true })
    expect(kept).toContain('stays until the agent is stopped, and what it leaves in its scratch folder is kept after that.')
    expect(requestText('bash', '{"command":"ls"}', 'f'.repeat(64), 120_000)).not.toContain('kept after that')
    expect(shownIn(kept)).toEqual({ shown: '{"command":"ls"}', call: 'f'.repeat(12) })
    expect(requestText('x'.repeat(64), 'y'.repeat(MAX_SHOWN_CHARS), 'f'.repeat(64), 600_000, { keptScratch: true }).length).toBeLessThanOrEqual(MAX_REQUEST_CHARS)
  })
})
