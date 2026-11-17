// What the Docker run covers: which checks run in a cell, which rigs are
// broken on purpose, and what each of those must do. Kept apart from the
// suite so a test that needs no Docker can hold the committed matrix to it.
import { CHECKS, type Check } from '../suites/checks.ts'
import { DOCKER_CHECKS } from './checks.ts'
import { MODEL_FAILURE_CHECKS } from '../suites/failure-checks.ts'
import { TOOL_CHECKS } from '../suites/tool-checks.ts'
import type { GateVariant, RigVariant } from './compose.ts'

// C9p reads a tripwire inside the harness process. In a cell there is none: the wall and the sink do that job (C9).
export const SKIPPED_IN_CELL: Record<string, string> = {
  C9p: 'not run in a cell: it reads a tripwire inside the harness process, and here the wall is checked instead (C9)',
}
/** The checks that run inside a rig, one rig each. */
export const IN_CELL: Check[] = [...CHECKS.filter((c) => !(c.id in SKIPPED_IN_CELL)), ...DOCKER_CHECKS]

/** A rig broken in one way on purpose, the checks run against it, and what each must do. */
export interface BrokenRig { what: string; variant: RigVariant; gate?: GateVariant; seal: boolean; checks: string[]; red: string[]; green: string[] }
export const BROKEN_RIGS: Record<string, BrokenRig> = {
  'route-out': {
    what: 'The cell is also put on the network the sink is on',
    variant: 'route-out', seal: true, checks: ['C9', 'C10'], red: ['S1', 'C9', 'C10'], green: ['S0', 'S2', 'S3'],
  },
  'open': {
    what: 'The cell is also put on an ordinary Docker network, with a route to the internet and to this machine',
    variant: 'open', seal: true, checks: ['C9'], red: ['S1', 'C9'], green: ['S0', 'S2', 'S3'],
  },
  'leaks-env': {
    what: 'The model key of the run is planted in the cell container\'s environment',
    variant: 'leaks-env', seal: true, checks: ['C8', 'C9'], red: ['S3', 'C8'], green: ['S0', 'S1', 'S2', 'C9'],
  },
  'leaks-file': {
    what: 'The model key of the run is written to a file in the cell, and is in no environment and no command line',
    variant: 'leaks-file', seal: true, checks: ['C8'], red: ['S3', 'C8'], green: ['S0', 'S1', 'S2'],
  },
  'writable': {
    what: 'The cell runs as root on a disk it can write',
    variant: 'writable', seal: true, checks: [], red: ['S2'], green: ['S0', 'S1', 'S3'],
  },
  'host-mount': {
    what: 'A folder of this machine is mounted into the cell',
    variant: 'host-mount', seal: true, checks: [], red: ['S3'], green: ['S0', 'S1', 'S2'],
  },
  'socket': {
    what: 'A file of the rig\'s own is mounted where a Docker socket would be',
    variant: 'socket', seal: true, checks: [], red: ['S1', 'S3'], green: ['S0', 'S2'],
  },
  'door-out': {
    what: 'The sidecar\'s container is also put on the network the sink is on',
    variant: 'door-out', seal: true, checks: [], red: ['S1'], green: ['S0', 'S2', 'S3'],
  },
  'other-subnet': {
    what: 'The cell\'s network is made on another block of addresses than the one written down for it',
    variant: 'other-subnet', seal: true, checks: [], red: ['S1'], green: ['S0', 'S2', 'S3'],
  },
  'blind-sink': {
    what: 'The control is put where it cannot reach the sink, so the sink\'s log proves nothing',
    variant: 'blind-sink', seal: true, checks: ['C9'], red: ['S0', 'C9'], green: ['S1', 'S2', 'S3'],
  },
  'gate-kept': {
    what: 'C10 run in a cell that still has its gate, so the denied tool never runs',
    variant: 'good', gate: 'real', seal: false, checks: ['C10'], red: ['C10'], green: [],
  },
}

/** The tool checks, for a harness whose shim can run them. They run in a cell like the rest, one rig each. */
export const TOOLS_IN_CELL: Check[] = [...TOOL_CHECKS, ...MODEL_FAILURE_CHECKS]

/**
 * Cells whose tool gate is broken in one way each, for the tool checks. The
 * rig around them is a sealed one: only the file the harness loads as its
 * gate differs. A tool that reaches the network is `route-out` above (C9).
 */
export const TOOL_RIGS: Record<string, BrokenRig> = {
  'gate-asks-nobody': {
    what: 'The gate in the cell lets every tool run without asking, so nothing is held for an admin',
    // C6m too: with no request to answer, the tool never waits, and the check sees no request posted.
    variant: 'good', gate: 'allows-all', seal: false, checks: ['C6', 'C6d', 'C6m', 'C6b'], red: ['C6', 'C6d', 'C6m'], green: ['C6b'],
  },
  'gate-silence-is-yes': {
    what: 'The gate in the cell lets a tool run when nobody answers it in time',
    variant: 'good', gate: 'silence-is-yes', seal: false, checks: ['C5v', 'C6'], red: ['C5v'], green: ['C6'],
  },
  'gate-runs-more': {
    what: 'The gate in the cell adds a command of its own to a shell call after the call was approved',
    variant: 'good', gate: 'runs-more', seal: false, checks: ['C6x', 'C6'], red: ['C6x'], green: ['C6'],
  },
  'gate-no-path-check': {
    what: 'The gate in the cell does not keep file tools in the scratch folder',
    variant: 'good', gate: 'no-path-check', seal: false, checks: ['W1', 'W1+'], red: ['W1'], green: ['W1+'],
  },
  'gate-no-limits': {
    what: 'The gate in the cell applies no time limit and no output limit',
    variant: 'good', gate: 'no-limits', seal: false, checks: ['L1', 'L2'], red: ['L1', 'L2'], green: [],
  },
}
