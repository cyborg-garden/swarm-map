// @vitest-environment node
//
// The public surface must stay reachable and useful:
// - Turning allow-all off without channel-scoped access silences the bot for
//   everyone, not just in DMs (the gateway then refuses every stranger).
// - Hermes's `browser` toolset carries web_search, so disabling it removes
//   the research a public bot exists to do.
import { describe, it, expect } from 'vitest'
import { loadBasePackage } from '../base-package'

const pub = loadBasePackage(process.cwd()).surfaces.public

describe('public surface profile', () => {
  it('pairs allow-all off with channel-scoped access', () => {
    expect(pub.env.DISCORD_ALLOW_ALL_USERS).toBe('false')
    expect(pub.env.DISCORD_CHANNEL_SCOPED_ACCESS).toBe('true')
  })

  it('keeps the browser toolset (it carries web_search)', () => {
    expect(pub.disabledToolsets).not.toContain('browser')
  })
})
