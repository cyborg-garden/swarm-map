// The two secrets a real run needs: the Discord bot token and the model key.
// Each is read from a file the environment points at. Never from the repo,
// never from the config, never from a variable that holds the secret itself.
// What is read is handed to the door and to nothing else: it is not logged,
// not put in an error, and not given to the cell.
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const TOKEN_FILE_ENV = 'SMLAB_DISCORD_TOKEN_FILE'
export const MODEL_KEY_FILE_ENV = 'SMLAB_MODEL_KEY_FILE'

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Why the file a variable points at cannot be used, or undefined if it can. Says where, never what. */
export function secretFileProblem(name: string, env: Record<string, string | undefined>, repoRoot: string): string | undefined {
  const file = env[name]
  if (!file) return `${name} is not set. Point it at a file that holds the secret`
  if (!path.isAbsolute(file)) return `${name} must be an absolute path`
  let stat
  try { stat = lstatSync(file) } catch { return `${name} points at a file that is not there` }
  if (stat.isSymbolicLink()) return `${name} points at a link. Point it at the file itself`
  if (!stat.isFile()) return `${name} does not point at a file`
  if ((stat.mode & 0o077) !== 0) return `${name} points at a file others can read. Run: chmod 600 on it`
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return `${name} points at a file owned by someone else`
  if (inside(realpathSync(file), realpathSync(repoRoot))) return `${name} points inside the repo. Keep the secret outside it`
  const value = readFileSync(file, 'utf8').trim()
  if (value.length < 8 || /\s/.test(value)) return `${name} points at a file that does not hold one secret on one line`
  return undefined
}

/** The secret a variable's file holds. Throws, without the value, if the file cannot be used. */
export function readSecretFile(name: string, env: Record<string, string | undefined>, repoRoot: string): string {
  const problem = secretFileProblem(name, env, repoRoot)
  if (problem) throw new Error(problem)
  return readFileSync(env[name] as string, 'utf8').trim()
}
