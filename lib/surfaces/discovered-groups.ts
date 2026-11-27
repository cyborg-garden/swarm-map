// Which discovered groups the "Discover existing groups" flow may offer to add.
//
// A group is not addable when it is already on the allowlist, or when the
// allowlist is '*' (every group is approved). Adding one to a '*' allowlist
// would narrow it to that single group, so nothing is offered then.

export function addableDiscoveredGroups<G extends { id: string }>(
  discovered: G[],
  surf: { allowedGroups: string[]; allowAllGroups?: boolean },
): G[] {
  if (surf.allowAllGroups) return []
  return discovered.filter(g => !surf.allowedGroups.includes(g.id))
}
