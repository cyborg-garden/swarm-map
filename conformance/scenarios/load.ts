// Scenario loader. Scenarios are JSON so another language's test runner can
// read the same files. Each one carries a flipped twin: the same steps under
// a patched policy, with the opposite outcome. A rule whose twin does not flip
// is a knob that nothing reads.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Event, Facts, Principal, RoomRef, Verdict } from '../../lib/core/events.ts'
import type { PolicyRecord } from '../../lib/core/policy/types.ts'
import { withHash } from '../../lib/core/policy/canonical.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', 'fixtures')

export interface Expectation {
  heard?: boolean
  answered?: boolean
  receipt: { verdict: Verdict; rule: string }
  privilege?: 'admin' | 'member' | 'guest'
}

type RoomInput = string | RoomRef
type SenderInput = string | Partial<Principal> & { id: string }

export interface SayStep {
  room: RoomInput; sender: SenderInput; text: string
  isDm?: boolean; mention?: boolean; inlineMention?: boolean; replyToAgent?: boolean
}
export type Step =
  | { say: SayStep }
  | { tool: { room: RoomInput; actor: SenderInput; toolClass: string; toolName: string } }
  | { model: { provider: string; model: string } }
  | { outbound: { room: RoomInput; text: string; isDm?: boolean } }

export interface Scenario {
  id: string
  rule: string
  policy: string
  patch?: Record<string, unknown>
  steps: Step[]
  facts?: Facts
  expect: Expectation
  twin: { patch?: Record<string, unknown>; facts?: Facts; expect: Expectation }
}

export function loadScenarios(): Scenario[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(HERE, f), 'utf8')) as Scenario)
}

export function loadFixturePolicy(name: string): PolicyRecord {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as PolicyRecord
}

/** Set dotted paths on a deep copy. `null` removes the key. */
export function applyPatch<T>(base: T, patch: Record<string, unknown> = {}): T {
  const out = structuredClone(base) as Record<string, unknown>
  for (const [dotted, value] of Object.entries(patch)) {
    const keys = dotted.split('.')
    let node = out
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    const last = keys[keys.length - 1]
    if (value === null) delete node[last]
    else node[last] = structuredClone(value)
  }
  return out as T
}

/** The policy a scenario runs under, with a fresh hash. `twin` adds the twin's patch on top. */
export function scenarioPolicy(s: Scenario, which: 'base' | 'twin'): PolicyRecord {
  let policy = applyPatch(loadFixturePolicy(s.policy), s.patch)
  if (which === 'twin') policy = applyPatch(policy, s.twin.patch)
  return withHash(policy)
}

export function scenarioFacts(s: Scenario, which: 'base' | 'twin'): Facts {
  return which === 'twin' ? { ...s.facts, ...s.twin.facts } : { ...s.facts }
}

export function toRoom(room: RoomInput, isDm = false): RoomRef {
  return typeof room === 'string' ? { id: room, kind: isDm ? 'dm' : 'channel' } : room
}

export function toPrincipal(sender: SenderInput): Principal {
  const p = typeof sender === 'string' ? { id: sender } : sender
  return { display: p.id, isBot: false, isSelf: false, roles: [], ...p }
}

/** Turn one step into the Event decide() is asked about. */
export function stepEvent(step: Step, canary: string): Event {
  if ('say' in step) {
    const s = step.say
    return {
      kind: 'inbound', surface: 'fake', room: toRoom(s.room, s.isDm), sender: toPrincipal(s.sender),
      isDm: s.isDm ?? false, mention: s.mention ?? false, inlineMention: s.inlineMention ?? false,
      replyToAgent: s.replyToAgent ?? false, text: s.text.replaceAll('{{canary}}', canary), attachments: [],
    }
  }
  if ('tool' in step) {
    const t = step.tool
    return {
      kind: 'tool', surface: 'fake', room: toRoom(t.room), actor: toPrincipal(t.actor),
      toolClass: t.toolClass as never, toolName: t.toolName, argsDigest: '',
    }
  }
  if ('model' in step) return { kind: 'model', ...step.model }
  const o = step.outbound
  return { kind: 'outbound', surface: 'fake', room: toRoom(o.room, o.isDm), turnId: 't-1', text: o.text }
}
