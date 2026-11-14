// @vitest-environment node
//
// P: door plumbing, with the fake connector and the echo shim. No Docker, no
// model, no network: the tripwire is armed and must record nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { genInbound, genPolicy, rng } from '../../../conformance/gen.ts'
import {
  applyPatch, loadFixturePolicy, loadScenarios, scenarioPolicy, scenarioSteps, type Scenario,
} from '../../../conformance/scenarios/load.ts'
import { decide } from '../../core/decide.ts'
import { toPrincipal, toRoom } from '../../core/normalise.ts'
import { withHash } from '../../core/policy/canonical.ts'
import type { PolicyRecord } from '../../core/policy/types.ts'
import type { SurfaceConnector } from '../connector.ts'
import { createFakeConnector } from '../connectors/fake.ts'
import { createDoor } from '../door.ts'
import type { Capabilities, Envelope } from '../protocol.ts'
import { createReceiptLog, explain } from '../receipts.ts'
import { createSanitizer, type Sanitizer } from '../sanitizer.ts'
import { connectShim, type ShimClient } from '../shim-client.ts'
import { ECHO_CAPS } from '../testing/echo-shim.ts'
import { startRig, type Rig } from '../testing/rig.ts'

armTripwire()

const F = 'surfaces.fake.'
const team = (patch: Record<string, unknown> = {}): PolicyRecord =>
  withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))

let rig: Rig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

/** A hand-driven shim with its own capabilities, on a rig started with `noShim`. */
async function bareShim(r: Rig, brainToken: string, caps: Partial<Capabilities>): Promise<{ client: ShimClient; heard: Envelope[] }> {
  const client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: brainToken, caps: { ...ECHO_CAPS, ...caps } })
  const heard: Envelope[] = []
  client.onMessage((msg) => {
    if (msg.t !== 'turn') return
    heard.push(msg.env)
    client.send({ t: 'reply', turnId: msg.env.turnId, text: 'ok', attachments: [] })
    client.send({ t: 'settled', turnId: msg.env.turnId })
  })
  await r.door.shimConnected()
  return { client, heard }
}

// A secret-shaped string, minted here so none is ever committed.
const fakeSecret = (): string => 'ghp_' + 'q7W3'.repeat(9)

describe('door: one turn', () => {
  it('[P:round-trip] one message in, one stamped reply out, for the right turn', async () => {
    rig = await startRig(team())
    const id = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hello there' })
    await rig.door.idle()

    expect(rig.shim.heard).toHaveLength(1)
    const env = rig.shim.heard[0]
    expect(env).toMatchObject({
      id, surface: 'fake', sessionKey: 'fake:room:r-general', text: 'hello there',
      sender: { id: 'u-alice', display: 'u-alice', isBot: false }, room: { id: 'r-general', kind: 'channel' },
    })
    expect(rig.fake.ledger).toEqual([
      expect.objectContaining({ nonce: rig.nonce, room: 'r-general', text: 'echo: hello there', turnId: env.turnId }),
    ])
  })

  it('[P:round-trip] the envelope lists only the tools this turn may use', async () => {
    rig = await startRig(team({ 'tools.allow': ['file_read', 'network'] }))
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await rig.door.idle()
    expect(rig.shim.heard[0].tools.sort()).toEqual(['fetch', 'read'])
  })

  it('[P:no-harness] a message with no harness connected is not delivered, and says why', async () => {
    rig = await startRig(team(), { noShim: true })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'anyone?' })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().map((r) => `${r.verdict}/${r.rule}`)).toEqual(['deliver/addr.mention', 'drop/turn.no-harness'])
  })
})

describe('door: fakes only', () => {
  it('[P:fake-only] refuses to start with any connector that is not the fake one', async () => {
    const dummy: SurfaceConnector = { ...createFakeConnector({ nonce: 'deadbeef' }).connector, id: 'discord' }
    await expect(createDoor({
      policy: team(), connectors: [dummy], creds: {}, receipts: createReceiptLog(), brainToken: 't', testing: true,
    })).rejects.toThrow("REFUSING TO RUN: F1 connector 'discord' is not the fake connector")
  })

  it('[P:fake-only] a connector that is not the fake one starts only when its surface is named as live', async () => {
    const fake = createFakeConnector({ nonce: 'deadbeef' })
    const dummy: SurfaceConnector = { ...fake.connector, id: 'discord' }
    const start = (live: ('discord' | 'slack')[]) => createDoor({
      policy: team(), connectors: [dummy], creds: { discord: { token: 'FAKECHAT-deadbeef' } }, receipts: createReceiptLog(), brainToken: 'cell-token', testing: true, live,
    })
    await expect(start(['slack'])).rejects.toThrow(/REFUSING TO RUN: F1/)
    const door = await start(['discord'])
    await door.close()
  })

  it('[P:fake-only] the fake connector refuses a token that is not from this run', async () => {
    const fake = createFakeConnector({ nonce: 'deadbeef' })
    // Built here, not written down, so the repo's secret scanner has nothing to stop on.
    const fakeToken = (nonce: string) => ['FAKECHAT', nonce].join('-')
    const realLooking = ['xoxb', 'something'].join('-')
    await expect(fake.connector.connect({ token: fakeToken('0badf00d') })).rejects.toThrow(/REFUSING/)
    await expect(fake.connector.connect({ token: realLooking })).rejects.toThrow(/REFUSING/)
    await expect(fake.connector.send({ id: 'r', kind: 'channel' }, { text: 'x' })).rejects.toThrow(/not connected/)
    await expect(fake.connector.connect({ token: fakeToken('deadbeef') })).resolves.toBeUndefined()
  })

  it('[P:fake-only] refuses a policy that does not validate', async () => {
    const stale = { ...team(), posture: 'public' as const }
    await expect(startRig(stale)).rejects.toThrow(/hash: does not match/)
  })
})

describe('door: every scenario, end to end', () => {
  const scenarios = loadScenarios().filter((s) => s.expect.heard !== undefined)

  async function run(s: Scenario, which: 'base' | 'twin') {
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`
    const r = await startRig(scenarioPolicy(s, which))
    try {
      for (const step of scenarioSteps(s, which)) {
        if ('say' in step) r.fake.say({ ...step.say, text: step.say.text.replaceAll('{{canary}}', canary) })
      }
      await r.door.idle()
      return {
        heard: r.shim.heard.some((env) => env.text.includes(canary)),
        answered: r.fake.ledger.length > 0,
        stamped: r.fake.ledger.every((p) => p.nonce === r.nonce),
        receipt: r.receipts.all()[0],
      }
    } finally {
      await r.close()
    }
  }

  it('covers the inbound rules', () => {
    expect(scenarios.length).toBeGreaterThan(20)
  })

  it.each(scenarios.map((s) => [s.id, s] as const))('[P:scenarios] %s', async (_id, s) => {
    for (const which of ['base', 'twin'] as const) {
      const want = which === 'base' ? s.expect : s.twin.expect
      const got = await run(s, which)
      expect({ heard: got.heard, answered: got.answered }, which).toEqual({ heard: want.heard, answered: want.answered })
      expect({ verdict: got.receipt.verdict, rule: got.receipt.rule }, which).toEqual(want.receipt)
      expect(got.stamped).toBe(true)
    }
  })
})

describe('door: properties', () => {
  it('[P:drop-never-sends] over random policies and messages, only a delivered message is heard or answered', async () => {
    rig = await startRig(genPolicy(rng(1)))
    const r = rng(2024)
    const seen = { deliver: 0, observe: 0, drop: 0 }
    const botRuns = new Map<string, number>()
    for (let i = 0; i < 300; i++) {
      const policy = genPolicy(r)
      const canary = `CANARY-${i}-`
      const event = genInbound(r, canary)
      rig.door.setPolicy(policy)
      const heardBefore = rig.shim.heard.length
      const postsBefore = rig.fake.ledger.length
      rig.fake.say(event)
      await rig.door.idle()
      // The test's own count of bot messages delivered in a row, per room, kept apart from the door's.
      const room = toRoom(event.room, event.isDm)
      const key = room.kind === 'thread' ? (room.parentId ?? room.id) : room.id
      const verdict = decide(policy, event, { botTurnsInARow: botRuns.get(key) ?? 0 }).verdict as keyof typeof seen
      if (verdict === 'deliver') botRuns.set(key, toPrincipal(event.sender).isBot ? (botRuns.get(key) ?? 0) + 1 : 0)
      seen[verdict]++
      const heard = rig.shim.heard.length - heardBefore
      const posts = rig.fake.ledger.length - postsBefore
      expect({ heard, posts }, `case ${i}: ${verdict}`).toEqual(verdict === 'deliver' ? { heard: 1, posts: 1 } : { heard: 0, posts: 0 })
      if (verdict !== 'deliver') {
        // Nothing of an unheard message may ride along in a later envelope's text.
        expect(rig.shim.heard.some((env) => env.text.includes(canary))).toBe(false)
      }
    }
    expect(seen.deliver).toBeGreaterThan(10)
    expect(seen.drop).toBeGreaterThan(10)
    // Overheard messages are rare in this generator (about one case in a hundred).
    expect(seen.observe).toBeGreaterThanOrEqual(3)
  })
})

describe('door: observe', () => {
  it('[P:observe] overheard lines arrive as context on the next turn in that room, once, and are never answered', async () => {
    rig = await startRig(team({ [F + 'observeUnmentioned']: true }))
    rig.fake.say({ room: 'r-general', sender: 'u-alice', text: 'first overheard' })
    rig.fake.say({ room: 'r-general', sender: { id: 'u-bob', roles: ['role-staff'], display: 'Bob' }, text: 'second overheard' })
    rig.fake.say({ room: 'r-lounge', sender: 'u-alice', text: 'a different room' })
    await rig.door.idle()
    // The lounge is a free room, so that one was a turn. The two in general were only overheard.
    expect(rig.shim.heard.map((e) => e.text)).toEqual(['a different room'])
    expect(rig.shim.heard[0].context.observed ?? []).toEqual([])
    expect(rig.fake.ledger.map((p) => p.room)).toEqual(['r-lounge'])

    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'now I ask' })
    await rig.door.idle()
    const env = rig.shim.heard[1]
    expect(env.text).toBe('now I ask')
    expect(env.context.observed?.map((l) => `${l.sender}: ${l.text}`)).toEqual(['u-alice: first overheard', 'Bob: second overheard'])

    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'and again' })
    await rig.door.idle()
    expect(rig.shim.heard[2].context.observed ?? []).toEqual([])
    expect(rig.fake.ledger).toHaveLength(3)
  })

  it('[P:observe] the buffer is bounded, keeping the newest lines', async () => {
    rig = await startRig(team({ [F + 'observeUnmentioned']: true }), { door: { observeLimit: 3 } })
    for (let i = 0; i < 6; i++) rig.fake.say({ room: 'r-general', sender: 'u-alice', text: `line ${i}` })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'go' })
    await rig.door.idle()
    expect(rig.shim.heard[0].context.observed?.map((l) => l.text)).toEqual(['line 3', 'line 4', 'line 5'])
  })
})

describe('door: session keys', () => {
  it('[P:session-keys] a room, a thread in it, and a DM', async () => {
    rig = await startRig(team({ [F + 'dm']: { mode: 'open', users: [] }, [F + 'threadsRequireMention']: false }))
    rig.fake.say({ room: 'r-lounge', sender: 'u-alice', text: 'room' })
    rig.fake.say({ room: { id: 't-7', kind: 'thread', parentId: 'r-lounge' }, sender: 'u-alice', text: 'thread' })
    rig.fake.say({ room: 'dm:u-alice', sender: 'u-alice', isDm: true, text: 'dm' })
    await rig.door.idle()
    expect(Object.fromEntries(rig.shim.heard.map((e) => [e.text, e.sessionKey]))).toEqual({
      room: 'fake:room:r-lounge', thread: 'fake:room:r-lounge', dm: 'fake:dm:u-alice',
    })
    // The reply to a thread goes back to the thread, not the parent room.
    expect(rig.fake.ledger.map((p) => p.room).sort()).toEqual(['dm:u-alice', 'r-lounge', 't-7'])
  })
})

describe('door: a DM needs a harness that keeps sessions apart', () => {
  const dmOpen = () => team({ [F + 'dm']: { mode: 'open', users: [] } })

  it('[P:dm-isolated] a harness whose sessions share files is never given a DM, and the receipt says why', async () => {
    const brainToken = 'cell-test-token'
    for (const caps of [{ sessionIsolation: 'none' as const }, { sessionIsolation: undefined as never }]) {
      rig = await startRig(dmOpen(), { noShim: true, door: { brainToken } })
      const shim = await bareShim(rig, brainToken, caps)
      const dm = rig.fake.say({ room: 'dm:u-alice', sender: 'u-alice', isDm: true, text: 'private thing' })
      rig.fake.say({ room: 'r-lounge', sender: 'u-alice', text: 'room thing' })
      await rig.door.idle()
      expect(shim.heard.map((e) => e.text)).toEqual(['room thing'])
      expect(rig.fake.ledger.map((p) => p.room)).toEqual(['r-lounge'])
      expect(explain(rig.receipts.all(), dm)).toEqual([
        'inbound  deliver  dm.open  Direct messages are open to anyone.',
        'inbound  drop  mem.dm-isolated  This harness keeps every session in one place on disk, so a direct message is not delivered to it.',
      ])
      shim.client.close()
      await rig.close()
    }
    rig = undefined
  })

  it('[P:dm-isolated] a DM is known by its room as well as its flag: a connector that forgets the flag changes nothing', async () => {
    const brainToken = 'cell-test-token'
    // The DM room is on the room list, so without the flag it is admitted the way a room is.
    const listed = team({ [F + 'rooms']: [{ match: { room: 'dm:u-alice' }, mode: 'free' }] })
    rig = await startRig(listed, { noShim: true, door: { brainToken } })
    const shim = await bareShim(rig, brainToken, { sessionIsolation: 'none' })
    const dm = rig.fake.say({ room: { id: 'dm:u-alice', kind: 'dm' }, sender: 'u-alice', isDm: false, text: 'private thing' })
    await rig.door.idle()
    expect(shim.heard).toEqual([])
    expect(explain(rig.receipts.all(), dm).at(-1)).toContain('drop  mem.dm-isolated')
    shim.client.close()
  })

  it('[P:dm-isolated] positive control: a harness that keeps sessions apart is given the DM', async () => {
    const brainToken = 'cell-test-token'
    rig = await startRig(dmOpen(), { noShim: true, door: { brainToken } })
    const shim = await bareShim(rig, brainToken, { sessionIsolation: 'sealed' })
    rig.fake.say({ room: 'dm:u-alice', sender: 'u-alice', isDm: true, text: 'private thing' })
    await rig.door.idle()
    expect(shim.heard.map((e) => e.sessionKey)).toEqual(['fake:dm:u-alice'])
    expect(rig.fake.ledger.map((p) => p.room)).toEqual(['dm:u-alice'])
    shim.client.close()
  })
})

describe('door: sanitizer', () => {
  const outboundOnly = (): Sanitizer => {
    const real = createSanitizer()
    return { run: (dir, text, ctx) => (dir === 'inbound' ? { text, findings: [] } : real.run(dir, text, ctx)) }
  }

  it('[P:scrub-in] a pasted secret is scrubbed before the harness sees it', async () => {
    rig = await startRig(team())
    const secret = fakeSecret()
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `my token is ${secret} ok` })
    await rig.door.idle()
    expect(rig.shim.heard[0].text).toBe('my token is [redacted:github-token] ok')
    expect(JSON.stringify(rig.shim.heard)).not.toContain(secret)
    expect(JSON.stringify(rig.fake.ledger)).not.toContain(secret)
    expect(rig.receipts.all().some((r) => r.rule === 'san.in' && r.note === 'github-token x1')).toBe(true)
  })

  it('[P:scrub-in] an overheard secret is scrubbed before it is buffered', async () => {
    rig = await startRig(team({ [F + 'observeUnmentioned']: true }))
    const secret = fakeSecret()
    rig.fake.say({ room: 'r-general', sender: 'u-alice', text: `psst ${secret}` })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'go' })
    await rig.door.idle()
    expect(JSON.stringify(rig.shim.heard)).not.toContain(secret)
    expect(rig.shim.heard[0].context.observed?.[0].text).toBe('psst [redacted:github-token]')
  })

  it('[P:scrub-in] a scrub that fails delivers nothing, and leaves a receipt saying so', async () => {
    const broken: Sanitizer = { run: (dir, text) => { if (dir === 'inbound') throw new Error('boom'); return { text, findings: [] } } }
    rig = await startRig(team({ [F + 'observeUnmentioned']: true }), { door: { sanitizer: broken } })
    const asked = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'plain' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', text: 'overheard' })
    await rig.door.idle()
    expect(rig.shim.heard).toEqual([])
    expect(rig.fake.ledger).toEqual([])
    expect(explain(rig.receipts.all(), asked).at(-1)).toBe('inbound  drop  san.in  The inbound scrub failed, so the message was not passed on.')
    // The overheard line was not kept either: a later turn must not carry it unscrubbed.
    expect(rig.receipts.all().filter((r) => r.rule === 'san.in').map((r) => r.verdict)).toEqual(['drop', 'drop'])
  })

  it('[P:redact-out] a secret in a reply is redacted before it is posted', async () => {
    rig = await startRig(team(), { door: { sanitizer: outboundOnly() } })
    const secret = fakeSecret()
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `repeat ${secret}` })
    await rig.door.idle()
    expect(rig.shim.heard[0].text).toContain(secret) // the harness had it; the room must not get it
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: repeat [redacted:github-token]'])
  })

  it('[P:redact-out] secrets the sidecar itself holds are always redacted', async () => {
    const upstream = 'UPSTREAM-' + 'f00dfeed'
    const real = createSanitizer({ extraSecrets: [upstream] })
    const sanitizer: Sanitizer = { run: (dir, text, ctx) => (dir === 'inbound' ? { text, findings: [] } : real.run(dir, text, ctx)) }
    rig = await startRig(team(), { door: { sanitizer } })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `leak ${upstream}` })
    await rig.door.idle()
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: leak [redacted:held-secret]'])
  })

  it('[P:out-fails-closed] if the outbound sanitizer throws, nothing is posted', async () => {
    const broken: Sanitizer = { run: (dir, text) => { if (dir === 'outbound') throw new Error('boom'); return { text, findings: [] } } }
    rig = await startRig(team(), { door: { sanitizer: broken } })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hello' })
    await rig.door.idle()
    expect(rig.shim.heard).toHaveLength(1)
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', rule: 'san.out' })
  })
})

describe('door: outbound re-check', () => {
  it('[P:out-recheck] a reply is dropped when the room was removed mid-turn', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'slow one' })
    await expect.poll(() => rig!.shim.heard.length).toBe(1)
    rig.door.setPolicy(team({ version: 2, [F + 'rooms']: [{ match: { room: 'r-lounge' }, mode: 'free' }] }))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', rule: 'out.still-allowed' })
  })

  it('[P:out-recheck] a reply is dropped when the sender was removed mid-turn', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'slow one' })
    await expect.poll(() => rig!.shim.heard.length).toBe(1)
    rig.door.setPolicy(team({ version: 2, [F + 'users']: [{ kind: 'user', id: 'u-bob' }] }))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', rule: 'out.still-allowed' })
  })

  it('[P:out-recheck] an unrelated policy change mid-turn does not drop the reply', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'slow one' })
    await expect.poll(() => rig!.shim.heard.length).toBe(1)
    rig.door.setPolicy(team({ version: 2 }))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.ledger).toHaveLength(1)
  })
})

describe('door: one reply per turn, only after settled', () => {
  it('[P:one-reply] nothing is posted until the harness says it is finished', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await expect.poll(() => rig!.shim.heard.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(rig.fake.ledger).toEqual([])
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: hi'])
  })

  it('[P:one-reply] a second reply for the same turn is dropped', async () => {
    rig = await startRig(team(), { mode: 'reply-twice' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await rig.door.idle()
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: hi'])
    expect(rig.receipts.all().filter((r) => r.rule === 'turn.one-reply')).toHaveLength(1)
  })

  it('[P:unknown-turn] a reply after settled, or for a turn the door never sent, is dropped', async () => {
    rig = await startRig(team(), { mode: 'reply-after-settled' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await rig.door.idle()
    rig.shim.client.send({ t: 'reply', turnId: 'never-issued', text: 'surprise', attachments: [] })
    rig.shim.client.send({ t: 'settled', turnId: 'never-issued' })
    await expect.poll(() => rig!.receipts.all().filter((r) => r.rule === 'turn.known').length).toBe(3)
    expect(rig.fake.ledger).toEqual([])
  })

  it('[P:one-reply] a turn that never settles dies at its deadline, and a late reply is dropped', async () => {
    rig = await startRig(team(), { mode: 'never-settle', door: { turnDeadlineMs: 60 } })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().at(-1)).toMatchObject({ verdict: 'drop', rule: 'out.still-allowed' })
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await expect.poll(() => rig!.receipts.all().at(-1)?.rule).toBe('turn.known')
    expect(rig.fake.ledger).toEqual([])
  })

  it('[P:one-reply] a turn that settles with no reply posts nothing', async () => {
    rig = await startRig(team(), { mode: 'silent' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
  })
})

describe('door: tool verdicts', () => {
  it('[P:tool-verdict] an allowed tool runs, a denied or unmapped one does not', async () => {
    rig = await startRig(team({ 'tools.allow': ['shell'] }))
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'do !tool bash and !tool read and !tool mystery' })
    await rig.door.idle()
    expect(rig.shim.toolsRan.map((t) => t.tool)).toEqual(['bash'])
    expect(rig.shim.verdicts).toEqual([
      { tool: 'bash', allow: true },
      { tool: 'read', allow: false, reason: 'file_read tools are not on the allow list.' },
      { tool: 'mystery', allow: false, reason: 'unknown tools are not on the allow list.' },
    ])
    const tools = rig.receipts.all().filter((r) => r.event.kind === 'tool' && r.rule === 'tools.lists')
    expect(tools.map((r) => r.verdict)).toEqual(['allow', 'deny', 'deny'])
  })

  it('[P:tool-verdict] a tool request for a turn the door never sent is denied', async () => {
    rig = await startRig(team({ 'tools.allow': ['shell'] }))
    expect(await rig.shim.client.requestTool('never-issued', 'bash', {})).toEqual({ allow: false, reason: 'unknown turn' })
  })

  /** A shim that takes a turn and never finishes it, so a test can ask for a tool whenever it likes. */
  async function idleShim(r: Rig, brainToken: string): Promise<{ client: ShimClient; turn: Promise<Envelope> }> {
    const client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: brainToken, caps: ECHO_CAPS, verdictTimeoutMs: 3000 })
    const turn = new Promise<Envelope>((resolve) => client.onMessage((msg) => { if (msg.t === 'turn') resolve(msg.env) }))
    await r.door.shimConnected()
    return { client, turn }
  }

  it('[P:tool-verdict] a turn that died while the door was looking things up gets a no, not a late yes', async () => {
    const brainToken = 'cell-test-token'
    rig = await startRig(team({ 'tools.allow': ['shell'] }), { noShim: true, door: { brainToken, turnDeadlineMs: 150 } })
    const shim = await idleShim(rig, brainToken)
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    const env = await shim.turn
    // The lookup now takes longer than the turn has left.
    rig.fake.facts.delayMs = 500
    expect(await shim.client.requestTool(env.turnId, 'bash', {})).toEqual({ allow: false, reason: 'the turn is over' })
    const tools = rig.receipts.all().filter((r) => r.event.kind === 'tool')
    expect(tools.map((r) => `${r.verdict}/${r.rule}`)).toEqual(['deny/turn.known'])
    shim.client.close()
  })

  it('[P:tool-verdict] positive control: the same slow lookup inside a live turn is still a yes', async () => {
    const brainToken = 'cell-test-token'
    rig = await startRig(team({ 'tools.allow': ['shell'] }), { noShim: true, door: { brainToken, turnDeadlineMs: 5000 } })
    const shim = await idleShim(rig, brainToken)
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    const env = await shim.turn
    rig.fake.facts.delayMs = 300
    expect(await shim.client.requestTool(env.turnId, 'bash', {})).toEqual({ allow: true })
    shim.client.close()
  })

  it('[P:tool-verdict] a lookup that fails is a no, with a receipt, and the door carries on', async () => {
    const brainToken = 'cell-test-token'
    rig = await startRig(team({ 'tools.allow': ['shell'] }), { noShim: true, door: { brainToken, turnDeadlineMs: 5000 } })
    const shim = await idleShim(rig, brainToken)
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
    const env = await shim.turn
    rig.fake.facts.fail = true
    // The door itself says no; the shim is not left to time out.
    expect(await shim.client.requestTool(env.turnId, 'bash', {})).toEqual({ allow: false, reason: 'could not decide' })
    expect(rig.receipts.all().filter((r) => r.event.kind === 'tool').map((r) => `${r.verdict}/${r.rule}`)).toEqual(['deny/tools.no-verdict'])
    rig.fake.facts.fail = false
    expect(await shim.client.requestTool(env.turnId, 'bash', {})).toEqual({ allow: true })
    shim.client.close()
  })

  it('[P:tool-verdict] with the door told to stay silent, the shim treats it as no', async () => {
    rig = await startRig(team({ 'tools.allow': ['shell'] }), { door: { silentVerdicts: true }, verdictTimeoutMs: 60 })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: '!tool bash' })
    await rig.door.idle()
    expect(rig.shim.toolsRan).toEqual([])
    expect(rig.shim.verdicts).toEqual([{ tool: 'bash', allow: false, reason: 'no verdict in time' }])
  })
})

describe('door: receipts and heartbeat', () => {
  it('[P:receipts] every decision leaves a receipt with ids and sizes, and no message text', async () => {
    rig = await startRig(team({ [F + 'observeUnmentioned']: true, 'tools.allow': ['shell'] }))
    const canary = 'CANARY-receipt-text'
    const dropped = rig.fake.say({ room: 'r-elsewhere', sender: 'u-alice', mention: true, text: `${canary} one` })
    const observed = rig.fake.say({ room: 'r-general', sender: 'u-alice', text: `${canary} two` })
    const delivered = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `${canary} !tool bash` })
    await rig.door.idle()

    const all = rig.receipts.all()
    expect(JSON.stringify(all)).not.toContain(canary)
    const first = (id: string) => all.find((r) => r.event.messageId === id)!
    expect(first(dropped)).toMatchObject({
      agentId: 'agent-team', policyHash: rig.door.policy().hash, verdict: 'drop', rule: 'adm.rooms',
      event: { kind: 'inbound', surface: 'fake', room: 'r-elsewhere', sender: 'u-alice', bytes: Buffer.byteLength(`${canary} one`) },
    })
    expect(first(observed)).toMatchObject({ verdict: 'observe', rule: 'addr.observe' })
    expect(first(delivered)).toMatchObject({ verdict: 'deliver', rule: 'addr.mention' })
    expect(all.map((r) => `${r.event.kind}:${r.verdict}`)).toEqual([
      'inbound:drop', 'inbound:observe', 'inbound:deliver', 'tool:allow', 'outbound:allow',
    ])
    for (const r of all) expect(Number.isNaN(Date.parse(r.ts))).toBe(false)
  })

  it('[P:receipts] a tool name the harness made up is never copied into a receipt', async () => {
    // The tool name in a tool_request is whatever the shim sends. It could be
    // conversation text or a secret read in the cell.
    for (const posture of ['team', 'public']) {
      rig = await startRig(team({ posture, 'tools.allow': ['network'] }))
      const smuggled = 'CANARY-smuggled-in-a-tool-name'
      rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `!tool ${smuggled} and !tool fetch` })
      await rig.door.idle()
      expect(rig.shim.verdicts.map((v) => v.allow)).toEqual([false, true])
      const tools = rig.receipts.all().filter((r) => r.event.kind === 'tool')
      expect(tools.map((r) => r.note)).toEqual(['tool=unmapped', 'tool=fetch'])
      expect(JSON.stringify(rig.receipts.all())).not.toContain(smuggled)
      // The reason sent back to the shim does not echo it either.
      expect(rig.shim.verdicts.map((v) => v.reason ?? '').join(' ')).not.toContain(smuggled)
      await rig.close()
    }
    rig = undefined
  })

  it('[P:receipts] a turn id the harness made up is never copied into a receipt', async () => {
    rig = await startRig(team({ 'tools.allow': ['shell'] }))
    const smuggled = 'CANARY smuggled, with spaces'
    rig.shim.client.send({ t: 'reply', turnId: smuggled, text: 'x', attachments: [] })
    rig.shim.client.send({ t: 'settled', turnId: smuggled })
    expect(await rig.shim.client.requestTool(smuggled, 'bash', {})).toMatchObject({ allow: false })
    await expect.poll(() => rig!.receipts.all().filter((r) => r.rule === 'turn.known').length).toBe(3)
    expect(JSON.stringify(rig.receipts.all())).not.toContain('CANARY')
  })

  it('[P:receipts] a harness whose tool map holds free text is refused at hello', async () => {
    const brainToken = 'cell-test-token'
    rig = await startRig(team({ 'tools.allow': ['shell'] }), { noShim: true, door: { brainToken } })
    const hello = (caps: Partial<Capabilities>) =>
      connectShim({ host: '127.0.0.1', port: rig!.door.brainPort, token: brainToken, caps: { ...ECHO_CAPS, ...caps } })
    const refused = [
      await hello({ toolMap: { 'CANARY smuggled, with spaces': 'shell' } }),
      await hello({ toolMap: { ['x'.repeat(200)]: 'shell' } }),
      await hello({ toolMap: { bash: 'CANARY not a class' as never } }),
      await hello({ toolMap: 'CANARY' as never }),
      await hello({ version: 'CANARY free text\nin a version' }),
      await hello({ harness: 'CANARY' as never }),
    ]
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(rig.door.heartbeat().caps).toBeUndefined()
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'anyone?' })
    await rig.door.idle()
    expect(rig.receipts.all().at(-1)?.rule).toBe('turn.no-harness')
    for (const c of refused) c.close()
    // Positive control: the same hello with an honest map is accepted.
    const ok = await bareShim(rig, brainToken, {})
    expect(rig.door.heartbeat().caps?.harness).toBe('echo')
    ok.client.close()
  })

  it('[P:receipts] "why didn\'t it answer?" reads straight off the receipts', async () => {
    rig = await startRig(team())
    const dropped = rig.fake.say({ room: 'r-elsewhere', sender: 'u-alice', mention: true, text: 'hello?' })
    const answered = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hello!' })
    await rig.door.idle()
    expect(explain(rig.receipts.all(), dropped)).toEqual([
      'inbound  drop  adm.rooms  This room is not on the list.',
    ])
    expect(explain(rig.receipts.all(), answered)).toEqual([
      'inbound  deliver  addr.mention  The agent was addressed in an approved room.',
      'outbound  allow  out.still-allowed  The room is still approved.',
    ])
    expect(explain(rig.receipts.all(), 'no-such-message')).toEqual(['No receipt for that message. The door never saw it.'])
  })

  it('[P:heartbeat-hash] the heartbeat carries the hash of the live policy, and a policy change shows at once', async () => {
    rig = await startRig(team())
    const before = rig.door.heartbeat()
    expect(before).toMatchObject({ agentId: 'agent-team', policyHash: team().hash, caps: { harness: 'echo' } })

    // Closed room now; the next message is dropped with no restart.
    const next = team({ version: 2, [F + 'rooms']: [{ match: { room: 'r-lounge' }, mode: 'free' }] })
    rig.door.setPolicy(next)
    expect(rig.door.heartbeat().policyHash).toBe(next.hash)
    expect(next.hash).not.toBe(before.policyHash)
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'still there?' })
    await rig.door.idle()
    expect(rig.fake.ledger).toEqual([])
  })

  it('[P:heartbeat-hash] a policy that does not validate is refused and the old one stays live', async () => {
    rig = await startRig(team())
    const stale = { ...team(), posture: 'public' as const }
    expect(() => rig!.door.setPolicy(stale)).toThrow(/hash: does not match/)
    expect(() => rig!.door.setPolicy(team({ agentId: 'someone-else' }))).toThrow(/agentId: belongs to another agent/)
    expect(rig.door.heartbeat().policyHash).toBe(team().hash)
  })
})

describe('door: bot loops', () => {
  const bot = { id: 'b-other', isBot: true }
  const loopy = (max: number) => team({ [F + 'bots.mode']: 'all', [F + 'bots.maxAlternatingTurns']: max })
  const verdicts = (r: Rig) => r.receipts.all().filter((x) => x.event.kind === 'inbound').map((x) => `${x.verdict}/${x.rule}`)

  it('[P:bot-loop] after the limit, a bot is not heard again until a person is', async () => {
    rig = await startRig(loopy(2))
    for (let i = 0; i < 4; i++) { rig.fake.say({ room: 'r-lounge', sender: bot, text: `bot ${i}` }); await rig.door.idle() }
    expect(verdicts(rig)).toEqual(['deliver/addr.free-rooms', 'deliver/addr.free-rooms', 'drop/bots.loop', 'drop/bots.loop'])
    expect(rig.shim.heard.map((e) => e.text)).toEqual(['bot 0', 'bot 1'])
    expect(rig.fake.ledger).toHaveLength(2)

    rig.fake.say({ room: 'r-lounge', sender: 'u-alice', text: 'carry on' })
    await rig.door.idle()
    rig.fake.say({ room: 'r-lounge', sender: bot, text: 'bot again' })
    await rig.door.idle()
    expect(verdicts(rig).slice(4)).toEqual(['deliver/addr.free-rooms', 'deliver/addr.free-rooms'])
  })

  it('[P:bot-loop] a person who is not heard does not reset the count, and a thread counts with its room', async () => {
    rig = await startRig(loopy(1))
    rig.fake.say({ room: 'r-lounge', sender: bot, text: 'one' })
    await rig.door.idle()
    rig.fake.say({ room: 'r-lounge', sender: 'u-stranger', text: 'let it talk' })
    await rig.door.idle()
    rig.fake.say({ room: { id: 't-1', kind: 'thread', parentId: 'r-lounge' }, sender: bot, mention: true, inlineMention: true, text: 'two, in a thread' })
    await rig.door.idle()
    expect(verdicts(rig)).toEqual(['deliver/addr.free-rooms', 'drop/adm.users', 'drop/bots.loop'])
  })

  it('[P:bot-loop] the last bot turn under the limit is still answered: the re-check before posting uses the count it was admitted under', async () => {
    rig = await startRig(loopy(1))
    rig.fake.say({ room: 'r-lounge', sender: bot, text: 'only one' })
    await rig.door.idle()
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: only one'])
  })

  it('[P:bot-loop] a limit of none answers no bot at all', async () => {
    rig = await startRig(loopy(0))
    rig.fake.say({ room: 'r-lounge', sender: bot, text: 'hello' })
    await rig.door.idle()
    expect(verdicts(rig)).toEqual(['drop/bots.loop'])
    expect(rig.shim.heard).toEqual([])
  })
})

describe('door: reply size', () => {
  it('[P:out-size] a reply over the limit is cut, after redaction, and the receipt says so', async () => {
    rig = await startRig(team(), { door: { maxReplyChars: 40 } })
    const secret = fakeSecret()
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `x ${secret} ${'y'.repeat(200)}` })
    await rig.door.idle()
    const [post] = rig.fake.ledger
    expect(post.text.startsWith('echo: x [redacted:github-token] yyy')).toBe(true)
    expect([...post.text.split('\n')[0]]).toHaveLength(40)
    expect(post.text).toContain('[cut:')
    expect(post.text).not.toContain(secret.slice(0, 12))
    expect(rig.receipts.all().map((x) => x.rule)).toContain('out.size')
  })

  it('[P:out-size] a reply at the limit is posted whole', async () => {
    rig = await startRig(team(), { door: { maxReplyChars: 12 } })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'abcdef' })
    await rig.door.idle()
    expect(rig.fake.ledger.map((p) => p.text)).toEqual(['echo: abcdef'])
    expect(rig.receipts.all().map((x) => x.rule)).not.toContain('out.size')
  })
})

describe('door: a message is read once', () => {
  it('[P:in-once] an edit is not read again, and leaves a receipt', async () => {
    rig = await startRig(team())
    const id = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'first' })
    await rig.door.idle()
    rig.fake.notice('edit', id, 'r-general')
    await rig.door.idle()
    expect(rig.shim.heard).toHaveLength(1)
    expect(rig.fake.ledger).toHaveLength(1)
    expect(explain(rig.receipts.all(), id).at(-1)).toContain('in.once')
  })

  it('[P:in-once] a reply to a message deleted mid-turn is not posted', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    const id = rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'never mind' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    rig.fake.notice('delete', id, 'r-general')
    await rig.door.idle()
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.fake.ledger).toEqual([])
    expect(rig.receipts.all().map((x) => `${x.verdict}/${x.rule}`)).toEqual(['deliver/addr.mention', 'drop/in.once', 'drop/turn.known'])
  })

  it('[P:in-once] positive control: the same turn with no delete is posted', async () => {
    rig = await startRig(team(), { mode: 'never-settle' })
    rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'still here' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    rig.shim.client.send({ t: 'settled', turnId: rig.shim.heard[0].turnId })
    await rig.door.idle()
    expect(rig.fake.ledger).toHaveLength(1)
  })
})
