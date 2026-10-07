// @vitest-environment node
//
// The public surface must stay reachable and useful:
// - Turning allow-all off without channel-scoped access silences the bot for
//   everyone, not just in DMs (the gateway then refuses every stranger).
// - Hermes's `browser` toolset carries web_search, so disabling it removes
//   the research a public bot exists to do.
// - Plain browsing (camofox) is base research for every agent, public too;
//   captcha solving and browser login stay in the opt-in browser-ops pack,
//   which a public surface refuses.
import { describe, it, expect } from 'vitest'
import { loadBasePackage, validateSelection } from '../base-package'

const pkg = loadBasePackage(process.cwd())
const pub = pkg.surfaces.public

describe('public surface profile', () => {
  it('pairs allow-all off with channel-scoped access', () => {
    expect(pub.env.DISCORD_ALLOW_ALL_USERS).toBe('false')
    expect(pub.env.DISCORD_CHANNEL_SCOPED_ACCESS).toBe('true')
  })

  it('keeps the browser toolset (it carries web_search)', () => {
    expect(pub.disabledToolsets).not.toContain('browser')
  })

  it('tells the policy plugin it is public, so it guards the browser', () => {
    expect(pub.env.SWARM_MAP_SURFACE).toBe('public')
  })

  it('allows the browser backend but forbids captcha, browser login and a shared browser profile', () => {
    expect(pub.forbiddenEnv).not.toContain(pkg.research.browser!.envVar)
    expect(pub.forbiddenEnv).toEqual(expect.arrayContaining(['CAPSOLVER_API_KEY', 'BROWSER_LOGIN_DESCRIPTORS', 'CAMOFOX_USER_ID']))
  })

  it('still refuses the browser-ops pack (captcha + browser login)', () => {
    expect(() => validateSelection(pkg, { surface: 'public', packs: ['browser-ops'] })).toThrow(/public/)
  })
})

describe('research layer: browser', () => {
  it('ships plain browsing (camofox) for every agent', () => {
    expect(pkg.research.browser).toMatchObject({ toolset: 'browser', backend: 'camofox', envVar: 'CAMOFOX_URL' })
    expect(pkg.research.browser!.defaultUrl).toMatch(/^https?:\/\//)
  })
})
