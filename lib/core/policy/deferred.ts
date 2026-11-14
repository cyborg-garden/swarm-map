// Fields the record carries that this slice does not enforce yet.
//
// Each names the rule that will read it. Until that rule exists, decide()
// refuses any policy that sets the field to something other than its resting
// value (see assertRendered), so an unenforced knob can never look enforced.
// The list may only shrink: lower DEFERRED_COUNT_CEILING when a rule lands.
import type { PolicyRecord } from './types.ts'

export interface DeferredField {
  /** PolicyRecord path; `*` stands for any surface id. */
  path: string
  /** Catalogue id of the rule that will read it. */
  rule: string
  /** True when the value is the resting one, so nothing unenforced is being asked for. */
  atRest: (value: unknown) => boolean
}

const empty = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length === 0)
const is = (want: unknown) => (v: unknown): boolean => v === want
// A label with no behaviour of its own. Any value is at rest.
const label = (): boolean => true

export const DEFERRED_FIELDS: DeferredField[] = [
  { path: 'mode', rule: 'native.claims', atRest: is('door') },
  { path: 'surfaces.*.account', rule: 'keys.chat-token', atRest: label },
  { path: 'surfaces.*.dm.mode', rule: 'dm.pairing', atRest: (v) => v !== 'pairing' },
  { path: 'surfaces.*.bots.roles', rule: 'bots.roles', atRest: empty },
  { path: 'surfaces.*.invites.mode', rule: 'invite.policy', atRest: is('closed') },
  { path: 'surfaces.*.approverRoles', rule: 'priv.approver-roles', atRest: empty },
  { path: 'tools.ask', rule: 'priv.approval', atRest: empty },
  { path: 'tools.perRoom', rule: 'tools.per-room',
    atRest: (v) => v === undefined || (typeof v === 'object' && v !== null && Object.keys(v).length === 0) },
  { path: 'tools.browserGuard', rule: 'tools.browser-guard', atRest: is('off') },
  { path: 'keys', rule: 'keys.not-in-cell', atRest: empty },
  { path: 'egress.default', rule: 'sub.g1', atRest: is('deny') },
  { path: 'egress.hosts', rule: 'sub.g1', atRest: empty },
  { path: 'egress.blockPrivateRanges', rule: 'sub.g1', atRest: is(true) },
  { path: 'memory.threadsPoolIntoParent', rule: 'mem.scope', atRest: is(true) },
  { path: 'memory.team.dm', rule: 'mem.team-read-only', atRest: is('none') },
  { path: 'memory.team.group', rule: 'mem.team-read-only', atRest: is('none') },
  { path: 'memory.team.public', rule: 'mem.team-read-only', atRest: is('none') },
  { path: 'memory.store.kind', rule: 'mem.scope', atRest: is('git-markdown') },
  { path: 'memory.store.repo', rule: 'mem.scope', atRest: is('') },
  { path: 'session.groupShared', rule: 'mem.scope', atRest: is(true) },
  { path: 'session.resetAtLocalHour', rule: 'sess.reset', atRest: is(undefined) },
  { path: 'session.timezone', rule: 'sess.reset', atRest: label },
]

/** Committed count. May only go down. */
export const DEFERRED_COUNT_CEILING = 22

export class UnrenderedError extends Error {
  readonly path: string
  readonly rule: string
  constructor(path: string, rule: string) {
    super(`unrendered: ${path} is set, but the rule that reads it (${rule}) is not built yet`)
    this.name = 'UnrenderedError'
    this.path = path
    this.rule = rule
  }
}

function valuesAt(root: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) return [root]
  if (root === null || typeof root !== 'object') return [undefined]
  const [head, ...rest] = segments
  const record = root as Record<string, unknown>
  if (head === '*') return Object.values(record).flatMap((child) => valuesAt(child, rest))
  return valuesAt(record[head], rest)
}

/** Throws UnrenderedError if the policy asks for anything this slice cannot enforce. */
export function assertRendered(policy: PolicyRecord): void {
  for (const field of DEFERRED_FIELDS) {
    for (const value of valuesAt(policy, field.path.split('.'))) {
      if (!field.atRest(value)) throw new UnrenderedError(field.path, field.rule)
    }
  }
}
