import { describe, it, expect } from 'vitest'
import {
  generateStandaloneCompose,
  renderHermesSourceBlock,
  validateExtraAptPackages,
} from './harness-compose'

// extraAptPackages: per-agent Debian packages (e.g. headless LibreOffice for
// one public bot) rendered as the HERMES_EXTRA_APT_PACKAGES build arg on the
// hermes service only, so the rest of the fleet's images are unchanged and a
// regeneration cannot silently drop them.

const agentName = 'cyborg-public'
const port = 8752
const dataDir = '/Users/juni/.hermes-cyborg-public'
const build = { build: '/Users/juni/Documents/GitHub/hermes-agent-mt' }
const OFFICE = ['libreoffice-writer-nogui', 'pandoc', 'fonts-liberation2']

function serviceBlock(compose: string, service: string): string {
  const lines = compose.split('\n')
  const start = lines.findIndex((l) => l === `  ${service}:`)
  if (start < 0) throw new Error(`no service ${service}`)
  let end = start + 1
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}

describe('extraAptPackages', () => {
  for (const [label, vpnEnabled] of [['plain', false], ['VPN', true]] as const) {
    describe(label, () => {
      it('renders the build arg on the hermes service only', () => {
        const compose = generateStandaloneCompose(agentName, port, dataDir, {
          vpnEnabled, imageOrBuild: build, extraAptPackages: OFFICE,
        })
        const hermes = serviceBlock(compose, `hermes-${agentName}`)
        expect(hermes).toContain(
          '    build:\n'
          + `      context: ${build.build}\n`
          + '      dockerfile: Dockerfile\n'
          + '      args:\n'
          + '        HERMES_EXTRA_APT_PACKAGES: "libreoffice-writer-nogui pandoc fonts-liberation2"\n'
          + `    container_name: hermes-${agentName}`)
        expect(serviceBlock(compose, `state-init-${agentName}`)).not.toContain('HERMES_EXTRA_APT_PACKAGES')
      })

      it('is byte-identical to the old output when none are configured', () => {
        const without = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled, imageOrBuild: build })
        const withEmpty = generateStandaloneCompose(agentName, port, dataDir, {
          vpnEnabled, imageOrBuild: build, extraAptPackages: [],
        })
        expect(withEmpty).toBe(without)
        expect(without).not.toContain('args:')
      })
    })
  }

  it('refuses names apt would read as options or the shell would split', () => {
    for (const bad of ['-o', '--allow-unauthenticated', 'a b', 'pkg"', 'x\n    privileged: true', 'Foo', 'pkg=1.0', '']) {
      expect(validateExtraAptPackages([bad])).toMatch(/not a valid Debian package name/)
      expect(() => generateStandaloneCompose(agentName, port, dataDir, {
        imageOrBuild: build, extraAptPackages: [bad],
      })).toThrow(/not a valid Debian package name/)
    }
    expect(validateExtraAptPackages(OFFICE)).toBeNull()
    expect(validateExtraAptPackages(undefined)).toBeNull()
    expect(validateExtraAptPackages('pandoc' as unknown as string[])).toMatch(/must be an array/)
  })

  it('fails loudly for an image-mode agent instead of silently dropping them', () => {
    expect(() => renderHermesSourceBlock({ image: 'ghcr.io/x/y:1' }, ['pandoc'])).toThrow(/local build/)
    expect(renderHermesSourceBlock({ image: 'ghcr.io/x/y:1' }, [])).toBe('    image: ghcr.io/x/y:1')
  })
})
