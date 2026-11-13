// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  hermesAdapter,
  adapterForRuntime,
  pickContainerAdapter,
  registerContainerAdapter,
} from '../harness'
import { retiredRuntimeOfRow } from '../runtime-adapter'
import type { ContainerRuntimeAdapter } from '../runtime-adapter'

describe('hermesAdapter Phase-2 members (delegation)', () => {
  it('serviceName follows the hermes-<name> convention', () => {
    expect(hermesAdapter.serviceName('osint')).toBe('hermes-osint')
  })

  it('defaultImageRepo is the hermes-agent-mt repo', () => {
    expect(hermesAdapter.defaultImageRepo).toBe('cyborg-garden/hermes-agent-mt')
  })

  it('generateCompose emits the hermes-<name> service readImageRef/setImageRef operate on', () => {
    const compose = hermesAdapter.generateCompose('echo', 8642, '/data/echo', {
      defaultImage: 'ghcr.io/cyborg-garden/hermes-agent-mt:latest',
    })
    expect(compose).toContain('hermes-echo:')
    expect(hermesAdapter.readImageRef(compose)).toBe('ghcr.io/cyborg-garden/hermes-agent-mt:latest')

    const pinned = hermesAdapter.setImageRef(compose, 'ghcr.io/cyborg-garden/hermes-agent-mt:2026-07-01')
    expect(hermesAdapter.readImageRef(pinned)).toBe('ghcr.io/cyborg-garden/hermes-agent-mt:2026-07-01')
  })
})

describe('adapterForRuntime (overlay-fallback selection)', () => {
  it('resolves hermes explicitly', () => {
    expect(adapterForRuntime('hermes')).toBe(hermesAdapter)
  })

  it('falls back to hermes for undefined (pre-seam overlay rows)', () => {
    expect(adapterForRuntime(undefined)).toBe(hermesAdapter)
  })

  // Was: "falls back to hermes for runtimes with no container adapter (letta)".
  // That fallback is the bug: a leftover row of another runtime became Hermes.
  // Full coverage lives in retired-runtime.test.ts.
  it('does NOT fall back to hermes for a runtime with no container adapter', () => {
    expect(() => adapterForRuntime('letta' as never)).toThrow(/retired/i)
  })

  // Registration mutates the module-global registry, so this block runs LAST
  // in this file; vitest isolates modules per test file.
  it('consults the persisted runtime once a second adapter is registered', () => {
    const customAdapter: ContainerRuntimeAdapter = {
      runtime: 'custom',
      matches: (name) => name.startsWith('custom-'),
      dataDir: (_s, c) => `/data/${c}`,
      readPersona: () => '',
      readModels: () => [],
      serviceName: (name) => `custom-${name}`,
      generateCompose: () => '',
      scaffold: async () => {},
      readImageRef: () => null,
      setImageRef: (compose) => compose,
      defaultImageRepo: 'example/custom',
    }
    registerContainerAdapter(customAdapter)
    // duplicate registration is a no-op
    registerContainerAdapter(customAdapter)

    expect(adapterForRuntime('custom')).toBe(customAdapter)
    // the fix: an overlay-only row with a persisted non-hermes runtime no
    // longer silently degrades to hermes semantics
    expect(adapterForRuntime('custom')).not.toBe(hermesAdapter)
    // name-based discovery picks it up too
    expect(pickContainerAdapter('custom-agent')).toBe(customAdapter)
    // hermes selection is unaffected
    expect(adapterForRuntime('hermes')).toBe(hermesAdapter)
  })
})

describe('retiredRuntimeOfRow: the id is only evidence when nothing better exists', () => {
  const noHome = () => false
  const home = () => true
  const AGENT = 'h_letta_agent-0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9'

  it('a stored tag always wins, whatever the id or the disk say', () => {
    expect(retiredRuntimeOfRow({ id: 'h_iris', runtime: 'letta' }, home)).toBe('letta')
    expect(retiredRuntimeOfRow({ id: 'h_letta_server', runtime: 'hermes' }, noHome)).toBeNull()
  })

  it('an untagged row with any Hermes field is not retired', () => {
    expect(retiredRuntimeOfRow({ id: 'h_letta_server', name: 'letta-server' } as { id: string }, noHome)).toBeNull()
  })

  it('the leftover shape under the server id is retired only when no Hermes home exists for that name', () => {
    const row = { id: 'h_letta_server', surfaceAdmins: { discord: ['1'] } } as { id: string }
    const asked: string[] = []
    expect(retiredRuntimeOfRow(row, (n) => (asked.push(n), false))).toBe('letta-server')
    expect(asked).toEqual(['letta-server'])
    expect(retiredRuntimeOfRow(row, home)).toBeNull()
  })

  it('the old agent id is retired with or without a directory: no Hermes name derives it', () => {
    expect(retiredRuntimeOfRow({ id: AGENT }, home)).toBe('letta')
    expect(retiredRuntimeOfRow({ id: AGENT }, noHome)).toBe('letta')
  })

  it('other ids are never retired by id', () => {
    expect(retiredRuntimeOfRow({ id: 'h_letta_fan' }, noHome)).toBeNull()
  })
})
