// The Claude Agent SDK shim's own rules: what it promises on top of the
// shared catalogue (lib/core/rules/catalogue.ts). They are about the SDK's
// mechanisms, so they hold for this harness and say nothing about any other.
//
// Proven by its own tests: `U:<name>` is a test titled `[U:<name>]` under
// lib/runtimes/claude-sdk/, conformance/suites/ or conformance/rig/.
import type { HarnessRule } from '../pi/rules.ts'

export const CLAUDE_SDK_RULES: HarnessRule[] = [
  { id: 'claude-sdk.asks-every-call', statement: 'Every call to a tool a session was started with is put to the door first. The SDK would run some calls without asking (reading a file in its work folder, a shell command it judges harmless), so the shim tells it to ask about each tool by name, and has no way to start it otherwise.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-options', 'U:claude-sdk-must-fail'] },
  { id: 'claude-sdk.no-unoffered-tool', statement: 'A session is started with exactly the tools the door offered for its turn. With none offered it has none: no shell, no file tool, no web tool, no sub-agent. A session that reports a tool it was not given is stopped before it is sent anything more. A turn that ends before the session has said which tools it has gives no reply.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-options', 'U:claude-sdk-session', 'U:claude-sdk-shim', 'U:claude-sdk-must-fail'] },
  { id: 'claude-sdk.veto-fails-closed', statement: 'A tool runs only on the exact answer yes. A timeout, an error, a tool the turn was not offered or no live turn is a no.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-session', 'U:claude-sdk-offered'] },
  { id: 'claude-sdk.pinned-version', statement: 'An SDK that is not the version the checks were run against, or that starts another version of Claude Code, is sent no turn.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-version'] },
  { id: 'claude-sdk.no-disk-settings', statement: 'The SDK is started in its minimal mode and told to read no settings: no settings file, no instruction file, no hook, no plugin, no skill, no MCP server and no stored login is picked up from disk.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-options'] },
  { id: 'claude-sdk.error-is-not-a-reply', statement: 'When a model call fails, the SDK ends the turn with the error written where a reply would be. The shim posts no such text: only a turn the SDK marks as finished without error gives a reply.',
    klass: 'behaviour', kind: 'guardrail', tests: ['U:claude-sdk-session'] },
  { id: 'claude-sdk.turn-deadline', statement: 'A turn has until the deadline the door gave it. The SDK retries a failing model call for minutes and waits on a silent one for longer. At the deadline the shim stops that session and tells the door, a turn whose deadline passed while it waited is not started, and the next turn of the room picks its transcript back up. A transcript that cannot be picked up costs one turn: the room then starts a new one.',
    klass: 'behaviour', kind: 'guardrail', tests: ['U:claude-sdk-deadline', 'U:claude-sdk-shim', 'U:claude-sdk-must-fail'] },
  { id: 'claude-sdk.preamble', statement: 'Nothing a sender types, and nothing a sender is called, can pass for the lines that tell the SDK who is speaking and where. A message is never read as one of the SDK\'s own commands.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-preamble'] },
  { id: 'claude-sdk.env', statement: 'The SDK is started with a hand-listed environment: nothing inherited from the process that starts it, a placeholder where a key would go, the model route as its only API address, and its update check, telemetry and error reports switched off.',
    klass: 'security', kind: 'guardrail', tests: ['U:claude-sdk-env', 'U:claude-sdk-must-fail'] },
]
