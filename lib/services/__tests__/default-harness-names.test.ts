import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { defaultHarnessNames, harnessNamesFromEnv, DEFAULT_HARNESSES_ENV, ORG_PUBLIC_HARNESSES_ENV } from '../default-harness-names'
import { MemoryService } from '../memory'
import { Storage } from '../storage'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('defaultHarnessNames', () => {
  it('scans only the stock profile when unset or empty', () => {
    expect(defaultHarnessNames({})).toEqual(['personal'])
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: ' , ' })).toEqual(['personal'])
  })

  it('reads a comma-separated list, trimmed and de-duplicated, in order', () => {
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: 'personal, agent-a,agent-b ,agent-a' }))
      .toEqual(['personal', 'agent-a', 'agent-b'])
  })

  it('ignores anything that is not a plain harness name, since names become paths', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: 'agent-a,../x,Agent,a b,-x,agent_b' }))
      .toEqual(['agent-a'])
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: '../x' })).toEqual(['personal'])
  })

  it('warns once per ignored name instead of dropping it silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = { [DEFAULT_HARNESSES_ENV]: 'agent-a,Agent_Typo' }
    harnessNamesFromEnv(DEFAULT_HARNESSES_ENV, env)
    harnessNamesFromEnv(DEFAULT_HARNESSES_ENV, env)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('"Agent_Typo"')
    expect(String(warn.mock.calls[0][0])).toContain(DEFAULT_HARNESSES_ENV)
  })
})

describe('org-public memory tier', () => {
  const scopeTier = (name: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-home-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    fs.mkdirSync(path.join(home, `.hermes-${name}`, 'memories'), { recursive: true })
    const svc = new MemoryService(new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'tier-store-'))))
    const scope = svc.list([name]).find((s) => s.name === name)
    fs.rmSync(home, { recursive: true, force: true })
    return scope?.tier
  }

  it('is off by default and set per agent through the environment', () => {
    expect(scopeTier('agent-a')).toBe('team')
    vi.stubEnv(ORG_PUBLIC_HARNESSES_ENV, 'agent-a')
    expect(scopeTier('agent-a')).toBe('orgpublic')
    expect(scopeTier('agent-b')).toBe('team')
  })
})
