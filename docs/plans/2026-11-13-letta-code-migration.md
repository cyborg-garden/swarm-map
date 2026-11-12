# Plan: move Swarm Map's Letta integration to Letta Code

Written 2026-11-13. Inputs: the spec,
[Harness-agnostic primitives](../specs/2026-11-13-harness-agnostic-primitives.md), and code-reading
notes that are not part of this repository.
File inventory checked against `origin/main` at `bc350c7` with `git grep`. Line numbers below refer
to that commit.
**unverified** = from docs or source reading only. **BLOCKED** = needs the maintainer or a live check.

## Status

| Step | State |
|---|---|
| A0: unknown runtime is never Hermes (R4) | **Done** in the change that added this file |
| A1: remove the bridge, Swarm Map half (R3, R5) | **Done** in the same change |
| A2: remove the old server path, docs, sanitize entry (R1, R2, R6, R7) | **Done** in the same change |
| A3: remove the bridge, Hermes half | **BLOCKED**, see 7.1 |
| B0: spikes | Not started. Needs Docker and a pinned Letta Code version |
| B1 to B7: Letta Code shim | Not started. Waits for the Pi work to freeze the brain protocol |

Where the built Track A differs from the text below:

- **One change, three commits**, not three pull requests. The commits follow A0, A1, A2 and can be
  split.
- **R4 is stricter than written.** A stored row with a retired or unknown runtime is not shown as a
  row in the fleet table. It is left out of `list()` and `get()` altogether, so no per-agent route
  can resolve it, and is reported by `listRetired()` and `GET /api/harnesses/retired`. The fleet page
  lists such rows in their own block with one action, "Forget row".
- **The skip-checks were deleted, not kept.** With those rows gone from `list()`, the
  `runtime === 'letta'` filters in the schedulers have nothing left to skip.
- **The Chinese READMEs and the README test snapshot were not edited.** The sync workflow rewrites
  them after `README.md` changes on `main`. Until that runs they still describe the old integration,
  and the removal guards allow those files by name.
- **`docker.start()` lost its project-name and env-file arguments.** Only the old server bring-up
  used them.
- **`POST /api/setup/deploy` refuses every runtime except `hermes`**, not just the retired ones.
  Before, an unknown value deployed a plain Hermes agent.

## 0. Short version

- Two tracks. **Track A (delete)** can start today. **Track B (Letta Code shim)** waits for the
  Pi work to freeze the brain protocol (spec section 8, PR 3).
- Letta Code runs in **door mode only**: in a cell, started **without** `--channels`, driven over
  its `/ws` socket by a shim. Its built-in Discord/Signal channels are never used. An earlier idea,
  rendering Swarm Map's rules into Letta Code's own `accounts.json`, was rejected by the spec.
- Everything in Track B runs on a laptop with the **local backend**. No Letta account is needed.
- **elizaOS: nothing to delete.** `git grep -i eliza` on `origin/main` returns nothing. The plan
  adds a guard test so it stays that way.
- One known red cell going in: Letta Code's memory (MemFS) is per agent and always on, so it
  cannot be scoped per room. The plan measures it and shows it, it does not hide it.

## 1. What is deleted

### 1a. The Hermes-to-Letta bridge, Swarm Map half (PR A1)

| File | What goes |
|---|---|
| `lib/services/agent-deploy-templates.ts` | `lettaBrain` param (lines 35-58) and the `LETTA_BRAIN_*` lines (223-230) |
| `app/api/setup/deploy/route.ts` | `lettaBrainResult` (45), brain-then-door branch (197-250), `lettaBrain` arg (364), result spread (632), rollback (649-653) |
| `app/(setup)/setup/wizard/page.tsx` | "Letta swarm" runtime choice, `lettaModel`, `LETTA_MODEL_SUGGESTIONS`, pair and budget copy |
| `lib/services/__tests__/agent-deploy-templates.test.ts` | the five `LETTA_BRAIN_*` cases (175-207), replaced by one "never emitted" case |
| `lib/services/__tests__/deploy-route.integration.test.ts`, `deploy-route-google.integration.test.ts` | door + brain cases |

### 1b. The old Letta server path (PR A2)

Whole files:

- `lib/services/letta.ts`, `lib/services/letta-agent-provider.ts`, `lib/services/letta-deploy-templates.ts`
- `docker/letta-compose.yml`
- `app/api/letta/**` (five routes)
- `app/(dashboard)/letta/page.tsx`, `components/harness/letta-agent-detail.tsx`
- `lib/services/__tests__/letta-client.test.ts`, `letta-deploy-templates.test.ts`

Edits:

- `lib/types.ts:21`: drop `'letta' | 'letta-server'` from `Harness['runtime']`.
- `lib/services/index.ts`: drop `services.letta`, `services.lettaAgents`.
- `app/api/harnesses/[id]/route.ts`: drop the `isLettaHarnessId` branch.
- `components/shell/sidebar.tsx`: drop the "Letta" entry.
- `app/(dashboard)/harnesses/page.tsx`, `harnesses/[id]/page.tsx`: drop Letta branches.
- Skip-checks (`runtime === 'letta' || 'letta-server'`): `lib/services/drift.ts`, `db-snapshot.ts`,
  `integrity-scheduler.ts`, `model-update-scheduler.ts` (2), `discord-thread-gate-fleet.ts`,
  `app/api/fleet/chat-updates/route.ts`, `app/api/harnesses/[id]/migrate-db/route.ts`.
- Also mention Letta, found by grep but not in the first inventory: `lib/services/harness.ts`, `docker.ts`,
  `runtime-adapter.ts`, `surface-admins.ts`, `scripts/sync-readme-zh.mjs`,
  `app/api/harnesses/[id]/migrate-db/route.test.ts`, and the three
  `discord-*-fleet.test.ts` files. Read each before editing; some may be comments only.
- Letta cases in `docker.test.ts`, `drift.test.ts`, `runtime-adapter.test.ts`,
  `model-update-scheduler.test.ts`, `surface-admins.test.ts`.
- `sanitize.config.json:49`: remove the allow entry for the example Postgres string.

Docs (PR A2, same change): `docs/runtimes.md` rewritten to "Hermes today, door-mode harnesses
next"; `README.md` and both zh READMEs (runtime table, API table, prerequisites), plus
`scripts/__tests__/fixtures/readme-pair/*`. The zh READMEs go through the existing sync app, not
by hand.

### 1c. The bridge, Hermes half (PR A3, repo `hermes-agent-mt`) — **BLOCKED**, see 7.1

`gateway/letta_brain.py`; `_get_letta_brain`, `_letta_agent_lock`, `_run_agent_via_letta` and the
`gateway.letta_brain.*` / `LETTA_BRAIN_STREAMING` reads in `gateway/run_turn.py`;
`tests/gateway/test_letta_brain.py`, `test_letta_audit_parity.py`;
`website/docs/user-guide/features/letta-brain-mode.md`, the env-var reference rows, the sidebar entry.

Why blocked: if any live agent's `.env` carries `LETTA_BRAIN_*`, removing this code turns that
agent into a plain Hermes agent on its next image update, with no warning. This has not been checked.

### 1d. What deletion does NOT do

- It does not remove the `letta-pgdata` Docker volume or `<dataDir>/letta/.env` on any machine.
  Old agents' memory stays on disk until someone removes it by hand.
- It does not touch a running old Letta server. PR A2 only stops Swarm Map from talking to it.

## 2. What is rewritten

New code lives where the spec says: `lib/runtimes/letta-code/`. Nothing is revived from the old
files; none of it fits (REST vs one socket, Postgres rows vs files on disk).

| Piece | Contents | Spec section |
|---|---|---|
| `shim.ts` | Runs in the cell. Dials the sidecar, sends `hello`, translates the brain protocol to Letta Code's `/ws` | 4.5 |
| `caps.ts` | The capability declaration (below), with the Letta Code version read from `GET /app-server-info` | 4.5, 6 |
| `tool-map.ts` | Every Letta Code tool name mapped to a `ToolClass`. Unlisted means `unknown` | 4.5 |
| `cell/Dockerfile`, compose fragment | Letta Code pinned to one exact version; `letta server --backend local --listen ws://127.0.0.1:4500`, **no `--channels`**; `/root/.letta` on a volume; health `GET /readyz`; cell on the `internal: true` network | 4.9 |
| Model wiring | Provider base URL pointed at the sidecar's model route, placeholder key | 4.6 |
| Memory panel (later) | Read-only view of MemFS files via `list_memory` / `read_memory_file` / `memory_history` through the sidecar | 4.8 |

Protocol translation (every row **unverified** until Step 0):

| Brain protocol | Letta Code `/ws` |
|---|---|
| `turn` | `runtime_start` for (agent, conversation), then `input` with `kind: "create_message"`. One conversation per `sessionKey`; sender goes in a preamble |
| `delta` | `stream_delta` |
| `reply` + `settled` | the last assistant message, then the `stop_reason` event. Which `stop_reason` values mean "truly finished" is the first thing to pin down |
| `tool_request` | `control_request` |
| `tool_verdict` | `approval_response`. Timeout with no verdict answers "deny" |
| `cancel` | Letta Code's cancel command (name not confirmed) |
| `reset` | start a new conversation for that `sessionKey` |

Predicted capability declaration: `ownsChat: true` (so C16 applies), `toolVeto: 'pre-call'`,
`approvalRoundTrip: true`, `modelBaseUrl: true` for OpenAI-compatible only, `mcpClient: true`,
`nativeMemory: 'always-on'`, `sessions: 'many'`, `resume: true`, `usage: 'route-only'`,
`steer` unknown.

Not rewritten: surface rendering (`accounts.json`, `routing.yaml`), a Letta deploy wizard, a Letta
REST client, per-agent `secret_apply`. Door mode makes the first three unnecessary; the fourth
waits for the broker and sidecar tools.

## 3. Conformance tests

### 3a. Removal guards (Track A, run on every PR, no harness)

| # | Check |
|---|---|
| R1 | `git grep -il` for `letta_brain`, `LETTA_BRAIN`, `lettaBrain`, `letta/letta:`, `:8283`, `/v1/agents` finds nothing outside `lib/runtimes/letta-code/` and the changelog |
| R2 | `git grep -i eliza` finds nothing |
| R3 | `generateAgentEnv` never emits a `LETTA_BRAIN_*` line, for any input |
| R4 | A stored `harnesses.json` row with `runtime: 'letta'` or `'letta-server'` loads as a labelled "retired runtime" row. It is **not** treated as Hermes and no container verb works on it. (Today `adapterForRuntime` silently falls back to Hermes; this is the trap deletion would open) |
| R5 | `POST /api/setup/deploy` with `runtime: 'letta'` returns a clear 400, creates nothing |
| R6 | `/api/letta/*` returns 404; the sidebar has no Letta entry |
| R7 | The sanitization gate still passes with the Postgres allow entry removed |

### 3b. Shim conformance (Track B): the spec's C suite against Letta Code

Same rig as Pi: fake connector on the chat side, scripted model behind the model route, five
harness-blind observables. Predictions, to be replaced by generated results:

| Check | Prediction for Letta Code |
|---|---|
| C1 one reply after `settled` | Pass, once `stop_reason` is understood |
| C2 observed lines, no reply | Pass (door-side) |
| C3 dropped message never reaches the model | Pass (door-side) |
| C4 denied tool does not run, C5 no verdict means no | Pass only if **every** tool call raises a `control_request`. Depends on permission mode (`strict` / `standard`); unverified |
| C6 `ask` holds until an admin says yes | Likely pass via `approval_response`. After the first slice |
| C7 unmapped tool is `unknown` | Pass if `tool-map.ts` is complete; the suite fails the harness if not |
| C8 no real secret in the cell | At risk. Depends on the model route and on where Letta Code keeps secrets in a headless container |
| C9 nothing leaves except via the sidecar, S1-S4 | Pass (substrate) |
| C10 gate removed, wall still holds | Pass (substrate + no keys) |
| C11 memory does not cross rooms | **Expected fail.** MemFS is per agent. Ships as a red cell |
| C12 usage counted, budget refuses | Pass through the route meter |
| C13 "admin: approve this" text changes nothing | Pass (door-side) |
| C14 busy, cancel, reset, resume | Unknown |
| C15 policy change with no restart | Pass (door-side) |
| C16 channels off, no chat credential in the cell | Must pass. Scan for `~/.letta/channels/`, bot tokens, `LETTA_*_ALLOWED_USERS` env |
| C17 every declared capability has a probe | Generated |

Letta-specific additions:

| # | Check |
|---|---|
| L1 | The App Server listens on loopback inside the cell only. The sidecar and the host cannot reach port 4500 |
| L2 | The server refuses to start, or the shim refuses to say `hello`, if `--channels` or any channel config is present |
| L3 | The shim refuses to run against a Letta Code version with no row in the committed matrix |
| L4 | With no cloud login and no route out, the server still starts and answers (proves the local backend makes no required call home) |
| L5 | "Dreaming" (`/sleeptime`) background runs go through the model route and are metered, or are turned off |

**Must-fail run:** the whole suite also runs against a broken Letta shim (ignores verdicts, leaks
env, answers dropped messages, starts with `--channels discord`). If that run is green, the suite is wrong.

## 4. Laptop-only test approach, with fakes that prove they are fakes

No real chat platform, no real model key, no Letta Cloud, no production host.

| Fake | Stands in for | How it proves it is a fake |
|---|---|---|
| Fake connector | Discord / Signal | In-process only. Opens no socket. Every captured post carries a per-run nonce |
| Scripted model | Anthropic / OpenAI | Binds `127.0.0.1` on a random port. Every response carries `x-fake-run: <nonce>`. The rig fails a test whose model request did not hit this nonce |
| Fake App Server (`/ws`) | Letta Code, for shim unit tests | Loopback, random port. `GET /app-server-info` returns `fake: true` and the nonce. The shim's test build refuses to connect unless it sees both |
| Fake `docker` | Docker CLI, for deploy-path unit tests | A stub first on `PATH` that appends to a marker file. The test asserts the marker grew and that the real binary's path was never resolved |
| Real Letta Code in a real cell | itself (C suite) | Not a fake, and fenced: `internal: true` network, placeholder keys only |

Rules for the rig itself (each one is a test, per the "fake harness can hit real hosts" lesson):

1. **Refuse real targets.** Any base URL that is not loopback or the compose-internal sidecar name
   aborts the run before the first test.
2. **Refuse real secrets.** If the environment holds anything shaped like a real key
   (`sk-ant-`, `sk-`, a Discord token, `LETTA_API_KEY`), the run aborts. Placeholders use a fixed
   `FAKE-` prefix.
3. **Canary for escape.** A sink host name is planted in the scripted model's tool calls. A hit on
   the sink fails the run, and the rig first proves the sink check can fire by tripping it once on
   purpose.
4. **Canary for the scripted model.** One test points the shim at a dead port and expects a
   failure. If it passes, something is reaching a real model.
5. **A first-run green is not accepted.** Each new check is shown red once (against the broken
   shim or with the feature absent) before it is trusted.

What the laptop cannot show: behaviour with a real model, RAM on a production host, real Discord threading.
Those stay out of scope here.

## 5. Order of test-first steps

Each PR comes from its own worktree off `origin/main`. None is merged by an agent.

### Track A: delete (can start now)

| Step | Red first | Then green by |
|---|---|---|
| A0 | R4: a row tagged `'letta'` is treated as Hermes (passes today, which is the bug) | Make an unknown or retired runtime an explicit error in `adapterForRuntime`; add the "retired runtime" row |
| A1 | R3, R5 | Remove the bridge half in Swarm Map (1a) |
| A2 | R1, R2, R6, R7 | Remove the old server path, docs, sanitize entry (1b). Full existing suite must stay green |
| A3 | Same guards in `hermes-agent-mt` | Remove the bridge there (1c). **BLOCKED** on 7.1 |

A0 goes first on purpose: without it, deleting the type members makes old rows quietly Hermes.

### Track B: Letta Code shim (starts when Pi PR 3 has frozen the protocol)

**B0. Spikes, throwaway code, laptop, about a day.** Each can reshape the plan.

1. Start `letta server --backend local` headless in a container with no network. Does it come up?
   RAM at idle and after one turn.
2. One turn over `/ws` against the scripted model through an OpenAI-compatible base URL.
   Which events mark the end.
3. One tool call held by `control_request`, denied, then allowed. Which permission mode makes
   every tool ask.
4. Where secrets land with no OS credential manager.
5. Start without `--channels`: does any channel code or file appear.
6. Two conversations on one agent: plant a fact in one, ask in the other (the C11 preview).

| Step | Red first | Then green by |
|---|---|---|
| B1 | Shim unit tests against the fake App Server: `hello`, turn, verdict timeout means no, `settled` | `shim.ts`, `caps.ts` |
| B2 | C7 with an empty tool map | `tool-map.ts` |
| B3 | C16, L1, L2, S1-S3 | Cell image and compose, version pinned |
| B4 | C1-C5, C8-C10, C13, C15, must-fail run | Wire the real harness into the rig |
| B5 | C12, L5, C17 | Model route meter; generated matrix gets a Letta Code column |
| B6 | C11 recorded as a fail, with the reason | Nothing. The red cell is the deliverable |
| B7 (later) | C6, C14 | Approval round trip, cancel/reset/resume |

**Done when:** `npm run conformance -- --harness letta-code` runs on a clean laptop, the broken
shim is red, and the matrix shows real results including the C11 fail.

## 6. Parallel or in sequence

- Track A in parallel with the Pi slice: yes. It shares no files with `lib/core/`, `lib/door/` or
  `lib/runtimes/pi/`.
- B0 spikes in parallel with the Pi slice: yes. They are throwaway and inform the protocol.
- B1 onward: after Pi PR 3. Starting earlier means writing the shim twice.

## 7. BLOCKED: needs the maintainer, a live check, or an account

1. **BLOCKED (live check).** Does any live agent `.env` carry `LETTA_BRAIN_*`, and is an old Letta
   server running anywhere with agents on it? Needs a read on the production host, which this work
   may not touch. Gates A3, and decides 7.2.
2. **BLOCKED (decision).** If old Letta agents exist: is any memory worth keeping? There is no
   migration tool; it would be a hand export of memory blocks to Markdown before the server is
   retired.
3. **BLOCKED (decision).** Letta Code cannot keep memory apart per room (C11). Options: allow it
   only as a one-room or DM-only agent; allow it anywhere with a red label; or wait for a fix
   upstream. The plan assumes "one-room or DM-only, enforced at save".
4. **BLOCKED (decision).** Between A2 and B5 there is no Letta in the UI at all. OK, or keep a
   "coming back" placeholder?
5. **BLOCKED (decision, maybe account).** Anthropic models: whether Letta Code's Anthropic
   provider accepts a base URL override is unverified. If not, Letta Code runs on an
   OpenAI-compatible route only, or the real Anthropic key sits in the cell (refused on public
   agents). B0 spike 2 answers the technical half.
6. **BLOCKED (account).** Anything on the Letta **cloud** backend: shared memory, backups, cloud
   agents. Needs a real Letta account. Not needed for anything above.
7. **Reading of the request.** The request is read here as: drop the Hermes-to-Letta bridge and
   elizaOS, move to Letta Code. If elizaOS was meant as something to add, this plan does not cover it.

## 8. Out of scope

- Letta Code's own channels, `accounts.json` / `routing.yaml` rendering, role-to-id expansion.
- Real Discord, Signal or Slack; real model keys; real-platform tests.
- Any deploy, any change to a running agent, any production host.
- Migrating existing Letta agents or their memory (pending 7.1 and 7.2).
- Letta Cloud, the Agent SDK's cloud backend, ACP.
- Per-agent tool secrets (`secret_apply`), broker and sidecar tools for Letta Code.
- A memory editor; a Letta deploy wizard; UI beyond removing the old entries.
- MicroVM or WASM substrate. Docker only.
- Removing `letta-pgdata` volumes from any machine.

## 9. Risks

- **Churn.** Letta Code ships several times a day and the protocol is only partly documented.
  Pin one exact version; a bump re-runs the whole C suite.
- **Tool gate may be leaky.** If some tools never raise `control_request`, C4/C5 fail and Letta
  Code only gets the safe tool set, like a harness with `toolVeto: 'none'`.
- **Weight.** RAM per agent is unknown until B0.
- **A2 is wide.** About fifty files mention Letta. Splitting A1 from A2 keeps each reviewable.
