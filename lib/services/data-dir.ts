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
 * agentHome() in ./agent-home instead, which does ask.
 */
export function agentHomeForName(name: string): string {
  return name === 'personal' ? personalAgentHome() : newAgentHomeForName(name)
}
