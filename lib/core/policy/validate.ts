// Save-time checks on a PolicyRecord. A record with any error is never applied.
import { policyHash } from './canonical.ts'
import { assertRendered, UnrenderedError } from './deferred.ts'
import { shapeErrors } from './shape.ts'
import type { PolicyRecord } from './types.ts'

export function validatePolicy(policy: PolicyRecord, opts: { testing?: boolean } = {}): string[] {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return ['policy: must be an object']
  const errors: string[] = []
  if (policy.schema !== 1) errors.push('schema: must be 1')
  if (!policy.agentId || typeof policy.agentId !== 'string') errors.push('agentId: must not be empty')
  if (!Number.isInteger(policy.version) || policy.version < 1) errors.push('version: must be a positive whole number')
  // Every value outside its declared set. decide() compares against the names
  // it knows, so a typo must stop here, not be read as "the other case".
  const shape = shapeErrors(policy)
  errors.push(...shape)
  if (shape.length > 0) return errors // the rest reads fields that are not there
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
