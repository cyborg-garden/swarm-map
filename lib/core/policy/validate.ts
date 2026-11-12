// Save-time checks on a PolicyRecord. A record with any error is never applied.
import { policyHash } from './canonical.ts'
import { assertRendered, UnrenderedError } from './deferred.ts'
import type { PolicyRecord } from './types.ts'

export function validatePolicy(policy: PolicyRecord, opts: { testing?: boolean } = {}): string[] {
  const errors: string[] = []
  if (policy.schema !== 1) errors.push('schema: must be 1')
  if (!policy.agentId) errors.push('agentId: must not be empty')
  if (!Number.isInteger(policy.version) || policy.version < 1) errors.push('version: must be a positive whole number')
  if (policy.hash !== policyHash(policy)) errors.push('hash: does not match the record')
  if (policy.surfaces.fake && !opts.testing) errors.push("surfaces.fake: the 'fake' surface is for tests only")
  try {
    assertRendered(policy)
  } catch (err) {
    if (!(err instanceof UnrenderedError)) throw err
    errors.push(`${err.path}: the rule that reads it (${err.rule}) is not built yet`)
  }
  return errors
}
