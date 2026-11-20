import { describe, it, expect } from 'vitest'
import { parseKeyRequestParams } from '@/lib/keys-request'

const params = (qs: string) => new URLSearchParams(qs)

describe('parseKeyRequestParams', () => {
  it('returns null when there is no request param', () => {
    expect(parseKeyRequestParams(params(''))).toBeNull()
    expect(parseKeyRequestParams(params('assign=h_wren&name=Wren'))).toBeNull()
  })

  it('parses a bare provider request', () => {
    expect(parseKeyRequestParams(params('request=hedra'))).toEqual({
      provider: 'hedra',
      assignTo: [],
      name: undefined,
    })
  })

  it('parses comma-separated assign ids and optional name', () => {
    expect(parseKeyRequestParams(params('request=hedra&assign=h_wren,h_ember&name=Wren%20Video'))).toEqual({
      provider: 'hedra',
      assignTo: ['h_wren', 'h_ember'],
      name: 'Wren Video',
    })
  })

  it('normalizes the provider to a lowercase trimmed slug', () => {
    expect(parseKeyRequestParams(params('request=%20Hedra%20'))?.provider).toBe('hedra')
  })

  it('rejects empty or malformed provider slugs', () => {
    expect(parseKeyRequestParams(params('request='))).toBeNull()
    expect(parseKeyRequestParams(params('request=%20%20'))).toBeNull()
    expect(parseKeyRequestParams(params('request=he%3Cdra%3E'))).toBeNull()
  })

  it('drops empty entries in the assign list', () => {
    expect(parseKeyRequestParams(params('request=hedra&assign=h_wren,,%20'))?.assignTo).toEqual(['h_wren'])
  })

  it('filters assign ids against known harness ids when provided', () => {
    const parsed = parseKeyRequestParams(params('request=hedra&assign=h_wren,h_ghost'), ['h_wren', 'h_ember'])
    expect(parsed?.assignTo).toEqual(['h_wren'])
  })

  it('parses the optional identifier param (bluesky handle prefill)', () => {
    const parsed = parseKeyRequestParams(params('request=bluesky&assign=h_heron&identifier=handle.example.com'))
    expect(parsed?.provider).toBe('bluesky')
    expect(parsed?.assignTo).toEqual(['h_heron'])
    expect(parsed?.identifier).toBe('handle.example.com')
  })

  it('leaves identifier undefined when absent or blank', () => {
    expect(parseKeyRequestParams(params('request=bluesky'))?.identifier).toBeUndefined()
    expect(parseKeyRequestParams(params('request=bluesky&identifier=%20%20'))?.identifier).toBeUndefined()
  })
})
