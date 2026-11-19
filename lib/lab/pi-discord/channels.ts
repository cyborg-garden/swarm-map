// The channels one agent is in: its own, and up to nine more beside it, each with what is
// different there. Plain data and functions, with no import that touches a disk or the network,
// so the dashboard's pages can use them as the launcher does.
import type { LabConfig } from './config.ts'

export type ChannelTools = 'inherit' | 'web-only' | 'none'
export const CHANNEL_TOOLS: readonly ChannelTools[] = ['inherit', 'web-only', 'none']
export interface ChannelRules { anyoneInChannel: boolean; tools: ChannelTools }
export const CHANNEL_DEFAULTS: ChannelRules = { anyoneInChannel: false, tools: 'inherit' }
/** How many channels one agent may be in. */
export const MAX_CHANNELS = 10

/** Every channel the agent is in, its own first. */
export function channelIdsOf(c: Pick<LabConfig, 'discord'>): string[] {
  const d = c.discord
  return d.channelIds !== undefined && d.channelIds.length > 0 ? [...d.channelIds] : [d.channelId]
}
/**
 * A channel's own entry: for the agent's own channel its own settings, for another its entry in
 * `perChannel`, or the defaults. An agent that hears anyone hears anyone in every channel, whatever
 * an entry says: that is `discord.anyoneInChannel`, read beside this.
 */
export function channelRulesOf(c: Pick<LabConfig, 'discord'>, channelId: string): ChannelRules {
  if (channelId === c.discord.channelId) return { anyoneInChannel: c.discord.anyoneInChannel, tools: 'inherit' }
  return { ...CHANNEL_DEFAULTS, ...c.discord.perChannel?.[channelId] }
}
/**
 * The discord settings with the channel list replaced: one channel is written as `channelId`
 * alone, as it always was; more add `channelIds` and the entries of `perChannel` that differ.
 * For the dashboard's form, so that what it sends is what the parser keeps.
 */
export function withChannels<D extends LabConfig['discord']>(d: D, own: string, others: Array<{ id: string } & Partial<ChannelRules>>): D {
  const { channelIds: _ids, perChannel: _per, ...rest } = d
  void _ids; void _per
  if (others.length === 0) return { ...rest, channelId: own } as D
  const per: Record<string, ChannelRules> = {}
  for (const o of others) {
    const rules = { ...CHANNEL_DEFAULTS, ...(o.anyoneInChannel === undefined ? {} : { anyoneInChannel: o.anyoneInChannel }), ...(o.tools === undefined ? {} : { tools: o.tools }) }
    if (rules.anyoneInChannel !== CHANNEL_DEFAULTS.anyoneInChannel || rules.tools !== CHANNEL_DEFAULTS.tools) per[o.id] = rules
  }
  return { ...rest, channelId: own, channelIds: [own, ...others.map((o) => o.id)], ...(Object.keys(per).length > 0 ? { perChannel: per } : {}) } as D
}
