// Which harness the launcher puts in the cell, and what is true of each.
//
// The launcher was written for Pi, and its folder keeps that name. The
// harness is now a setting: `harness` in the config, `pi` when it is left
// out. Everything here is read from what the harness's own shim declares
// (lib/runtimes/<harness>/caps.ts), so a limit is stated in one place.
//
// This file is plain data and is also read by the dashboard's pages: it
// imports nothing that touches a disk, Docker or the network.
import { keepsOneMemory } from '../../core/policy/fit.ts'
import type { Capabilities } from '../../door/protocol.ts'
import { LETTA_CODE_CAPS } from '../../runtimes/letta-code/caps.ts'
import { OPENCODE_CAPS } from '../../runtimes/opencode/caps.ts'
import { PI_CAPS } from '../../runtimes/pi/caps.ts'

export const LAUNCHER_HARNESSES = ['pi', 'letta-code', 'opencode'] as const
export type LauncherHarness = (typeof LAUNCHER_HARNESSES)[number]
/** The harness a config with no `harness` key asks for. */
export const DEFAULT_HARNESS = 'pi' satisfies LauncherHarness

export function isLauncherHarness(v: unknown): v is LauncherHarness {
  return typeof v === 'string' && (LAUNCHER_HARNESSES as readonly string[]).includes(v)
}

export interface HarnessFacts {
  harness: LauncherHarness
  /** The name a person reads. */
  label: string
  /** The one version the checks were run against. The cell image holds this version and no other. */
  version: string
  caps: Capabilities
  /**
   * Whether it keeps one memory for the whole agent, and so is given one room and no other. The
   * door enforces that from what the shim says at hello (`mem.one-scope`). This is the same fact,
   * read from the same declaration, for the pages and the dry run to say.
   */
  oneRoomOnly: boolean
  /** What it cannot do here, in plain lines. Shown by the dry run, the create form and the Rules tab. */
  limits: string[]
}

const LABELS: Record<LauncherHarness, string> = { pi: 'Pi', 'letta-code': 'Letta Code', opencode: 'OpenCode' }
const CAPS: Record<LauncherHarness, Capabilities> = { pi: PI_CAPS, 'letta-code': LETTA_CODE_CAPS, opencode: OPENCODE_CAPS }

const ONE_ROOM = 'One room only. It keeps one memory for the whole agent, so it is given its one channel and no other for as long as its door runs. To move it to another channel, stop it, change the channel, and start it again: the cell and what it remembered are removed at the stop.'
const NO_MEMORY = 'It keeps no memory of its own. It remembers a conversation only until it is restarted.'
// Tools exist for the default harness only, and only when its rules switch one on (docs/lab/tools-slice.md).
const TOOLS: Record<LauncherHarness, string> = {
  pi: 'No tools unless its rules switch one on. A tool runs inside its sealed cell, and a shell command waits for an admin.',
  'letta-code': 'No tools: it reads the messages it is sent and answers in text.',
  // Its shim can hold a call for an admin (docs/lab/acp.md), but the launcher switches tools on for Pi only.
  opencode: 'No tools: it reads the messages it is sent and answers in text.',
}
const NO_DMS = 'No direct messages.'

export function harnessFacts(harness: LauncherHarness): HarnessFacts {
  const caps = CAPS[harness]
  const oneRoomOnly = keepsOneMemory(caps)
  return {
    harness, label: LABELS[harness], version: caps.version, caps, oneRoomOnly,
    limits: [oneRoomOnly ? ONE_ROOM : NO_MEMORY, TOOLS[harness], NO_DMS],
  }
}
