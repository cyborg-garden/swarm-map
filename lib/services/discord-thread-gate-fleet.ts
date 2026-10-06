/**
 * Fleet wiring for the Discord thread gate (lib/services/discord-thread-gate):
 * which agents to look at, the opt-out list, and the once-per-start heal.
 * Kept apart from the pure module so its tests need no services mock.
 */

import { services } from '@/lib/services'
import { agentDataDirForName } from './harness'
import { healDiscordThreadGates, type ThreadGateHealResult, type ThreadGateTarget } from './discord-thread-gate'

/** Every Hermes agent HSM manages, as (name, data dir). Letta has no .env. */
export function fleetThreadGateTargets(): ThreadGateTarget[] {
  const seen = new Set<string>()
  const targets: ThreadGateTarget[] = []
  for (const h of services.harness.list()) {
    if (h.runtime === 'letta' || h.runtime === 'letta-server') continue
    // Same id→name rule the settings route and integrity sweep use.
    const name = h.id.replace(/^h_/, '').replace(/_/g, '-')
    if (seen.has(name)) continue
    seen.add(name)
    targets.push({ name, dataDir: agentDataDirForName(name) })
  }
  return targets
}

export function threadMentionOptOuts(): string[] {
  return services.config.getSettings()?.discordThreadMentionOptOuts ?? []
}

/**
 * Add DISCORD_THREAD_REQUIRE_MENTION=true to every Discord agent's .env that
 * lacks it. Called once per server start from instrumentation.ts. Never
 * throws. Explicit values and opted-out agents are left alone. Containers pick
 * the value up on their next recreate — this does not restart anything.
 */
export function healFleetDiscordThreadGatesAtStartup(): ThreadGateHealResult | null {
  try {
    const result = healDiscordThreadGates(fleetThreadGateTargets(), threadMentionOptOuts())
    if (result.healed.length) {
      console.log(
        `[discord-thread-gate] added DISCORD_THREAD_REQUIRE_MENTION=true to ${result.healed.join(', ')} ` +
        '— takes effect on each agent\'s next recreate',
      )
    }
    return result
  } catch (err) {
    console.error('[discord-thread-gate] startup heal failed:', err)
    return null
  }
}
