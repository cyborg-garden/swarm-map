import { describe, it, expect } from 'vitest'
import { safeNextPath } from './safe-next'

const ORIGIN = 'http://localhost:3000'

describe('safeNextPath', () => {
  it.each([
    ['/', '/'],
    ['/agents/foo?x=1#h', '/agents/foo?x=1#h'],
    ['/keys?request=abc', '/keys?request=abc'],
    ['/harnesses/123', '/harnesses/123'],
  ])('allows same-origin path %s', (input, expected) => {
    expect(safeNextPath(input, ORIGIN)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    '',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'https://evil.com',
    'http://evil.com/',
    '//evil.com',
    '///evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    '\\/evil.com',
    '%2F%2Fevil.com',
    '/%09/evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    '\n//evil.com',
    ' //evil.com',
    'evil.com',
    'agents/foo',
    '/\u0000/evil.com',
    'http://localhost:3000.evil.com/',
    'http://localhost:3000@evil.com/',
    'http://localhost:3000/',
  ])('rejects %j', (input) => {
    expect(safeNextPath(input as string | null | undefined, ORIGIN)).toBe('/')
  })

  it('never returns something that leaves the origin when navigated', () => {
    const attacks = ['//evil.com', '/\\evil.com', '/%2F/evil.com', '/%5Cevil.com', '/.//evil.com']
    for (const a of attacks) {
      const out = safeNextPath(a, ORIGIN)
      expect(new URL(out, ORIGIN).origin).toBe(ORIGIN)
      expect(out.startsWith('/')).toBe(true)
      expect(out.startsWith('//')).toBe(false)
      expect(out.startsWith('/\\')).toBe(false)
    }
  })
})

describe('safeNextPath double-encoding', () => {
  it.each(['/%5Cevil.com', '/%2F/evil.com', '/%0a/evil.com', '/%E0%A4%A'])('rejects %j', (input) => {
    expect(safeNextPath(input, ORIGIN)).toBe('/')
  })
})
