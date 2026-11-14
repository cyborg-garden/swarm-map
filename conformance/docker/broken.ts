// What the Docker run covers: which checks run in a cell, which rigs are
// broken on purpose, and what each of those must do. Kept apart from the
// suite so a test that needs no Docker can hold the committed matrix to it.
import { CHECKS, type Check } from '../suites/checks.ts'
import { DOCKER_CHECKS } from './checks.ts'
import type { RigVariant } from './compose.ts'

// C9p reads a tripwire inside the harness process. In a cell there is none: the wall and the sink do that job (C9).
export const SKIPPED_IN_CELL: Record<string, string> = {
  C9p: 'not run in a cell: it reads a tripwire inside the harness process, and here the wall is checked instead (C9)',
}
/** The checks that run inside a rig, one rig each. */
export const IN_CELL: Check[] = [...CHECKS.filter((c) => !(c.id in SKIPPED_IN_CELL)), ...DOCKER_CHECKS]

/** A rig broken in one way on purpose, the checks run against it, and what each must do. */
export interface BrokenRig { what: string; variant: RigVariant; gate?: 'real' | 'allows-all'; seal: boolean; checks: string[]; red: string[]; green: string[] }
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
  'blind-sink': {
    what: 'The control is put where it cannot reach the sink, so the sink\'s log proves nothing',
    variant: 'blind-sink', seal: true, checks: ['C9'], red: ['S0', 'C9'], green: ['S1', 'S2', 'S3'],
  },
  'gate-kept': {
    what: 'C10 run in a cell that still has its gate, so the denied tool never runs',
    variant: 'good', gate: 'real', seal: false, checks: ['C10'], red: ['C10'], green: [],
  },
}
