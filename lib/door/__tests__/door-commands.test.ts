// @vitest-environment node
//
// P: the command policy at the door. A shell call is read whole: a command on
// the allow list runs with no request in the room, a blocked one never runs
// and is never put to anyone, and anything else is held for an admin exactly
// as before. Receipts say which rule decided and never hold the command.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import type { PolicyRecord } from '../../core/policy/types.ts'
import { callHash } from '../../core/tools/call.ts'
import { DEFAULT_COMMANDS } from '../../core/tools/command-policy.ts'
import { commandOf } from '../door.ts'
import type { Envelope } from '../protocol.ts'
import { connectShim, type ShimClient } from '../shim-client.ts'
import { ECHO_CAPS } from '../testing/echo-shim.ts'
import { startRig, type Rig } from '../testing/rig.ts'

armTripwire()

const team = (patch: Record<string, unknown> = {}): PolicyRecord =>
  withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
const ASKS = { 'tools.allow': [], 'tools.ask': ['shell'], 'tools.commands': DEFAULT_COMMANDS }
const brainToken = 'cell-test-token'

let rig: Rig | undefined
let client: ShimClient | undefined
afterEach(async () => {
  client?.close()
  client = undefined
  await rig?.close()
  rig = undefined
  expect(tripwireAttempts()).toEqual([])
})

/** A door with a shim that takes one turn and leaves it open, so the test asks for tools by hand. */
async function open(patch: Record<string, unknown>, door: Record<string, unknown> = {}): Promise<{ r: Rig; env: Envelope }> {
  const r = await startRig(team(patch), { noShim: true, door: { brainToken, turnDeadlineMs: 10_000, approvalTimeoutMs: 400, ...door } })
  rig = r
  client = await connectShim({ host: '127.0.0.1', port: r.door.brainPort, token: brainToken, caps: { ...ECHO_CAPS, approvalRoundTrip: true }, verdictTimeoutMs: 3000 })
  const turn = new Promise<Envelope>((resolve) => client!.onMessage((msg) => { if (msg.t === 'turn') resolve(msg.env) }))
  await r.door.shimConnected()
  r.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'hi' })
  return { r, env: await turn }
}
const requests = (r: Rig) => r.fake.ledger.filter((p) => p.text.startsWith('Approval needed.'))
const toolReceipts = (r: Rig) => r.receipts.all().filter((x) => x.event.kind === 'tool')

describe('door: the command policy', () => {
  it('[P:command-policy] a command on the allow list runs with no request, and the receipt names the rule and not the command', async () => {
    const { r, env } = await open(ASKS)
    const input = { command: 'grep -rn WORD-ONLY-IN-THE-COMMAND .', timeout: 60 }
    expect(await client!.requestTool(env.turnId, 'bash', input)).toEqual({ allow: true, hash: callHash('bash', input) })
    expect(requests(r)).toEqual([])
    const [receipt] = toolReceipts(r)
    expect(receipt).toMatchObject({ verdict: 'allow', rule: 'tools.commands' })
    expect(receipt.note).toContain('command=allow:grep')
    expect(JSON.stringify(r.receipts.all())).not.toContain('WORD-ONLY-IN-THE-COMMAND')
  })

  it('[P:command-policy] a blocked command is refused, is never put to the room, and leaves only its rule on record', async () => {
    const { r, env } = await open(ASKS)
    const verdict = await client!.requestTool(env.turnId, 'bash', { command: 'ls; rm -rf /WORD-ONLY-IN-THE-COMMAND', timeout: 60 })
    expect(verdict).toMatchObject({ allow: false })
    expect(requests(r)).toEqual([])
    expect(toolReceipts(r).map((x) => `${x.verdict}/${x.rule}`)).toEqual(['deny/tools.commands'])
    expect(toolReceipts(r)[0].note).toContain('command=block:rm-recursive')
    expect(JSON.stringify(r.receipts.all())).not.toContain('WORD-ONLY-IN-THE-COMMAND')
  })

  it.each([
    ['a write in a redirection', { command: 'cat notes.txt > /tmp/out', timeout: 60 }],
    ['a second command', { command: 'ls; touch x', timeout: 60 }],
    ['a substitution', { command: 'ls $(touch x)', timeout: 60 }],
    ['backticks', { command: 'ls `touch x`', timeout: 60 }],
    ['an environment prefix', { command: 'env X=1 ls', timeout: 60 }],
    ['an input that is more than a command', { command: 'ls', timeout: 60, env: { X: '1' } }],
    ['a command that is not text', { command: ['ls'], timeout: 60 }],
    ['a time limit that is not a number', { command: 'ls', timeout: '60; touch x' }],
  ])('[P:command-policy] %s is held for an admin, as before', async (_what, input) => {
    const { r, env } = await open(ASKS)
    const verdict = client!.requestTool(env.turnId, 'bash', input)
    // No answer comes, so the request times out: the point is that it was put to the room.
    expect(await verdict).toMatchObject({ allow: false })
    expect(requests(r)).toHaveLength(1)
    expect(toolReceipts(r).map((x) => `${x.verdict}/${x.rule}`)).toEqual(['ask/priv.approval', 'deny/priv.approval'])
  })

  it('[P:command-policy] with no command policy in the record, every shell call asks as it did before', async () => {
    const { r, env } = await open({ 'tools.allow': [], 'tools.ask': ['shell'] })
    expect(await client!.requestTool(env.turnId, 'bash', { command: 'ls', timeout: 60 })).toMatchObject({ allow: false })
    expect(requests(r)).toHaveLength(1)
  })

  it('[P:command-policy] an allowed command still needs the shell to be on, and a public agent still has no shell', async () => {
    const off = await open({ 'tools.allow': [], 'tools.ask': [], 'tools.commands': DEFAULT_COMMANDS })
    expect(await client!.requestTool(off.env.turnId, 'bash', { command: 'ls' })).toMatchObject({ allow: false, reason: 'shell tools are not on the allow list.' })
    client!.close(); client = undefined
    await rig!.close(); rig = undefined
    const pub = await open({ posture: 'public', 'tools.allow': ['shell'], 'tools.commands': DEFAULT_COMMANDS })
    expect(await client!.requestTool(pub.env.turnId, 'bash', { command: 'ls' })).toMatchObject({ allow: false, reason: 'Public agents do not get shell tools.' })
  })

  it('[P:command-policy] a yes to a command that the block list caught up with while it waited does not run it', async () => {
    const { r, env } = await open(ASKS, { approvalTimeoutMs: 5000 })
    const verdict = client!.requestTool(env.turnId, 'bash', { command: 'touch x', timeout: 60 })
    while (requests(r).length === 0) await new Promise((res) => setTimeout(res, 10))
    r.door.setPolicy(team({ ...ASKS, 'tools.commands': { allow: DEFAULT_COMMANDS.allow, block: [...DEFAULT_COMMANDS.block, 'touch'] } }))
    r.fake.say({ room: 'r-general', sender: 'u-root', text: 'approve', replyTo: requests(r)[0].id })
    expect(await verdict).toMatchObject({ allow: false })
    expect(toolReceipts(r).at(-1)).toMatchObject({ verdict: 'deny', rule: 'tools.commands' })
  })

  it('[P:command-policy] positive control: the same yes with the record unchanged runs it', async () => {
    const { r, env } = await open(ASKS, { approvalTimeoutMs: 5000 })
    const input = { command: 'touch x', timeout: 60 }
    const verdict = client!.requestTool(env.turnId, 'bash', input)
    while (requests(r).length === 0) await new Promise((res) => setTimeout(res, 10))
    r.fake.say({ room: 'r-general', sender: 'u-root', text: 'approve', replyTo: requests(r)[0].id })
    expect(await verdict).toEqual({ allow: true, hash: callHash('bash', input) })
  })

  it('[P:command-policy] only a command, with at most a numeric time limit, is read as a command', () => {
    expect(commandOf({ command: 'ls' })).toBe('ls')
    expect(commandOf({ command: 'ls', timeout: 5 })).toBe('ls')
    for (const bad of [null, 'ls', ['ls'], {}, { command: 1 }, { command: 'ls', timeout: '5' }, { command: 'ls', cwd: '/' }, JSON.parse('{"command":"ls","__proto__":{}}')]) {
      expect(commandOf(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})
