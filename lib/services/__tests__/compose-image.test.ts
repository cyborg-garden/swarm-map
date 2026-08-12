// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { generateStandaloneCompose, setComposeImage, readComposeImage, readComposeBuildContext } from '../harness-compose'

const REF = 'ghcr.io/cyborg-garden/hermes-agent-mt:2026-06-12'
// Explicit camofox override fixture. Deliberately fake — these tests exercise
// setComposeImage leaving sidecar images untouched, not image validity. The
// real default lives in DEFAULT_CAMOFOX_IMAGE (see harness-compose.test.ts).
const CAMOFOX_FIXTURE = 'ghcr.io/example/camofox-fixture:9.9.9'

describe('readComposeBuildContext', () => {
  it('reads the long-form build context this generator emits', () => {
    const c = generateStandaloneCompose('delta', 8642, '/data/delta', { imageOrBuild: { build: '/src/hermes-agent-mt' } })
    expect(c).toContain('build:')
    expect(c).toContain('context: /src/hermes-agent-mt')
    expect(readComposeBuildContext(c)).toBe('/src/hermes-agent-mt')
  })

  it('reads the shorthand `build: /path` form (older hand-written composes)', () => {
    const c = [
      'services:',
      '  hermes-cyborg:',
      '    build: /Users/juni/Documents/GitHub/hermes-agent-mt',
      '    container_name: hermes-cyborg',
    ].join('\n')
    expect(readComposeBuildContext(c)).toBe('/Users/juni/Documents/GitHub/hermes-agent-mt')
  })

  it('returns null for an image-only compose (nothing to git-sync)', () => {
    const c = generateStandaloneCompose('epsilon', 8642, '/data/epsilon', { imageOrBuild: { image: REF } })
    expect(readComposeBuildContext(c)).toBeNull()
  })

  it('reads the build context from the VPN variant', () => {
    const c = generateStandaloneCompose('zeta', 8642, '/data/zeta', { imageOrBuild: { build: '/src/z' }, vpnEnabled: true, camofoxImage: CAMOFOX_FIXTURE })
    expect(readComposeBuildContext(c)).toBe('/src/z')
  })
})

describe('setComposeImage', () => {
  it('replaces an existing image: line', () => {
    const c = generateStandaloneCompose('alpha', 8642, '/data/alpha', { imageOrBuild: { image: 'old:1' } })
    const out = setComposeImage(c, REF)
    expect(readComposeImage(out)).toBe(REF)
    expect(out).not.toContain('old:1')
  })

  it('replaces a build: block with image:', () => {
    const c = generateStandaloneCompose('beta', 8642, '/data/beta', { imageOrBuild: { build: '/src/hermes' } })
    expect(c).toContain('build:')
    const out = setComposeImage(c, REF)
    expect(readComposeImage(out)).toBe(REF)
    expect(out).not.toContain('build:')
    expect(out).not.toContain('/src/hermes')
    // structure preserved
    expect(out).toContain('container_name: hermes-beta')
    expect(out).toContain('command: gateway')
  })

  it('VPN variant: edits the hermes source block, NEVER the wireguard/camofox images', () => {
    const c = generateStandaloneCompose('gamma', 8642, '/data/gamma', { imageOrBuild: { build: '/src' }, vpnEnabled: true, camofoxImage: CAMOFOX_FIXTURE })
    const out = setComposeImage(c, REF)
    expect(readComposeImage(out)).toBe(REF)
    expect(out).toContain('image: lscr.io/linuxserver/wireguard:latest') // untouched
    expect(out).toContain(`image: ${CAMOFOX_FIXTURE}`) // untouched
    expect(out).not.toContain('build:')
  })

  it('replaces a build: block that has nested args/list children without orphaning lines', () => {
    const c = [
      '# x',
      'services:',
      '  hermes-z:',
      '    build:',
      '      context: /src',
      '      dockerfile: Dockerfile',
      '      args:',
      '        - FOO=bar',
      '        - BAZ=qux',
      '    container_name: hermes-z',
      '    command: gateway',
      '',
    ].join('\n')
    const out = setComposeImage(c, REF)
    expect(readComposeImage(out)).toBe(REF)
    expect(out).not.toContain('FOO=bar') // no orphaned build children
    expect(out).not.toContain('context:')
    expect(out).toContain('    container_name: hermes-z') // sibling key preserved
    expect(out).toContain('    command: gateway')
  })

  it('is idempotent', () => {
    const c = generateStandaloneCompose('delta', 8642, '/data/delta', { imageOrBuild: { image: 'x:1' } })
    expect(setComposeImage(setComposeImage(c, REF), REF)).toBe(setComposeImage(c, REF))
  })

  it('throws if there is no hermes service', () => {
    expect(() => setComposeImage('services:\n  other:\n    image: x\n', REF)).toThrow(/no hermes/)
  })
})

describe('readComposeImage', () => {
  it('returns null for a build-based (local) compose', () => {
    const c = generateStandaloneCompose('eps', 8642, '/d', { imageOrBuild: { build: '/src' } })
    expect(readComposeImage(c)).toBeNull()
  })
})
