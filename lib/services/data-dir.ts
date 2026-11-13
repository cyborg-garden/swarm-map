import path from 'path'
import os from 'os'

/** Where Swarm Map keeps its own state (harnesses.json, settings, audit). */
export const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace('~', os.homedir())
  : path.join(os.homedir(), '.hermes-swarm-map')

/**
 * The Hermes home for an agent NAME: `~/.hermes` for "personal",
 * `~/.hermes-<name>` for every other agent. Path arithmetic only: it does
 * not ask whether the name belongs to a Hermes agent. Code that starts from
 * an id or a name it did not get from HarnessService.list()/get() must use
 * agentHome() in ./agent-home instead, which does ask.
 */
export function agentHomeForName(name: string): string {
  return name === 'personal' ? path.join(os.homedir(), '.hermes') : path.join(os.homedir(), '.hermes-' + name)
}
