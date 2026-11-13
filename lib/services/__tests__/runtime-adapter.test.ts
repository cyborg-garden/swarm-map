// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  hermesAdapter,
  adapterForRuntime,
  pickContainerAdapter,
  registerContainerAdapter,
} from '../harness'
import { findUnmanagedRow, unsupportedRowReason } from '../runtime-adapter'
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

  // There is no default adapter. Full coverage lives in retired-runtime.test.ts.
  it('does NOT fall back to hermes for a runtime with no container adapter', () => {
    expect(() => adapterForRuntime('letta' as never)).toThrow(/retired/i)
  })

  it('reads a null tag (a hand edit) as a missing one', () => {
    expect(adapterForRuntime(null as never)).toBe(hermesAdapter)
    expect(unsupportedRowReason({ runtime: null })).toBeNull()
  })

  it('only the tag decides whether a row is managed', () => {
    const rows = [
      { id: 'h_a', runtime: 'letta' },
      { id: 'h_b', runtime: 'pi-from-the-future' },
      { id: 'h_c', runtime: 'hermes' },
      { id: 'h_d' },
      { id: 'h_letta_server', surfaceAdmins: {} },
    ]
    expect(findUnmanagedRow(rows, 'h_a')).toMatchObject({ reason: 'retired', runtime: 'letta' })
    expect(findUnmanagedRow(rows, 'a')).toMatchObject({ reason: 'retired' })
    expect(findUnmanagedRow(rows, 'h_b')).toMatchObject({ reason: 'unknown', runtime: 'pi-from-the-future' })
    for (const id of ['h_c', 'h_d', 'h_letta_server', 'letta-server', 'h_nobody', 'h_A']) {
      expect(findUnmanagedRow(rows, id), id).toBeNull()
    }
    expect(findUnmanagedRow({ not: 'a list' } as unknown as [], 'h_a')).toBeNull()
  })

  it('a newly registered runtime stops being unknown', () => {
    const tag = 'test-runtime-registered-here'
    expect(unsupportedRowReason({ runtime: tag })).toMatchObject({ reason: 'unknown' })
    registerContainerAdapter({ ...hermesAdapter, runtime: tag as never, matches: () => false })
    expect(unsupportedRowReason({ runtime: tag })).toBeNull()
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
