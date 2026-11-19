/**
 * The agents the keys, tools, memory and surfaces services scan when a caller
 * passes no names. Which agents a host runs is per-deployment, so the list comes
 * from SWARM_MAP_DEFAULT_HARNESSES: comma-separated harness names (e.g. in
 * .env.local). Unset or empty, only the stock Hermes profile (`personal`, whose
 * data dir is ~/.hermes) is scanned. Harnesses created in the app are found
 * through harnesses.json either way.
 *
 * Names become paths (~/.hermes-<name>), so anything that isn't a plain
 * lowercase harness name is dropped.
 */
export const DEFAULT_HARNESSES_ENV = 'SWARM_MAP_DEFAULT_HARNESSES'

const HARNESS_NAME = /^[a-z0-9][a-z0-9-]*$/

export function defaultHarnessNames(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[DEFAULT_HARNESSES_ENV] ?? ''
  const names = raw.split(',').map((s) => s.trim()).filter((s) => HARNESS_NAME.test(s))
  return names.length ? Array.from(new Set(names)) : ['personal']
}
