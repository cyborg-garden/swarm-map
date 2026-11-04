// @vitest-environment node
//
// DMs on Discord are decided by the agent's DM list, which can differ from its
// admins. Copy that says "admins can DM" is false for those agents.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8').replace(/\s+/g, ' ')

describe('Discord DM copy', () => {
  for (const file of ['app/(dashboard)/harnesses/[id]/page.tsx', 'components/harness/settings-tab.tsx']) {
    it(`${file} points at the DM list and does not promise admins can DM`, () => {
      const text = read(file)
      expect(text).toContain('DISCORD_DM_ALLOWED_USERS')
      expect(text).not.toMatch(/only (the agent&apos;s )?admins can DM/i)
    })
  }
  it('the allowlist help does not list DM as something every user gets on Discord', () => {
    expect(read('app/(dashboard)/harnesses/[id]/page.tsx')).toMatch(/Adding someone here does not let them DM/)
  })
})
