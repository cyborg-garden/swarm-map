// Canonical JSON and the policy hash. The hash covers every field except
// `hash` itself, with object keys sorted, so two records that mean the same
// thing hash the same no matter how they were written down.
import { createHash } from 'node:crypto'
import type { PolicyRecord } from './types.ts'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

export function policyHash(policy: PolicyRecord): string {
  const { hash: _ignored, ...rest } = policy
  void _ignored
  return createHash('sha256').update(canonicalJson(rest)).digest('hex')
}

/** A copy of the policy with its hash filled in. */
export function withHash(policy: PolicyRecord): PolicyRecord {
  return { ...policy, hash: policyHash(policy) }
}
