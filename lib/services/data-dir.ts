import fs from 'fs'
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

/** The names of the agent homes that exist: `foo` for `~/.hermes-foo`. */
export function existingAgentHomeNames(): string[] {
  const prefix = '.hermes-'
  try {
    return fs
      .readdirSync(os.homedir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name.slice(prefix.length))
  } catch {
    return []
  }
}

const foldsCaseByHome = new Map<string, boolean>()

/**
 * Does the disk under the home directory fold case, so that `~/.hermes-Old`
 * and `~/.hermes-old` are one directory? macOS does by default; Linux does
 * not. Asked of the disk itself: the home directory, spelled in the other
 * case, is either the same directory or it is not there. When the home's
 * name has no letter to change, the answer is "yes": the careful one, since
 * it only ever makes two names count as the same agent.
 */
export function homeFoldsCase(): boolean {
  const home = os.homedir()
  const known = foldsCaseByHome.get(home)
  if (known !== undefined) return known
  const base = path.basename(home)
  const other = base === base.toUpperCase() ? base.toLowerCase() : base.toUpperCase()
  let folds = true
  if (other !== base) {
    try {
      const a = fs.statSync(home)
      const b = fs.statSync(path.join(path.dirname(home), other))
      folds = a.ino === b.ino && a.dev === b.dev
    } catch {
      folds = false
    }
  }
  foldsCaseByHome.set(home, folds)
  return folds
}
