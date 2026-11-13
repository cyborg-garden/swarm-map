# The Pi slice: what exists, how to run it, what it proves

This is the first slice of the harness-agnostic lab described in [`primitives.md`](primitives.md),
built by following [`plan-pi.md`](plan-pi.md). Nothing here is wired into the Swarm Map app, the UI
or any running agent. It is a library, a test rig and one command.

## In short

- **One place decides.** `decide()` in `lib/core/` evaluates every "who may it hear and answer"
  rule. No harness is asked to enforce one.
- **One door.** `lib/door/` owns chat in, chat out and model traffic. The harness sits behind it
  with no chat token and a placeholder instead of a model key.
- **Pi is driven through that door.** `lib/runtimes/pi/` is the only Pi-specific code: start it,
  send text, read text, veto a tool.
- **Everything runs on a laptop with fakes.** A scripted room, a scripted model, loopback only.
- **Real Pi 1.5.2 passes all eleven process-level checks.** The Docker cell (the wall) is not built.

## Run it

```bash
npx vitest run                 # everything that runs in CI, no Pi and no Docker needed
npm run conformance:smoke      # one message through the door under plain Node

# The same shim checks against a real Pi install (not in CI):
npm install --prefix /tmp/pi-1.5.2 --ignore-scripts @earendil-works/pi-coding-agent@1.5.2
SWARMLAB_PI_BIN=/tmp/pi-1.5.2/node_modules/.bin/pi npm run conformance
```

`npm run conformance` refuses to run without `SWARMLAB_PI_BIN`, and refuses a Pi that is not the
pinned version. It never skips. A complete run rewrites `conformance/matrix/pi-1.5.2.process.json`.

## What was built

| Part | Where | Tested by |
|---|---|---|
| Policy record, hash, validation | `lib/core/policy/` | `validate.test.ts`, `schema-coverage.test.ts` |
| Rule catalogue (34 rules) | `lib/core/rules/catalogue.ts` | `catalogue.test.ts`: every rule has a test that exists |
| `decide()` | `lib/core/decide.ts` | 34 scenario pairs, 6 seeded properties |
| Brain protocol, framing, shim client | `lib/door/protocol.ts`, `framing.ts`, `brain-server.ts`, `shim-client.ts` | `framing.test.ts`, `brain-server.test.ts` |
| The door, fake connector, sanitizer, receipts, observe buffer | `lib/door/` | `door.test.ts` |
| Model route: key swap, token meter, budget | `lib/door/model-route.ts` | `model-route.test.ts` |
| Pi shim, RPC pump, preamble, tool gate | `lib/runtimes/pi/` | `rpc.test.ts`, `preamble.test.ts`, shim checks |
| Scripted model, fake Pi | `conformance/rig/` | `scripted-model.test.ts` |
| Fake-proof guards | `conformance/guards/` | `tripwire.test.ts`, `preflight.test.ts` |
| Shim checks, broken shims, matrix | `conformance/suites/`, `conformance/broken/`, `conformance/matrix.ts` | `pi.fake.test.ts`, `pi.real.test.ts`, `matrix.test.ts` |

## The shim checks

Each check drives a fresh lab and reads only what can be seen from outside the harness: did the
canary reach the scripted model, did the fake connector get a post stamped by that model, was a
canary file touched, did a planted secret show up.

| # | Check | Fake Pi (CI) | Real Pi 1.5.2 |
|---|---|---|---|
| C1 | A delivered turn gives exactly one reply, from the model, for the right turn | pass | pass |
| C2 | Overheard lines arrive as context on the next turn and cause no reply | pass | pass |
| C3 | A dropped message never reaches the model | pass | pass |
| C4 | A denied tool does not run | pass | pass |
| C4a | A tool the policy never allowed is not offered to the harness | pass | pass |
| C4+ | Positive control: an allowed tool does run | pass | pass |
| C5 | No verdict means no run | pass | pass |
| C8p | No real secret is readable from a tool, and the key swap happened (process level) | pass | pass |
| C12 | Usage is counted; the turn after the budget is spent is refused | pass | pass |
| C13 | Text that claims to be an admin does not change a tool verdict | pass | pass |
| C15 | A policy change takes effect on the next message with no restart | pass | pass |

Must-fail: the same checks against three deliberately broken shims. On real Pi each turned exactly
its named checks red, and nothing else.

| Broken shim | What it does wrong | Turned red |
|---|---|---|
| `ignores-verdicts` | Pi started with no gate | C4, C5, C13 |
| `leaks-env` | The real key planted in Pi's environment | C8p |
| `chatty` | Answers without the model, twice, and for turns nobody opened | every check that needs a model answer |

## How a run proves it is talking to fakes

| Guard | What it does | Negative control |
|---|---|---|
| F1 | `createDoor()` refuses any connector that is not the fake one | A connector with id `discord` must be refused |
| F2 | The environment handed to Pi is checked for anything credential-shaped | `DISCORD_BOT_TOKEN=x` must be refused |
| F4 | A reply only counts if it carries the scripted model's stamp for this run | The `chatty` shim's unstamped replies fail C1 |
| F5 | Work dirs must be under the temp dir and nowhere near an agent's home. The Docker and compose checks exist as functions, with nothing to call them yet | A `~/.hermes-x` path and `DOCKER_HOST=ssh://...` must be refused |
| F6 | An in-process tripwire throws on any connect, lookup or fetch that is not loopback | A connect to TEST-NET must throw and be recorded |

The scripted model refuses any caller without this run's upstream key. The fake connector refuses
any token but this run's. The fake Pi announces itself as fake, and the matrix builder refuses to
build a matrix from it.

## What the spikes found

| # | Question | Result |
|---|---|---|
| 1 | Does `pi --mode rpc -e gate.ts` block a tool through `extension_ui_request`, and report `agent_settled`? | **Yes**, on Pi 1.5.2. `ctx.ui.select` carries the request as its title; allow runs the tool, deny blocks it, and silence blocks it at the timeout |
| 2 | Does `internal: true` on Docker Desktop cut the route out? | **Not run.** No Docker daemon was running on the build machine |
| 3 | Will Pi talk to a scripted OpenAI-shaped endpoint from `models.json` with a placeholder key? | **Yes.** `"api": "openai-completions"`, a custom `baseUrl`, and a placeholder `apiKey`. Whether Pi makes any other network call at start was not measured (that needs the sealed cell) |
| 4 | Does plain Node 24 run the lab's TypeScript with no build step? | **Yes.** It needs `allowImportingTsExtensions` in `tsconfig.json`, and `plain-node.test.ts` now guards it |

## Where the build departed from the plan

- **One branch, not four stacked PRs.** The pieces landed as separate commits in plan order.
- **A process-level suite was added.** The plan put every shim check inside Docker. With no Docker
  to run, the checks were written against a plain Pi process instead. They prove the shim and the
  door. They prove nothing about the cell.
- **A fake Pi was added** so the shim checks run in CI. The first real-Pi run showed the fake was
  wrong in one place: real Pi never asks the gate about a tool that was not declared at start. The
  fake was corrected, and C4 was split into C4 (declared, then denied by the gate) and C4a (never
  declared).
- **`adm.surface`, `tools.lists` and seven door rules were added** to the catalogue, because the
  schema coverage test showed fields and behaviours with no rule.
- **The privilege on a tool event** needs the surface, so the tool event gained an optional
  `surface` field.
- **Threads.** `threadsRequireMention` decides a thread on its own: on means a mention is needed
  even under a free room, off means the thread needs none. The spec did not say.
- **The outbound re-check** re-runs the original inbound decision under the live policy, as well as
  the room check, so removing the sender mid-turn also drops the reply.

## What this does not show

1. **There is no wall yet.** Pi ran as a plain process. S0-S3, C8 (full), C9 and C10 need the
   Docker cell and are listed as not-run in the matrix. Until C10 passes, the tool gate is a
   guardrail with nothing proven behind it.
2. **A scripted model tests plumbing.** Nothing here shows what a real model would do with what it
   overheard.
3. **Identity in Pi is prompt text.** The preamble cannot be forged by a sender, but a model can
   still be talked into things. Privilege is never read from the prompt for that reason.
4. **The key is only redacted from a model reply when it arrives in one piece.** The real
   protection is that the key is in a header the model never sees.
5. **The tool map can be wrong, not just incomplete.**
6. **Mutation checks were run by hand, not committed.** Every rule in `decide()` (36 mutations) and
   the main paths of the door, framing, sanitizer and model route (37 more) were broken on purpose
   once, and each turned a named test red.

## Still to build

| Item | Blocked on |
|---|---|
| Cell image, compose with an internal network, sink and control containers, the Docker runner | A running Docker daemon, then spike 2 |
| S0-S3, C8 (full), C9, C10 | The Docker cell |
| Policy push from Swarm Map with a per-agent secret (`control.ts`) | Nothing; not started |
| C17 (a probe per declared capability), `why` command | Nothing; not started |
| `ask` approvals (C6), memory (C11), real connectors, Hermes native mode | Out of this slice by design |
