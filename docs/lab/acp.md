# ACP harnesses through the door, and OpenCode

The Agent Client Protocol (ACP, [agentclientprotocol.com](https://agentclientprotocol.com),
protocol version 1) is JSON-RPC over stdio. A client starts an agent as a subprocess, opens a
session, sends prompts, and reads what the agent does as `session/update` notifications. Before
the agent runs a tool it can ask the client with `session/request_permission`.

The door now has one shim for any agent that speaks ACP (`lib/runtimes/acp/`), and OpenCode is
the first agent behind it (`lib/runtimes/opencode/`). The contracts are in
[`primitives.md`](primitives.md), the ask flow in [`tools-slice.md`](tools-slice.md).

## In short

- **The shim is the ACP client.** It runs in the sealed cell beside the agent, like every other
  shim, and decides nothing. Each permission request goes to the door as a `tool_request`, and
  `decide()` answers it, with an admin's yes in the room when the rules say ask.
- **Once only.** The answer is always `allow_once` or `reject_once`. An "always" option is never
  picked, and the door never offers one in the room. With no once-option to pick, the answer is
  `cancelled`.
- **A yes is for one call.** The door's yes carries the hash of the call it decided on. The shim
  works out the hash of the call it asked about and answers yes only if the two match. The same
  call asked again, or a changed one, is a new request.
- **Unknown means no.** A tool kind the shim does not map (`other`, `fetch`, `search`, `think`,
  anything ACP does not name) is refused without asking the door, and so is a tool the turn was
  not offered, and a call that names a path outside the scratch folder.
- **No client methods.** The shim offers the agent no file and no terminal methods, and answers
  a call to one with "method not found". Those methods would put the door in charge of real
  work, which is only worth having if the door then holds every path and command. Until it
  does, they are not advertised.
- **The model is the door's.** OpenCode's only provider is the door's model route, with a
  placeholder where a key would go. Nothing in the cell holds a key.

## What ACP cannot do, and what is done about it

ACP's permission request is **advisory**. The agent runs the tool, not the client. An agent that
ignores a no, or never asks, still runs the tool. Nothing in the protocol can stop it.

So the shim watches what the agent reports. A call reported `completed` that the door did not say
yes to, or one whose command, file or folder is not the one the yes was for, is a breach. The shim then:

1. reports the turn to the door as an error, so its reply is never posted and the door writes a
   receipt;
2. stops the agent's process, and starts the next turn on a new session.

A call reported `completed` after its turn is over, that was never said yes to, also stops the
process and drops its session; there is no turn left to fail.

That is caught **after** the tool ran. What bounds it **before** is the cell: no network but the
door, no secret, a read-only disk but for its own folders. That is why an ACP agent is meant to run
in the same sealed cell as the other harnesses. The cell checks (S0-S3, C8, C9, C10) were run
with OpenCode in the cell and pass, on one machine and one Docker
(`conformance/matrix/opencode-1.19.5.docker.json`). For C10, "the gate removed" means the shim is
cut out altogether: it is asked nothing and shown no tool call. OpenCode is not yet one of the
launcher's harnesses: the launcher's own path, with a real chat surface, has no run for it.

What the shim does not hold, because the agent runs its own tools:

- **The time and output limits** of a shell call. OpenCode applies its own.
- **Links in the scratch folder.** A path is checked as written. OpenCode resolves its folder
  through links and asks separately before it reaches outside it; that rule is denied.
- **The command policy's allow list without a request.** Every call is put to the door, so an
  allowed command still runs at once, but the shim cannot see what the command did.
- **A breach the agent does not report.** The watch reads the agent's own updates.
- **A call that ran anyway and then reported `failed`.** To the shim it looks the same as a call
  that was refused.
- **An edit is shown as its diff.** OpenCode 1.19.5 asks about every edit and write with the file
  and the diff. An edit that asks without a diff is refused.

## OpenCode

Pinned to **OpenCode 1.19.5** (MIT). The shim sends no prompt to an agent that reports another
name or version at `initialize`. It starts `opencode acp`, one process per conversation, with:

- a config it writes into OpenCode's home: the door as the only provider, every offered tool set
  to `ask`, every other tool `deny` (which removes it), `external_directory` denied, sessions not
  named by a model call of their own, and the turn carried on after a no;
- the same permission rules in `OPENCODE_PERMISSION`;
- `OPENCODE_DISABLE_PROJECT_CONFIG`, so nothing the agent writes into the scratch folder can
  change its rules or be read into a later prompt;
- a new, empty global config folder for every process (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`),
  so instructions, plugins or rules a shell call wrote into one are never read by the next;
- its update check, model list fetch, default plugins, LSP downloads and its start-up package
  install switched off, and nothing inherited from the shim's environment.

Its tools, by the names its rules use: `bash` (shell), `read` (file_read), `edit` (file_write,
which covers its write and patch tools too). A changed tool list restarts its process on the same
session. The launcher does not offer it yet: that waits for a run of the launcher's own path.

## The checks

| Where | What | Run here |
|---|---|---|
| `lib/runtimes/acp/__tests__/` | The client and the shim against a scripted ACP agent (a small program speaking JSON-RPC over stdio): once only, the hash, unknown kinds, paths, client methods, the version pin, and each kind of breach | CI, no Docker |
| `conformance/suites/opencode.fake.test.ts` | The shared suite and the ask flow (C6, C6n, C6d, C6t, C6x, C6r) against a fake OpenCode, and nine broken shims and agents | CI, no Docker |
| `conformance/suites/opencode.real.test.ts` | The same against a real OpenCode, as a process | by hand |
| `conformance/suites/opencode.docker.test.ts` | The same in a sealed Docker cell, plus S0-S3, C8, C9, C10 and the broken rigs | by hand, on a machine with Docker: 38 of 38 pass |

Broken on purpose, each of which must turn its named checks red:

| Broken | What it does | Caught by |
|---|---|---|
| `allows-all` | OpenCode's rules set to allow: it asks nobody | C4, C4a, C4p, C4+, C5, C5v, C15t and the ask flow |
| `ignores-reject` | Every no reaches OpenCode as a yes: the agent acts on a refused call | C4, C4p, C5, C5v, C6n, C6d, C6t, C6r, and the shim's breach report |
| `picks-always` | Every yes reaches OpenCode as "always allow" | C6r, and the shim's breach report on the next call |
| `other-version` | Reports a version the checks were not run against | every check that needs a turn |
| `dials-out`, `leaks-env`, `inherits-env`, `unwatched`, `chatty` | As for the other harnesses | as for the other harnesses |

```bash
npx vitest run                                    # everything in CI
npm install --prefix /tmp/opencode-1.19.5 --ignore-scripts opencode-ai@1.19.5
SWARMLAB_OPENCODE_BIN=/tmp/opencode-1.19.5/node_modules/opencode-<platform>/bin/opencode npm run conformance -- opencode
npm run conformance:docker:build -- opencode      # once per state of the code; the only step that uses the network
npm run conformance:docker -- opencode
```

A real OpenCode is a compiled program, so the process-level run watches its traffic through a
proxy it is told to use, as for the Claude Agent SDK, not with the tripwire. Only the cell shows
that nothing else left.
