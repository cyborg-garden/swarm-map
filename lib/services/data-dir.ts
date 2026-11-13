import path from 'path'
import os from 'os'

/** Where Swarm Map keeps its own state (harnesses.json, settings, audit). */
export const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace('~', os.homedir())
  : path.join(os.homedir(), '.hermes-swarm-map')

/** `~/.hermes`: the personal agent's home, and the root install. */
export const personalAgentHome = (): string => path.join(os.homedir(), '.hermes')

/**
 * `~/.hermes-<name>` with no special case. This is where a NEW agent's home
 * is created (create and deploy have always put even an agent named
 * "personal" here). To find an EXISTING agent's home use agentHomeForName.
 */
export function newAgentHomeForName(name: string): string {
  return path.join(os.homedir(), '.hermes-' + name)
}

/**
 * The Hermes home for an agent NAME: `~/.hermes` for "personal",
 * `~/.hermes-<name>` for every other agent. Path arithmetic only: it does
 * not ask whether the name belongs to a Hermes agent. Code that starts from
 * an id or a name it did not get from HarnessService.list()/get() must use
 * agentHome() in ./agent-home instead, which asks the disk and the stored
 * rows (see ./home-resolver for the rule).
 */
export function agentHomeForName(name: string): string {
  return name === 'personal' ? personalAgentHome() : newAgentHomeForName(name)
}

/** The directory entry an agent's home has inside the home directory. */
export function agentHomeEntry(name: string): string {
  return name === 'personal' ? '.hermes' : '.hermes-' + name
}

/**
 * The agent a directory entry of the home directory is the home of, or null
 * when the entry is not an agent home. `.hermes` is "personal". An entry
 * `.hermes-personal` is nobody's: "personal" already has a home.
 */
export function agentNameOfHomeEntry(entry: string): string | null {
  if (entry === '.hermes') return 'personal'
  const prefix = '.hermes-'
  if (!entry.startsWith(prefix)) return null
  const name = entry.slice(prefix.length)
  return name === 'personal' ? null : name
}
