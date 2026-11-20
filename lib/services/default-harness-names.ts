/**
 * Per-deployment agent names, read from the environment (e.g. .env.local) as
 * comma-separated harness names.
 *
 * SWARM_MAP_DEFAULT_HARNESSES: the agents the keys, tools, memory and surfaces
 * services scan when a caller passes no names. Unset or empty, only the stock
 * Hermes profile (`personal`, whose data dir is ~/.hermes) is scanned. Harnesses
 * created in the app are found through harnesses.json either way.
 *
 * SWARM_MAP_ORG_PUBLIC_HARNESSES: agents whose memory scope is shown as
 * org-managed but public (`orgpublic`). Unset, none are.
 *
 * Names become paths (~/.hermes-<name>), so anything that isn't a plain
 * lowercase harness name is ignored, with a warning so a typo is visible.
 */
export const DEFAULT_HARNESSES_ENV = 'SWARM_MAP_DEFAULT_HARNESSES'
export const ORG_PUBLIC_HARNESSES_ENV = 'SWARM_MAP_ORG_PUBLIC_HARNESSES'

const HARNESS_NAME = /^[a-z0-9][a-z0-9-]*$/
const warned = new Set<string>()

type Env = Record<string, string | undefined>

export function harnessNamesFromEnv(varName: string, env: Env = process.env): string[] {
  const names: string[] = []
  for (const raw of (env[varName] ?? '').split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (HARNESS_NAME.test(name)) {
      if (!names.includes(name)) names.push(name)
    } else if (!warned.has(`${varName}:${name}`)) {
      warned.add(`${varName}:${name}`)
      console.warn(`[swarm-map] ${varName}: ignoring ${JSON.stringify(name)}: harness names are lowercase letters, digits and dashes`)
    }
  }
  return names
}

export function defaultHarnessNames(env: Env = process.env): string[] {
  const names = harnessNamesFromEnv(DEFAULT_HARNESSES_ENV, env)
  return names.length ? names : ['personal']
}
