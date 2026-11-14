// A policy with every field present, typed so that adding a field to
// PolicyRecord fails the typecheck here until it is added below. The schema
// coverage test walks this object to learn which field paths exist, so a new
// field cannot be added without a rule that reads it.
import type { PolicyRecord, SurfacePolicy } from './types.ts'

type DeepRequired<T> = T extends (infer U)[]
  ? DeepRequired<U>[]
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T

type Exemplar = Omit<DeepRequired<PolicyRecord>, 'surfaces'> & {
  surfaces: { fake: DeepRequired<SurfacePolicy> }
}

export const EXEMPLAR_POLICY: Exemplar = {
  schema: 1,
  agentId: 'agent-exemplar',
  version: 1,
  hash: '',
  posture: 'team',
  mode: 'door',
  surfaces: {
    fake: {
      enabled: true,
      account: 'fake-bot',
      users: [{ kind: 'user', id: 'u-alice' }],
      anyoneInAllowedRoom: false,
      rooms: [{ match: { room: 'r-general' }, mode: 'mention' }],
      dm: { mode: 'closed', users: [] },
      bots: { mode: 'none', inlineMentionOnly: true, roles: [], maxAlternatingTurns: 4 },
      invites: { mode: 'closed' },
      threadsRequireMention: true,
      observeUnmentioned: false,
      admins: [],
      approverRoles: [],
    },
  },
  tools: { allow: [], ask: [], deny: [], perRoom: {}, browserGuard: 'off' },
  keys: [],
  egress: { default: 'deny', hosts: [], blockPrivateRanges: true },
  memory: {
    threadsPoolIntoParent: true,
    dmIsolated: true,
    team: { dm: 'none', group: 'none', public: 'none' },
    store: { kind: 'git-markdown', repo: '' },
  },
  session: { groupShared: true, resetAtLocalHour: 3, timezone: 'UTC' },
  budget: { monthlyUsd: 10, onExceed: 'refuse' },
}

/** Field paths of a policy. Lists and free-keyed maps are leaves; surface ids become `*`. */
export function fieldPaths(policy: object): string[] {
  const out: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || path === 'tools.perRoom') {
      out.push(path)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const seg = path === 'surfaces' ? '*' : key
      walk(child, path ? `${path}.${seg}` : seg)
    }
  }
  walk(policy, '')
  return [...new Set(out)].sort()
}
