// @vitest-environment node
//
// P3/F6: PUT /api/settings merged the raw request body into stored settings with
// no schema — unknown keys, wrong types, and newline-bearing paths all persisted
// and then flowed into filesystem scans and (pre-F1..F5) shell sinks. The patch
// must be validated against an explicit allowlist before it touches storage.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ConfigService, validateSettingsPatch } from '../config'
import { Storage } from '../storage'

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

  // Three states: forced on, forced off, and automatic (decided from the
  // Docker engine). null is how a client goes back to automatic.
  it('useStateVolume: accepts true and false, and null clears it to automatic', () => {
    expect(validateSettingsPatch({ useStateVolume: true })).toEqual({ useStateVolume: true })
    expect(validateSettingsPatch({ useStateVolume: false })).toEqual({ useStateVolume: false })
    const cleared = validateSettingsPatch({ useStateVolume: null })
    expect('useStateVolume' in cleared).toBe(true)
    expect(cleared.useStateVolume).toBeUndefined()
  })

  it('useStateVolume: rejects anything else', () => {
    for (const bad of ['true', 'auto', 1, 0, [], {}]) {
      expect(() => validateSettingsPatch({ useStateVolume: bad })).toThrow(/useStateVolume/)
    }
  })

  it('accepts apiBindHost beside the other bind hosts', () => {
    expect(validateSettingsPatch({ apiBindHost: '100.64.0.9', vncBindHost: '100.64.0.5', controlBindHost: '100.64.0.7' })).toEqual({
      apiBindHost: '100.64.0.9', vncBindHost: '100.64.0.5', controlBindHost: '100.64.0.7',
    })
  })

  it('accepts an apiBindHost that is an IP address, or empty for the default', () => {
    for (const ok of ['127.0.0.1', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', '100.64.0.1', '', '::', '1::', 'fe80::', '2001:db8::']) {
      expect(validateSettingsPatch({ apiBindHost: ok })).toEqual({ apiBindHost: ok })
    }
  })

  it('refuses an apiBindHost that docker would refuse as a host address', () => {
    // Each of these would be written into a compose file that then fails at `up`.
    for (const bad of ['[::1]', 'a: b', '{a: b}', ' ', 'localhost', '127.0.0.1, target: 22', ' 127.0.0.1', '127.0.0.1 ', 'fe80::1%en0', 'fe80::1%25en0', '::1%lo0']) {
      expect(() => validateSettingsPatch({ apiBindHost: bad }), JSON.stringify(bad)).toThrow(/apiBindHost must be an IP address/)
    }
  })

  it('leaves the vnc and control bind hosts on their existing rule', () => {
    expect(validateSettingsPatch({ vncBindHost: 'localhost', controlBindHost: 'my-host.example' })).toEqual({
      vncBindHost: 'localhost', controlBindHost: 'my-host.example',
    })
  })

  it('refuses, for every bind host, a non-string and a value carrying a newline', () => {
    for (const key of ['apiBindHost', 'vncBindHost', 'controlBindHost']) {
      expect(() => validateSettingsPatch({ [key]: '127.0.0.1\n        published: 22' })).toThrow(/newline|IP address/i)
      expect(() => validateSettingsPatch({ [key]: 8642 })).toThrow(/must be a string/)
      expect(() => validateSettingsPatch({ [key]: null })).toThrow(/must be a string/)
    }
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

describe('validateSettingsPatch — discordApproverRoles', () => {
  it('accepts Discord role IDs, an empty list (nobody by role) and null (unmanaged)', () => {
    expect(validateSettingsPatch({ discordApproverRoles: ['1533670688001495051'] }))
      .toEqual({ discordApproverRoles: ['1533670688001495051'] })
    expect(validateSettingsPatch({ discordApproverRoles: [] })).toEqual({ discordApproverRoles: [] })
    expect(validateSettingsPatch({ discordApproverRoles: null })).toEqual({ discordApproverRoles: null })
  })

  it('rejects names, non-IDs and anything that could break the yaml line', () => {
    expect(() => validateSettingsPatch({ discordApproverRoles: '1533670688001495051' })).toThrow()
    expect(() => validateSettingsPatch({ discordApproverRoles: ['approver'] })).toThrow()
    expect(() => validateSettingsPatch({ discordApproverRoles: ['123'] })).toThrow()
    expect(() => validateSettingsPatch({ discordApproverRoles: ["1533670688001495051'\nx: y"] })).toThrow()
    expect(() => validateSettingsPatch({ discordApproverRoles: ['1533670688001495051,1'] })).toThrow()
  })
})

describe('ConfigService: useStateVolume is automatic unless set', () => {
  it('a fresh install has no value, and null removes a stored one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-state-volume-'))
    try {
      const config = new ConfigService(new Storage(dir))
      // No default: a default would force the layout one way on every install
      // and the Docker engine would never be asked.
      expect(config.getSettings().useStateVolume).toBeUndefined()
      expect(config.updateSettings({ useStateVolume: false }).useStateVolume).toBe(false)
      expect(config.getSettings().useStateVolume).toBe(false)
      config.updateSettings({ useStateVolume: null } as never)
      expect(config.getSettings().useStateVolume).toBeUndefined()
      expect('useStateVolume' in config.getSettings()).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
