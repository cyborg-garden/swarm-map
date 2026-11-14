// A one-message round trip through the door, run with plain Node:
//   node conformance/smoke.ts
// Fake connector in, echo shim behind the door, fake connector out. No
// network, no Docker, no model. Prints what was posted and why.
import { withHash } from '../lib/core/policy/canonical.ts'
import { startRig } from '../lib/door/testing/rig.ts'
import { loadFixturePolicy } from './scenarios/load.ts'

const rig = await startRig(withHash(loadFixturePolicy('policy-team.json')))
rig.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: 'plain node' })
await rig.door.idle()
console.log(JSON.stringify({
  posts: rig.fake.ledger.map((p) => p.text),
  receipts: rig.receipts.all().map((r) => `${r.verdict}/${r.rule}`),
}))
await rig.close()
