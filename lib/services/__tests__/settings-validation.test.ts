// @vitest-environment node
//
// P3/F6: PUT /api/settings merged the raw request body into stored settings with
// no schema — unknown keys, wrong types, and newline-bearing paths all persisted
// and then flowed into filesystem scans and (pre-F1..F5) shell sinks. The patch
// must be validated against an explicit allowlist before it touches storage.
import { describe, it, expect } from 'vitest'
import { validateSettingsPatch } from '../config'

describe('validateSettingsPatch (P3/F6)', () => {
  it('rejects an unknown key', () => {
    expect(() => validateSettingsPatch({ evil: 'x' })).toThrow(/unknown/i)
  })

  it('rejects a wrong-typed field (composeFiles must be string[])', () => {
    expect(() => validateSettingsPatch({ composeFiles: 'not-an-array' })).toThrow()
  })

  it('rejects an invalid theme value', () => {
    expect(() => validateSettingsPatch({ theme: 'neon' })).toThrow()
  })

  it('rejects a newline in a path field (env/compose injection surface)', () => {
    expect(() => validateSettingsPatch({ hermesDir: '/ok\nBAD' })).toThrow(/newline/i)
  })

  it('rejects a newline inside a composeFiles entry', () => {
    expect(() => validateSettingsPatch({ composeFiles: ['/a.yml', 'b.yml\nrm -rf'] })).toThrow(/newline/i)
  })

  it('rejects an out-of-range localApiPort', () => {
    expect(() => validateSettingsPatch({ localApiPort: 70000 })).toThrow()
  })

  it('accepts a valid patch and returns only known keys', () => {
    const patch = validateSettingsPatch({
      hermesDir: '~/Documents/GitHub/hermes-agent-mt',
      composeFiles: ['/a.yml', '/b.yml'],
      theme: 'dark',
      useLocalBuild: true,
      localApiPort: 8600,
    })
    expect(patch).toEqual({
      hermesDir: '~/Documents/GitHub/hermes-agent-mt',
      composeFiles: ['/a.yml', '/b.yml'],
      theme: 'dark',
      useLocalBuild: true,
      localApiPort: 8600,
    })
  })
})

describe('validateSettingsPatch — discordThreadMentionOptOuts', () => {
  it('accepts a list of harness names', () => {
    expect(validateSettingsPatch({ discordThreadMentionOptOuts: ['blackhouse', 'cyborg-public'] }))
      .toEqual({ discordThreadMentionOptOuts: ['blackhouse', 'cyborg-public'] })
  })

  it('accepts an empty list (no opt-outs)', () => {
    expect(validateSettingsPatch({ discordThreadMentionOptOuts: [] })).toEqual({ discordThreadMentionOptOuts: [] })
  })

  it('rejects a non-array, a non-string entry, or a name that is not a harness slug', () => {
    expect(() => validateSettingsPatch({ discordThreadMentionOptOuts: 'blackhouse' })).toThrow()
    expect(() => validateSettingsPatch({ discordThreadMentionOptOuts: [1] })).toThrow()
    expect(() => validateSettingsPatch({ discordThreadMentionOptOuts: ['Black House'] })).toThrow()
    expect(() => validateSettingsPatch({ discordThreadMentionOptOuts: ['x\ny'] })).toThrow()
  })
})
