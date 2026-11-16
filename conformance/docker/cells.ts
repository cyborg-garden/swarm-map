// The cells the lab can build: one per harness. The rig, the probe and the
// checks are the same for all of them.
import { CLAUDE_SDK_VERSION, CLAUDE_SDK_VERSION_LINE } from '../../lib/runtimes/claude-sdk/caps.ts'
import { LETTA_CODE_VERSION, LETTA_CODE_VERSION_LINE } from '../../lib/runtimes/letta-code/caps.ts'
import { PI_CELL, SWARM_ROOT, type CellKind } from './compose.ts'

export const LETTA_CODE_BIN = '/usr/local/bin/letta'

export const LETTA_CODE_CELL: CellKind = {
  harness: 'letta-code', name: `letta-code-${LETTA_CODE_VERSION}`, target: 'cell-letta-code', entry: 'letta-code/cell-main.ts',
  version: { command: [LETTA_CODE_BIN, '--version'], env: { DISABLE_AUTOUPDATER: '1', LETTA_CODE_TELEM: '0', DO_NOT_TRACK: '1' }, says: LETTA_CODE_VERSION_LINE },
}

export const CLAUDE_SDK_CELL: CellKind = {
  harness: 'claude-sdk', name: `claude-sdk-${CLAUDE_SDK_VERSION}`, target: 'cell-claude-sdk', entry: 'claude-sdk/cell-main.ts',
  // The SDK is a package and a program. A script in the image asks both, with the offline environment the shim would give them.
  version: { command: ['node', `${SWARM_ROOT}/conformance/docker/claude-sdk/version.ts`], env: {}, says: CLAUDE_SDK_VERSION_LINE },
}

export const CELL_KINDS: Record<string, CellKind> = {
  [PI_CELL.harness]: PI_CELL, [LETTA_CODE_CELL.harness]: LETTA_CODE_CELL, [CLAUDE_SDK_CELL.harness]: CLAUDE_SDK_CELL,
}
