// Letta Code's own rules: what the Letta Code shim promises, on top of the
// shared catalogue (lib/core/rules/catalogue.ts). They are about Letta Code's
// mechanisms, so they hold for Letta Code and say nothing about any other
// harness.
//
// Proven by Letta Code's own tests: `U:<name>` is a test titled `[U:<name>]`
// under lib/runtimes/letta-code/, conformance/suites/ or conformance/rig/.
import type { HarnessRule } from '../pi/rules.ts'

export const LETTA_CODE_RULES: HarnessRule[] = [
  { id: 'letta-code.strict', statement: 'Letta Code is always started in the permission mode where it asks before every tool. The shim has no way to start it in another, and a tool the turn was never offered is refused without asking anyone.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-args', 'U:letta-code-offered', 'U:letta-code-must-fail'] },
  { id: 'letta-code.veto-fails-closed', statement: 'A tool runs only on the exact answer yes. A timeout, an error, a request that cannot be read or no live turn is a no.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-wire'] },
  { id: 'letta-code.pinned-version', statement: 'A Letta Code that is not the version the checks were run against is sent no turn.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-version'] },
  { id: 'letta-code.headless-only', statement: 'Letta Code is only ever started in its headless mode. Its own chat channels belong to its server mode, which is never started.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-args', 'U:letta-code-shim'] },
  { id: 'letta-code.preamble', statement: 'Nothing a sender types, and nothing a sender is called, can pass for the lines that tell Letta Code who is speaking and where.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-preamble'] },
  { id: 'letta-code.env', statement: 'Letta Code is started with a hand-listed environment: nothing inherited from the process that starts it, and its update check and telemetry switched off.',
    klass: 'security', kind: 'guardrail', tests: ['U:letta-code-env', 'U:letta-code-must-fail'] },
]
