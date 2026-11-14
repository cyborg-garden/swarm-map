// Pi's own rules: what the Pi shim promises, on top of the shared catalogue
// (lib/core/rules/catalogue.ts). They are about Pi's mechanisms, so they hold
// for Pi and say nothing about any other harness. A harness whose tool veto
// is a callback in its shim, for one, has no gate file that could fail to load.
//
// Proven by Pi's own tests: `U:<name>` is a test titled `[U:<name>]` under
// lib/runtimes/pi/, conformance/suites/ or conformance/rig/.

export interface HarnessRule {
  id: string
  /** One plain sentence. */
  statement: string
  klass: 'security' | 'behaviour'
  kind: 'wall' | 'guardrail'
  tests: string[]
}

export const PI_RULES: HarnessRule[] = [
  { id: 'pi.gate-loaded', statement: 'Pi is sent no turn until its tool gate has said it is loaded, and a Pi whose gate is missing or silent is sent nothing at all.',
    klass: 'security', kind: 'guardrail', tests: ['U:pi-gate-ready', 'U:must-fail'] },
  { id: 'pi.gate-fails-closed', statement: 'Pi\'s tool gate lets a tool run only on the exact answer allow. A timeout, a cancel, an error or no channel blocks it.',
    klass: 'security', kind: 'guardrail', tests: ['U:pi-gate', 'U:pi-rpc'] },
  { id: 'pi.preamble', statement: 'Nothing a sender types, and nothing a sender is called, can pass for the lines that tell Pi who is speaking and where.',
    klass: 'security', kind: 'guardrail', tests: ['U:pi-preamble'] },
  { id: 'pi.env', statement: 'Pi is started with a hand-listed environment: nothing inherited from the process that starts it, and fetching, telemetry and the version check switched off.',
    klass: 'security', kind: 'guardrail', tests: ['U:pi-env', 'U:must-fail'] },
]
