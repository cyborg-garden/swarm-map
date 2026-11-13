# Build plan: the first Pi slice in Swarm Map

Written 2026-11-13, before any code. Follows [`primitives.md`](primitives.md) (sections 4, 5, 7, 8).
Pi facts were from Pi 1.5.2's docs and source only. Repo facts were checked against `main` at `bc350c7`.
Anything marked **unverified** was to be replaced by a test result in Step 0.

**Status: built, with departures.** [`pi-slice.md`](pi-slice.md) says what exists, what the spikes found,
where the build departed from this plan, and what is still blocked. This page is kept as written,
so the plan and the outcome can be compared.

## 0. The slice in ten lines

- One Pi agent in a Docker cell. A sidecar ("the door") owns chat in, chat out and model traffic.
- Chat is a **fake connector** (a scripted room). The model is a **scripted model** (a tiny local server).
- No real chat platform, no real model key, no Hermes change, no UI change, nothing deployed.
- The whole Docker rig runs on networks with **no route out**, including the test runner itself.
- Every test run first proves it is talking to the fakes, with a negative control, or refuses to run.
- Four small PRs, each test-first. Done = `npm run conformance -- --harness pi` green on a clean laptop,
  the deliberately broken shims red, and a matrix file with a Pi column generated from test output.
- No new npm dependency in the repo. Pi is installed only inside the cell image, pinned at 1.5.2.

## 1. Repo facts this plan leans on (checked)

| Fact | Where | Consequence |
|---|---|---|
| Tests are vitest 4, `environment: 'jsdom'`, globals on | `vitest.config.ts` | Every lab test file starts with `// @vitest-environment node` |
| CI runs `npx vitest run` then `npx tsc --noEmit`, Node 24, no Docker step | `.github/workflows/test.yml` | D, P and G tests must pass with no Docker. Docker suites are a separate config, not in CI in this slice |
| No `tsx`, no bundler for server-side scripts in devDependencies | `package.json` | Sidecar, shim and rig are written in erasable-only TypeScript with relative `.ts` imports, so plain Node 24 runs them (**unverified**, Step 0 spike 4) |
| A regex sanitization gate runs on every PR | `.github/workflows/sanitization-gate.yml` | No committed string may be shaped like a real key. All fake secrets are minted at run time |
| `lib/core/`, `lib/door/`, `lib/runtimes/`, `conformance/` do not exist | `git ls-tree origin/main` | All new. No existing file is edited except `package.json`, `vitest.config.ts`, `tsconfig.json`, `.gitignore` |
| Pi needs Node >= 22.19 | Pi `package.json` | Cell image is `node:24-slim` |

## 2. Shape of the test rig

```
 compose project  swarmlab-<nonce>          (every network: internal: true)

   rig-net ──────────────────────────────┐
     runner   vitest + fake connector + scripted model + control client
     sidecar  door | model route | receipts | heartbeat
   cell-net ─────────────────────────────┤   (sidecar is on both; nothing else is)
     cell     shim -> pi --mode rpc -e gate.ts      no chat token, placeholder key only
   outside-net ──────────────────────────┘   (stands in for "the internet")
     sink     logs every connection it gets
     control  one-shot container; hits sink once to prove the sink can be hit
```

- The runner is a container too. So the fake connector and scripted model are in-process objects in
  the same Node process as the tests, and the runner itself has no route out.
- `sink` is the only thing on `outside-net`. The cell and the sidecar are not on it. A hit on `sink`
  from anything but `control` fails the run.
- Results leave the rig through the exit code and one bind-mounted output folder
  (`conformance/out/`, git-ignored).
- The only step that needs the network is `docker build` (pulls `node:24-slim`, installs Pi). It is a
  separate command (`npm run conformance:build`). The run uses `--pull never`.

## 3. The fakes

### 3.1 Fake connector (`lib/door/connectors/fake.ts`)
Implements `SurfaceConnector` with `id: 'fake'`. A first-class member, as the spec says.
- **In:** `script.say({ room, sender, text, mention, isDm, ... })` pushes an `InboundEvent`.
  `script.invite(...)` pushes an `InviteEvent` (used by P tests only).
- **Out:** `send()` appends to an in-memory ledger `{ nonce, room, text, turnId, ts }` and returns a
  receipt. Nothing is ever sent anywhere.
- **Facts:** `facts()` answers from a table in the scenario (roles, paired users).
- `connect(creds)` throws unless `creds.token` starts with `FAKECHAT-` followed by this run's nonce.

### 3.2 Scripted model (`conformance/rig/scripted-model.ts`)
A `node:http` server speaking the OpenAI chat-completions shape (streaming SSE), because Pi's
`models.json` takes `"api": "openai-completions"` with a custom `baseUrl` (`docs/models.md`).
- Matches on a **canary string** in the request body and plays the scripted reply: plain text, or a
  tool call followed by text on the next request.
- Keeps a log of every request (body, `Authorization` header). `heard` and `secretSeen` read this log.
- Stamps every text reply with `FAKE-MODEL-<nonce>`.
- Refuses any request whose bearer is not `UPSTREAM-<nonce>` (the stand-in for "the real key" that
  only the sidecar holds).
- Returns `usage` numbers so the meter has something to count.

### 3.3 Echo shim (`lib/door/testing/echo-shim.ts`)
Speaks the brain protocol with no harness: replies `echo: <text>`, can be told to request a tool.
Used by all P tests so they need no Docker.

### 3.4 Scenario format (`conformance/scenarios/*.json`)
JSON so the Hermes fork's pytest can read the same files later (N1 twins).

```json
{
  "id": "dm.allowlist/stranger-dm",
  "rule": "dm.allowlist",
  "policy": "fixtures/policy-team.json",
  "patch": { "surfaces.fake.dm": { "mode": "allowlist", "users": [{ "kind": "user", "id": "u-alice" }] } },
  "steps": [ { "say": { "room": "dm:u-mallory", "sender": "u-mallory", "isDm": true, "text": "hi {{canary}}" } } ],
  "expect": { "heard": false, "answered": false, "receipt": { "verdict": "drop", "rule": "dm.allowlist" } },
  "twin": { "patch": { "surfaces.fake.dm.mode": "open" }, "expect": { "heard": true, "answered": true } }
}
```

Every scenario carries its flipped twin. A rule whose twin does not flip the outcome fails.

## 4. How a run proves it hit the fakes and not a real service

Rule learned the hard way (a fake `ssh` was once not on PATH, and a test reached a real host):
**a prompt saying "don't" is not a guard. The rig proves the fakes first, with a negative control,
and refuses otherwise.** Five layers, all checked before the first scenario runs. Any failure aborts
with exit code 2 and the message `REFUSING TO RUN: <which guard>`.

| # | Guard | How it is proven | Negative control |
|---|---|---|---|
| F1 | **Only the fake connector exists.** | No real connector is written in this slice. `createDoor()` throws if any connector id is not `'fake'` unless a `allowRealConnectors` flag is set, and that flag does not exist yet | A test registers a dummy connector with id `discord`; `createDoor()` must throw |
| F2 | **No real credential is present.** | Preflight scans the runner's env and every value passed into compose for credential shapes (`*_TOKEN`, `*_API_KEY`, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, private-key headers). Compose env is built from an explicit allowlist, never inherited | A test sets `DISCORD_BOT_TOKEN=x` in a child env; preflight must refuse |
| F3 | **Nothing can leave.** | S0 probe from runner, sidecar and cell: connect to `sink` and to a well-known public IP on port 443 with a 2 s timeout; both must fail. End of run: `sink` log must hold exactly one line, from `control` | `control` (on `outside-net`) connects to `sink` and must succeed, proving the sink and its log work. If that fails the run is void, not green |
| F4 | **Every observable carries this run's nonce.** | `answered` counts only ledger entries with the fake connector's nonce. A reply only counts if its text carries `FAKE-MODEL-<nonce>`, which proves the model on the other end was the scripted one. `heard` reads the scripted model's own request log | A test posts a reply without the stamp into the door; the assertion helper must report "reply did not come from the scripted model" |
| F5 | **Docker is the local one, and the project is ours.** | Refuse unless the Docker endpoint is a local unix socket (`DOCKER_HOST` unset or `unix://`, current context not `ssh://` or `tcp://`). Compose project name must match `swarmlab-[0-9a-f]{8}`. Work dir must be under `os.tmpdir()` and must not be under any `~/.hermes*` or `~/hermes-swarm` path. No container name may start with `hermes-` | A unit test feeds `DOCKER_HOST=ssh://remote-host` and a `~/.hermes-x` path to the guard; both must refuse |

For the no-Docker suites (D, P, G) a vitest setup file `conformance/guards/tripwire.ts` adds a sixth:

| F6 | **In-process tripwire.** | Patches `net.Socket.prototype.connect`, `dns.lookup` and global `fetch` to throw on any destination that is not loopback or a unix socket, and records the attempt. Any recorded attempt fails the suite | A test tries `192.0.2.1:9` (TEST-NET) and asserts the tripwire threw and recorded it |

The slice never imports `lib/services/docker.ts` with fleet settings, never reads `harnesses.json`,
and never touches `lib/services/keys.ts`. The conformance runner has its own thin compose wrapper.

## 5. Conformance tests the slice must pass

Ids are from `primitives.md` section 7. "Proof" is one of the five harness-blind observables.

### D. `decide()` table and properties (no I/O, CI)
One scenario plus twin per rule: `adm.users`, `adm.rooms`, `adm.rooms.ignore`, `adm.anyone-in-room`,
`adm.empty-is-closed`, `dm.closed`, `dm.allowlist`, `dm.open`, `addr.mention`, `addr.threads`,
`addr.free-rooms`, `addr.observe`, `bots.mode`, `bots.inline-mention`, `bots.no-self`, `priv.admins`,
`tools.posture`, `tools.unknown`, `budget.cap`, `out.still-allowed`, `priv.no-forged-identity`.

Properties (hand-rolled generator, seeded, 500 cases each, no new dependency):
1. An empty list admits nobody.
2. A `drop` verdict never yields a send.
3. An admin who is not admitted is not heard.
4. `ignore` beats every allow.
5. `decide()` is pure: same input, same output, and it never mutates the policy.
6. A policy that sets a deferred field to a non-default value makes `decide()` throw `unrendered`
   (fail closed), never silently ignore it.

### G. Guards on the guards (CI)
- **Schema coverage.** Every `PolicyRecord` field path is in some rule's `reads`, or in
  `DEFERRED_FIELDS` with the id of the rule that will read it. The deferred list has a committed
  count that may only go down.
- Every rule in the catalogue has at least one test id, and that id exists.
- F1, F2, F5, F6 negative controls.

### P. Door plumbing (fake connector + echo shim, CI)
Observe buffer delivered as context on the next turn. Session keys (`fake:room:<id>`,
`fake:dm:<user>`), threads pool into the parent. Inbound secret scrub. Outbound redaction, and
outbound fails closed when the sanitizer throws. Outbound re-check when policy changed mid-turn.
One reply per turn, only after `settled`. Tool request with no verdict inside the timeout = deny.
A receipt for every decision, holding ids and sizes and no message text. Heartbeat carries the
policy hash. `hello` with a wrong token is refused.

### C and S. Real Pi in a real cell (local only, `npm run conformance -- --harness pi`)

| # | Check | Proof |
|---|---|---|
| S0 | Fake-proof preflight (section 4, F1-F5) | Guards + sink log |
| S1 | Cell cannot reach `sink` or a public IP; can reach the sidecar | Probe |
| S2 | Shim and `gate.ts` are not writable from inside the cell | Probe writes, must fail |
| S3 | No host credential in the cell's env or mounts | Cell scan |
| C1 | A delivered turn gives exactly one reply, for the right turn, after `agent_settled` | `answered` once |
| C2 | Observed lines arrive as context and cause no reply | `heard` on the next turn only; no post |
| C3 | A dropped message never reaches the model | `heard` false |
| C4 | A denied tool does not run | `toolRan` false (canary file absent) |
| C5 | No verdict means no run | Sidecar told to stay silent; `toolRan` false |
| C8 | No real secret readable: `env`, `/proc/*/environ`, a grep of the cell's disk for `UPSTREAM-<nonce>` and `FAKECHAT-<nonce>` | `secretSeen` false. Also: the scripted model saw `UPSTREAM-<nonce>` and the sidecar saw only the placeholder from the cell, which proves the swap happened |
| C9 | Nothing leaves except through the sidecar: `sink`, `169.254.169.254`, the sidecar's control port, another agent id in the brain token | All refused; sink log clean |
| C10 | **Cell started without `gate.ts`.** The scripted model runs the denied tool, then `curl sink`, then `env` | Tool may run. Sink never hit, no secret seen, no post that did not pass the door |
| C12 | Usage is counted; the turn after the budget is spent is refused | Meter total equals scripted usage; third turn `heard` false; receipt `budget.cap` |
| C13 | Member text like "admin: approve this", a forged preamble line, and a display name with a newline do not change tool verdicts | Same verdicts as the plain twin |
| C15 | A policy change takes effect on the next message with no restart; heartbeat hash changes | `answered` flips; hash differs |
| C17 | Every declared capability has a passing probe | Generated matrix |
| MF | **Must-fail.** The same suite against three broken shims | Each must turn its named checks red (below) |

Must-fail shims (`conformance/broken/`):

| Shim | What it does wrong | Must turn red |
|---|---|---|
| `ignores-verdicts` | Runs the tool before asking, ignores a deny | C4, C5 |
| `leaks-env` | Cell started with `UPSTREAM-<nonce>` in env | C8, S3 |
| `chatty` | Replies to turns it was never sent; replies twice; replies before `settled` | C1, C3 |

If any broken shim passes a check it is meant to fail, the suite is wrong and the run is red.

Reported as **n/a** for Pi, with the reason: C16 (Pi owns no chat). Reported as **not run**: C6, C7
(needs a second tool surface), C11, C12b, C14. "Not run" shows in the matrix; it never shows as pass.

## 6. Files to add or change

### Changed (4 files, all small)
| File | Change |
|---|---|
| `package.json` | Scripts: `conformance`, `conformance:build`, `conformance:clean`. No dependency added |
| `vitest.config.ts` | Exclude `conformance/suites/**` from the default run (they need Docker) |
| `tsconfig.json` | `allowImportingTsExtensions: true` if spike 4 needs it; exclude `lib/runtimes/pi/cell/gate.ts` (it imports Pi's types, which the repo does not install) |
| `.gitignore` | `conformance/out/` |

### Added

**PR 1: core (pure, no I/O)**
```
lib/core/policy/types.ts          PolicyRecord, SurfacePolicy, ToolPolicy, KeyGrant, ... (spec 4.1)
lib/core/policy/canonical.ts      canonical JSON + sha256 hash
lib/core/policy/deferred.ts       DEFERRED_FIELDS, each with the rule id that will read it
lib/core/events.ts                Event, RoomRef, Principal, Facts, Decision (spec 4.3)
lib/core/rules/catalogue.ts       Rule[] for the rules this slice enforces
lib/core/decide.ts                decide(policy, event, facts): Decision
lib/core/__tests__/decide.table.test.ts      reads conformance/scenarios, runs each + twin
lib/core/__tests__/decide.property.test.ts
lib/core/__tests__/schema-coverage.test.ts
conformance/scenarios/**.json     one file per rule id
conformance/fixtures/policy-{private,team,public}.json
```
`SurfaceId` gains `'fake'` for tests only; `validatePolicy()` rejects it unless `testing: true`.

**PR 2: door (runs as its own Node process, never inside Next.js)**
```
lib/door/protocol.ts              ToShim, FromShim, Capabilities, Envelope (spec 4.4, 4.5)
lib/door/framing.ts               JSON lines, split on \n only
lib/door/door.ts                  inbound and outbound pipelines in the spec's order
lib/door/observe-buffer.ts
lib/door/session-keys.ts
lib/door/sanitizer.ts             Sanitizer; reuses the pattern list from lib/services/threat-patterns.ts read-only
lib/door/receipts.ts              Receipt writer (JSONL) + "why didn't it answer?" formatter
lib/door/brain-server.ts          accepts the shim, hello + token, verdict timeout = deny
lib/door/connectors/fake.ts
lib/door/testing/echo-shim.ts
lib/door/main.ts                  process entry: reads policy + config from a file path, no env secrets
lib/door/__tests__/*.test.ts      the P list
conformance/guards/tripwire.ts    F6
conformance/guards/preflight.ts   F1, F2, F5 (+ tests for each negative control)
```

**PR 3: Pi shim, cell, rig**
```
lib/runtimes/pi/caps.ts           Capabilities for Pi 1.5.2, incl. toolMap for read/bash/edit/write/grep/find/ls
lib/runtimes/pi/shim.ts           in the cell: dials the sidecar, one `pi --mode rpc` per sessionKey
lib/runtimes/pi/rpc.ts            Pi RPC pump: prompt, events, extension_ui_request/response
lib/runtimes/pi/preamble.ts       sender + room rendered into the prompt, with delimiting that text cannot forge
lib/runtimes/pi/cell/gate.ts      Pi extension: tool_call -> ask sidecar -> block unless allowed. Fail closed
lib/runtimes/pi/cell/pi-ext.d.ts  the few Pi types gate.ts needs, hand-declared
lib/runtimes/pi/cell/models.json  provider "swarm" -> http://sidecar:7802/v1, placeholder key
lib/runtimes/pi/cell/Dockerfile   node:24-slim, Pi pinned to 1.5.2 by version + integrity, curl, non-root user
lib/runtimes/pi/compose.ts        renders the two-service compose (cell on an internal network)
lib/runtimes/pi/__tests__/*.test.ts   unit: rpc framing, preamble, caps completeness, compose render
lib/door/model-route.ts           proxy: swap placeholder for the real key (meter comes in PR 4)
conformance/rig/scripted-model.ts
conformance/rig/sink.ts
conformance/rig/compose.rig.ts    runner, sidecar, cell, sink, control; three internal networks
conformance/rig/Dockerfile.runner
conformance/rig/observables.ts    heard / answered / toolRan / secretSeen (+ nonce checks, F4)
conformance/runner.ts             `npm run conformance`: preflight, build check, up, run, down, exit code
conformance/suites/pi.s.test.ts   S0-S3
conformance/suites/pi.c.test.ts   C1-C5, C8, C9, C10, C13
conformance/broken/{ignores-verdicts,leaks-env,chatty}/
conformance/suites/must-fail.test.ts
vitest.conformance.config.ts      node env, long timeouts, includes conformance/suites only
```

**PR 4: meter, matrix, receipts view**
```
lib/door/model-route.ts           + token meter, price table, budget refusal
lib/door/control.ts               policy push (per-agent secret) + heartbeat
conformance/suites/pi.c2.test.ts  C12, C15, C17
conformance/matrix.ts             builds conformance/matrix/pi-1.5.2.json from test output
conformance/matrix/pi-1.5.2.json  generated, committed
conformance/why.ts                `npm run conformance -- why <turn>`: prints the receipt trail
docs/lab/pi-slice.md              how to run it, what it proves, what it does not
```

## 7. How Pi is wired (the per-harness part)

| Verb | Pi mechanism | Notes |
|---|---|---|
| Start | `pi --mode rpc --session-dir /data/s/<hash> --provider swarm --model scripted --tools <allowed> --no-context-files --no-skills --no-mcp --no-extensions -e /opt/swarm/gate.ts` with `PI_OFFLINE=1`, `PI_TELEMETRY=0` | One process per `sessionKey`. Flag set is from docs: **unverified** |
| Send | `{"type":"prompt","message":<preamble + text>}`; `streamingBehavior:"followUp"` when busy | Sender and room are prompt text. That is Pi's known permanent gap |
| Read | `message_end` (assistant) = reply; `agent_settled` = `settled` | Never `agent_end` |
| Veto | `gate.ts` on `tool_call` calls `ctx.ui.select("swarm-gate:v1:" + JSON, ["allow","deny"], { timeout })`. The shim turns the `extension_ui_request` into a `tool_request`, waits for the sidecar's verdict, writes `extension_ui_response` | Anything but the exact string `allow` blocks: timeout, cancel, exception, `ctx.hasUI` false. **Unverified** that `select` works as a data channel; fallback is the gate dialling the sidecar itself |

Cell hardening on Docker: `internal: true` network, `read_only: true`, tmpfs for `/tmp`, non-root
user, `cap_drop: ALL`, `no-new-privileges: true` (no s6 here, so it can be on), shim and gate mounted
read-only, 1 CPU / 1 GB.

## 8. Order of work (test-first)

Each PR is built in its own worktree, branched from `origin/main`. Branch names
`lab/pi-1-core`, `lab/pi-2-door`, `lab/pi-3-shim`, `lab/pi-4-meter`. PRs 2-4 stack on the one before.
Open as drafts. Never delete a branch on merge while a later PR in the stack is open (that closes it).
Nothing is merged outside the project's audit flow.

### Step 0. Four spikes (throwaway code, half a day, nothing committed)

| # | Question | Kill or reshape rule |
|---|---|---|
| 1 | Does `pi --mode rpc -e gate.ts` block a tool through `extension_ui_request` and report `agent_settled`? | If `select` cannot carry the payload, the gate dials the sidecar directly. If `tool_call` cannot block at all, Pi gets `toolVeto: 'none'` and only the safe tool set |
| 2 | Does `internal: true` on Docker Desktop for macOS really cut the route out while leaving service-to-service traffic? | If not, the slice stops until a substrate that passes S1 is found. Do not paper over it |
| 3 | Will Pi talk to a scripted OpenAI-shaped endpoint from `models.json` with a placeholder key, with `PI_OFFLINE=1`, making no other network call at start? | If Pi insists on a real provider handshake, the scripted model must mimic that provider. If it phones home at start, record what and whether a flag stops it |
| 4 | Does plain Node 24 run the lab's TypeScript (erasable-only, `.ts` imports) with no build step, and does `tsc --noEmit` still pass? | If not, add a `tsc -p tsconfig.lab.json` build step into the images. Still no new dependency |

Each spike writes three lines into `swarm-lab/spike-results.md`: what ran, what happened, what
changes in this plan. The plan is edited before PR 1 starts.

### PR 1. Core
1. Red: `schema-coverage.test.ts` (fails: no catalogue).
2. Red: scenario files + `decide.table.test.ts` for `adm.*`. Green: admission in `decide()`.
3. Same red-green loop per family: `dm.*`, `addr.*`, `bots.*`, `priv.admins`, `tools.*`, `budget.cap`,
   `out.still-allowed`.
4. Red: the six properties. Green.
5. For each rule, break `decide()` on purpose once and watch its twin go red. A twin that stays green
   is a finding, not a pass.

### PR 2. Door
1. Red then green: tripwire and preflight negative controls (F1, F2, F5, F6). **Guards land first.**
2. Red: framing and `hello` token tests. Green: `protocol.ts`, `framing.ts`, `brain-server.ts`.
3. Red: fake connector round trip with echo shim (one message in, one reply in the ledger). Green: `door.ts`.
4. Red then green, one at a time: drop never delivers; observe buffer; session keys; verdict timeout;
   inbound scrub; outbound redaction and fail-closed; outbound re-check; receipts; heartbeat hash.

### PR 3. Pi shim and rig
1. Red: unit tests for `rpc.ts` framing (a U+2028 inside a record must not split it), `preamble.ts`
   (forged preamble text is escaped), `caps.ts` (every tool Pi can call is in `toolMap`), compose
   render (cell network is internal, no secret in env, mounts read-only).
2. Rig first: `sink`, `control`, scripted model, S0. Green means the negative control hit the sink and
   nothing else could.
3. Must-fail shims written **before** the real shim. Run the C suite against them: red is the pass.
4. Real shim. Go green in this order: S1-S3, C1, C3, C2, C4, C5, C8, C9, C13, C10.
5. Re-run must-fail. Still red where it should be.

### PR 4. Meter and matrix
1. Red: C12 (usage counted, budget refusal). Green: meter in `model-route.ts`.
2. Red: C15 (policy push, hash change). Green: `control.ts`.
3. Red: C17 (a declared capability with no probe). Green: probes + `matrix.ts`.
4. Commit the generated `pi-1.5.2.json`. Write `docs/lab/pi-slice.md`.

### Done when
- `npx vitest run` and `npx tsc --noEmit` green (CI, no Docker).
- `npm run conformance -- --harness pi` green on a clean laptop with the network cable out, after
  images are built.
- Must-fail red in the named cells.
- `conformance/matrix/pi-1.5.2.json` exists and was written by the run, not by hand.
- Sink log: one line, from `control`.

## 9. Out of scope, on purpose

| Left out | Why | Comes back |
|---|---|---|
| Any real connector (Discord, Signal, Slack, ...) and any real post | Needs the owner's explicit yes; it means real messages | After the slice; the owner's call which surface |
| Any real model call or real key | A scripted model tests plumbing, which is what this slice is about | With the first real connector |
| `ask` approvals (C6, `priv.approval`, `priv.approver-roles`) | Needs a hold-and-resume flow; too big for the first slice | Next, with C11 |
| Memory service (C11, `mem.*`), `Envelope.context.memory` | Separate primitive | Next |
| Token broker, sidecar-side MCP tools, `chat.post`, per-room keys (C12b) | Key coverage beyond the model route | Later |
| Pairing, invites, bot loop breaker, nightly reset, steer/cancel/resume (C14) | Door features with no Pi-specific risk | With the first real connector |
| Hermes: importer, renderer, native-mode guards N1-N4, any change to a Hermes path | The fleet is not touched in this slice | Right after the slice |
| Swarm Map UI and API: no page, no route, no `Harness['runtime']` change, no `ContainerRuntimeAdapter` for Pi | The slice is a library plus a CLI. Wiring it into the app is a separate decision | After the matrix exists |
| Letta Code shim; removal of the old Letta path and the bridge | Parallel track; the shim waits for PR 3 to freeze the protocol | Parallel |
| OpenClaw, Claude Agent SDK, ACP shim | Later harnesses | Later |
| MicroVM / WASM substrate, S4 limits, TLS-intercepting key swap | Docker first | Later |
| Running the Docker suites in GitHub CI | Needs image builds and a registry pull in CI | Once the suite is stable locally |
| Deploying anything, touching the production host or any live agent | Hard rule | Never without the owner |

## 10. Risks and things this slice cannot show

1. **Everything Pi-specific is from docs.** Step 0 exists to turn that into evidence before PR 1.
2. **Fakes lie.** A scripted model proves the pipes, not that a real model keeps quiet about what it
   overheard. The matrix must say "scripted model" on every row.
3. **The gate is a guardrail.** C10 proves the wall behind it for egress and secrets. Per-room tool
   rules have no wall; the matrix shows them as guardrail-only.
4. **Tool mapping can be wrong, not just missing.** The suite catches a tool absent from `toolMap`,
   not one put in the wrong class.
5. **Pi ships weekly.** The image pins 1.5.2 by version and integrity hash. A bump means a new
   matrix file, not an edit to the old one.
6. **One network step remains:** building the images. It is separate, explicit, and never part of a test run.
7. **`internal: true` on Docker Desktop is unproven.** If spike 2 fails, the slice has no wall and stops.

## 11. Small decisions made here that the spec left open

- The test runner lives inside the rig, so the whole run is air-gapped. The spec only asked for the cell to be.
- Fields of `PolicyRecord` not enforced yet sit in a `DEFERRED_FIELDS` list that can only shrink, and
  using one makes `decide()` refuse. This keeps "every field is read by a rule" true without pretending.
- PR 1 covers `tools.*`, `budget.cap`, `out.still-allowed` in `decide()` as well as the four families
  the spec lists, because C4, C12 and the outbound re-check need them.
- C2 is in the slice (the spec's PR table implies it via "C1-C5"; its "left out" list is silent).
- Fake secrets are minted per run and never committed, so the PR sanitization gate stays quiet.
- No `ContainerRuntimeAdapter` for Pi yet. That interface answers "how to name and start a
  container", which the slice does not need from the app.
