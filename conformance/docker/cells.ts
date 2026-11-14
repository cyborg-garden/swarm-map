// The cells the lab can build: one per harness. The rig, the probe and the
// checks are the same for all of them.
import { LETTA_CODE_VERSION, LETTA_CODE_VERSION_LINE } from '../../lib/runtimes/letta-code/caps.ts'
import { PI_CELL, type CellKind } from './compose.ts'

export const LETTA_CODE_BIN = '/usr/local/bin/letta'

export const LETTA_CODE_CELL: CellKind = {
  harness: 'letta-code', name: `letta-code-${LETTA_CODE_VERSION}`, target: 'cell-letta-code', entry: 'letta-code/cell-main.ts',
  version: { command: [LETTA_CODE_BIN, '--version'], env: { DISABLE_AUTOUPDATER: '1', LETTA_CODE_TELEM: '0', DO_NOT_TRACK: '1' }, says: LETTA_CODE_VERSION_LINE },
}

export const CELL_KINDS: Record<string, CellKind> = { [PI_CELL.harness]: PI_CELL, [LETTA_CODE_CELL.harness]: LETTA_CODE_CELL }
