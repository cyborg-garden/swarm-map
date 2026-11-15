import type { HabitatTier } from './types'

export const TIER_COLORS: Record<HabitatTier, string> = {
  individual: '#6BB39A',
  team: '#7FA9D6',
  org: '#C7A86B',
  orgpublic: '#D58A5A',
  public: '#C46A6A',
}

export const TIER_LABELS: Record<HabitatTier, string> = {
  individual: 'Individual',
  team: 'Team',
  org: 'Org',
  orgpublic: 'Org + Public',
  public: 'Public',
}

export const TIER_DESCRIPTIONS: Record<HabitatTier, string> = {
  individual: 'Single-user agent with private scope',
  team: 'Shared within a small team',
  org: 'Available to the entire organization',
  orgpublic: 'Org-managed but publicly accessible',
  public: 'Open access, no restrictions',
}

export const TIER_ORDER: HabitatTier[] = [
  'individual', 'team', 'org', 'orgpublic', 'public',
]

export const STATUS_COLORS = {
  running: 'var(--success)',
  idle: 'var(--text-secondary)',
  stopped: 'var(--text-secondary)',
  error: 'var(--danger)',
} as const

export const RISK_COLORS = [
  '#6BB39A', // 1 - safe
  '#7FA9D6', // 2 - low
  '#C7A86B', // 3 - medium
  '#D58A5A', // 4 - high
  '#C46A6A', // 5 - critical
] as const
