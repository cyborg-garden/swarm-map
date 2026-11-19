import { describe, it, expect } from 'vitest'
import { defaultHarnessNames, DEFAULT_HARNESSES_ENV } from '../default-harness-names'

describe('defaultHarnessNames', () => {
  it('scans only the stock profile when unset or empty', () => {
    expect(defaultHarnessNames({})).toEqual(['personal'])
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: ' , ' })).toEqual(['personal'])
  })

  it('reads a comma-separated list, trimmed and de-duplicated, in order', () => {
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: 'personal, agent-a,agent-b ,agent-a' }))
      .toEqual(['personal', 'agent-a', 'agent-b'])
  })

  it('drops anything that is not a plain harness name, since names become paths', () => {
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: 'agent-a,../x,Agent,a b,-x,agent_b' }))
      .toEqual(['agent-a'])
    expect(defaultHarnessNames({ [DEFAULT_HARNESSES_ENV]: '../x' })).toEqual(['personal'])
  })
})
