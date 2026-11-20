// OpenCode's own rules: what the OpenCode shim, and the ACP client under it,
// promise on top of the shared catalogue (lib/core/rules/catalogue.ts). They
// are about ACP's and OpenCode's mechanisms, so they hold for OpenCode and say
// nothing about any other harness.
//
// Proven by tests: `U:<name>` is a test titled `[U:<name>]` under
// lib/runtimes/opencode/, lib/runtimes/acp/ or conformance/suites/.
import type { HarnessRule } from '../pi/rules.ts'

export const OPENCODE_RULES: HarnessRule[] = [
  { id: 'opencode.once-only', statement: 'A permission request is only ever answered with a once-option. An "always" option is never picked, and the door never offers one in the room.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-once-only', 'U:opencode-once-only', 'U:opencode-must-fail'] },
  { id: 'opencode.hash-bound', statement: 'A call runs only on the door\'s yes for that call: the yes must carry the hash of the call the shim asked about. A changed call is asked about again.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-hash-bound', 'U:acp-reask'] },
  { id: 'opencode.veto-fails-closed', statement: 'A timeout, an error, a request that cannot be read or no live turn is a no.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-veto-fails-closed', 'U:acp-offered'] },
  { id: 'opencode.unclassified-denied', statement: 'A tool kind the shim does not map, or a tool the turn was not offered, is refused without asking the door. OpenCode is started with every other tool denied.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-unclassified', 'U:acp-offered', 'U:opencode-config'] },
  { id: 'opencode.scratch-paths', statement: 'A call that names a path outside the scratch folder, or a shell that runs anywhere else, is refused without asking the door.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-scratch-folder'] },
  { id: 'opencode.breach', statement: 'An agent that reports running a call it was not given a yes for, or a different call (another command, another file, another folder) from the one it was given a yes for, has its turn reported to the door as an error, and its process and session are dropped. A call reported finished between turns that was never given a yes drops the process and session too.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-breach', 'U:opencode-breach'] },
  { id: 'opencode.no-client-methods', statement: 'The shim offers OpenCode no file or terminal methods, and refuses a call to one.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-no-client-methods'] },
  { id: 'opencode.pinned-version', statement: 'An OpenCode that does not report the version the checks were run against is sent no prompt.',
    klass: 'security', kind: 'guardrail', tests: ['U:acp-pinned-version', 'U:opencode-must-fail'] },
  { id: 'opencode.env', statement: 'OpenCode is started with a hand-listed environment: nothing inherited, its update check, model list fetch, default plugins and LSP downloads off, no config or instruction file read from the scratch folder, and its global config read from a new, empty folder for every process.',
    klass: 'security', kind: 'guardrail', tests: ['U:opencode-env', 'U:opencode-must-fail'] },
]
