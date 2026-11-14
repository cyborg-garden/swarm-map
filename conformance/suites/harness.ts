// What the shared suite needs to know about one harness. The lab, the checks
// and the matrix name no harness: everything that differs between harnesses
// comes in through this one object. To put a second harness through the same
// checks, write one of these (see ../harnesses/pi.ts) and hand it to
// runChecks(). Nothing in this folder needs editing.
import type { ModelShape } from '../../lib/door/model-shapes.ts'
import type { Capabilities } from '../../lib/door/protocol.ts'

/** One native tool call, as the scripted model should ask for it. */
export interface NativeToolCall { name: string; args: unknown }

/** What a lab hands the harness so its shim can be started. All of it is minted per lab. */
export interface Cell {
  nonce: string
  /** Where the shim dials the sidecar. */
  link: { host: string; port: number; token: string }
  /** The model route, and what to present there instead of a key. */
  modelBaseUrl: string
  placeholder: string
  /** An empty folder for this lab, under the temp dir. */
  dir: string
  /** The real upstream key. Only a shim that is broken on purpose may touch it. */
  upstreamKey: string
  /** How long the shim waits for a verdict, and how long the in-cell veto waits for the shim. */
  verdictTimeoutMs: number
  vetoTimeoutMs: number
}

export interface MatrixRowInput { id: string; title: string; status: 'not-run' | 'n/a'; reason: string }

/** A shim broken in one way on purpose, and what that must do to the suite. */
export interface BrokenVariant {
  what: string
  /** Checks it must turn red. */
  red: string[]
  /** Checks it must leave green, which shows the suite is not simply red everywhere. */
  green: string[]
}

export interface HarnessUnderTest {
  /** Must equal what the shim says in its hello. */
  caps: Capabilities
  /** Is this the real harness, or a stand-in for CI? Only a real one can produce a matrix. */
  build: 'real' | 'fake'
  /** The wire format it speaks to the model route. */
  modelShape: ModelShape
  /**
   * A patch to the lab's starting policy, for a harness the door would otherwise give
   * nothing: the lab's fixture opens several rooms, and a harness with one memory for
   * the whole agent may be given one. A check's own patch still goes on top.
   * It may only take rooms away: a lab refuses to start for a patch that does anything else.
   */
  policy?: Record<string, unknown>
  /** Native calls of class `shell` that touch a file, dump the environment to a file, and run one command line. */
  shell: { touch(file: string): NativeToolCall; dumpEnv(file: string): NativeToolCall; exec(command: string): NativeToolCall }
  /** Where a tool started by this harness would write `name` so the lab can see it. */
  workFile(cell: Cell, name: string): string
  /** The exact environment the harness process will get, for the F2 preflight. */
  cellEnv(cell: Cell, variant: string): Record<string, string>
  /**
   * What the tripwire inside the harness process saw: how many processes armed it, and every
   * attempt it stopped to reach something that is not this machine. Zero armed means the
   * harness ran unwatched, and the check that reads this fails rather than pass on no evidence.
   */
  tripwire(cell: Cell): { armed: number; attempts: string[] }
  /** Start the shim. `variant` is 'good' or a key of `broken`. */
  start(cell: Cell, variant: string): Promise<{ close(): void }>
  /** Shims of this harness that are broken on purpose. 'chatty' is shared and not listed here. */
  broken: Record<string, BrokenVariant>
  /** Spec checks this suite does not run for this harness, with the reason. */
  rows: MatrixRowInput[]
}

/** The must-fail shim every harness shares: it has no harness behind it at all. */
export const CHATTY: BrokenVariant = {
  what: 'Answers without the model, twice, and for turns nobody opened',
  // It never asks the model, so every check that needs a model answer is red.
  red: ['C1', 'C3'],
  green: [],
}

export function brokenVariants(harness: HarnessUnderTest): Record<string, BrokenVariant> {
  return { ...harness.broken, chatty: CHATTY }
}
