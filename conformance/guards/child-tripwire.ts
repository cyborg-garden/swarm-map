// The tripwire for a harness process. The lab starts the harness as a child
// process, and the tripwire armed in a test file cannot see into it. So the
// lab has Node load this file first inside the child (`--import`), where it
// arms the same tripwire and writes what it sees to a log the lab reads back:
//
//   armed <pid>      once per process that loaded it
//   trip <what>      once per attempt to reach something that is not this machine
//
// No `armed` line means the tripwire never ran there, and that is reported as
// a failure, never read as "nothing happened".
//
// It reaches a harness that runs on Node, and any Node process that harness
// starts. It does not reach a program that is not Node (a shell tool running
// curl). Only the Docker cell closes that.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { armTripwire } from './tripwire.ts'

const LOG_VAR = 'LAB_TRIPWIRE_LOG'

/** The environment that makes a Node child process arm the tripwire and log to `logFile`. */
export function childTripwireEnv(logFile: string): Record<string, string> {
  return { NODE_OPTIONS: `--import ${pathToFileURL(import.meta.filename).href}`, [LOG_VAR]: logFile }
}

/** What the children logged: how many processes armed the tripwire, and every attempt it stopped. */
export function readChildTripwire(logFile: string): { armed: number; attempts: string[] } {
  if (!existsSync(logFile)) return { armed: 0, attempts: [] }
  const lines = readFileSync(logFile, 'utf8').split('\n')
  return {
    armed: lines.filter((line) => line.startsWith('armed ')).length,
    attempts: lines.filter((line) => line.startsWith('trip ')).map((line) => line.slice('trip '.length)),
  }
}

// Runs only where the lab asked for it: in a child started with childTripwireEnv().
const log = process.env[LOG_VAR]
if (log) {
  armTripwire({ onTrip: (what) => appendFileSync(log, `trip ${what}\n`) })
  appendFileSync(log, `armed ${process.pid}\n`)
}
