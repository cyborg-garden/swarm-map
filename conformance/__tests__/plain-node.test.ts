// @vitest-environment node
//
// The sidecar and the shim run under plain Node, with no build step. That
// only holds while the lab's TypeScript stays erasable (no enums, no
// parameter properties) and its imports name `.ts` files. This test fails
// the moment that stops being true.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('the lab runs under plain Node', () => {
  it('[U:plain-node] a door round trip with no bundler and no transpiler', () => {
    const smoke = path.resolve(import.meta.dirname, '..', 'smoke.ts')
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
    const out = execFileSync(process.execPath, [smoke], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    expect(JSON.parse(out)).toEqual({ posts: ['echo: plain node'], receipts: ['deliver/addr.mention', 'allow/out.still-allowed'] })
  })
})
