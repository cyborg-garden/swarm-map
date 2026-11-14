# The Pi slice: what exists, how to run it, what it proves

This is the first slice of the harness-agnostic lab described in [`primitives.md`](primitives.md),
built by following [`plan-pi.md`](plan-pi.md). Nothing here is wired into the Swarm Map app, the UI
or any running agent. It is a library, a test rig and one command.

One thing has been added since: a Discord connector and a launcher for one Pi agent in one
channel. It is described in [`pi-discord.md`](pi-discord.md). Everything below about fakes still
holds for every test: the connector is only ever tested against a fake Discord on loopback.

## In short

- **One place decides.** `decide()` in `lib/core/` evaluates every "who may it hear and answer"
  rule. No harness is asked to enforce one.
- **One door.** `lib/door/` owns chat in, chat out and model traffic. The harness sits behind it
  with no chat token and a placeholder instead of a model key.
- **Pi is driven through that door.** `lib/runtimes/pi/` is the only Pi-specific code: start it,
  send text, read text, veto a tool.
- **Everything runs on a laptop with fakes.** A scripted room, a scripted model, loopback only.
- **Real Pi 1.5.2 passes all fourteen process-level checks.**
- **There is now a wall, on one machine.** With Pi in a sealed Docker cell on Docker Desktop for
  Mac, a tool run by Pi could not reach the internet, the laptop or a stand-in for the internet,
  and could not read the model key or the chat token. That held with the tool gate removed. Ten
  cells broken on purpose each turned the right checks red. It is shown for that machine, that
  Docker version and the ways out the probe tries, and for nothing wider. See "The Docker cell".
- **Three limits to know before reading on.** The key swap and the budget cap only exist for
  harnesses that speak the OpenAI chat format. Pi is given no direct messages, because its sessions
  share one folder on disk. A changed tool list restarts that session's Pi process.

## Run it

```bash
npx vitest run                 # everything that runs in CI, no Pi and no Docker needed
npm run conformance:smoke      # one message through the door under plain Node

# The same shim checks against a real Pi install (not in CI):
npm install --prefix /tmp/pi-1.5.2 --ignore-scripts @earendil-works/pi-coding-agent@1.5.2
SWARMLAB_PI_BIN=/tmp/pi-1.5.2/node_modules/.bin/pi npm run conformance

# The same, with nothing inherited from your shell. This is how to check the env isolation claim:
env -i PATH="$PATH" HOME="$HOME" npx vitest run conformance/suites
```

`npm run conformance` refuses to run without `SWARMLAB_PI_BIN`, and refuses a Pi that is not the
pinned version. It never skips. A complete run rewrites `conformance/matrix/pi-1.5.2.process.json`.

```bash
# The same checks with Pi in a sealed Docker cell, plus the ones that need a cell (not in CI):
npm run conformance:docker:build   # once for each state of the code. The only step that uses the network
npm run conformance:docker         # about two minutes. Rewrites conformance/matrix/pi-1.5.2.docker.json
npm run conformance:docker:clean   # only if a run was killed: removes what this worktree's runs left, and nothing else
npm run conformance:docker:clean -- --images   # the same, and the images this worktree built
```

The Docker run needs a Docker daemon on this machine, reached over a local socket. It refuses
anything else. Every container, network and volume it makes is named `smlab-<8 hex digits>` and
labelled with the id of the run that made it; it stops and removes only those, by name, and never
prunes.

**The images are per source.** They are named for the code they were built from:
`smlab-cell:pi-1.5.2-<hash>` and `smlab-rig:<hash>`, where the hash covers every file the builder
is sent (`lib/core`, `lib/door`, `lib/runtimes` and `conformance`, less tests and output). Change
one of those files and the names change, so the run finds no image until you build again. The
reason: with one fixed name, every checkout on a machine shared one pair of images. Whoever built
last decided what every other run tested, and a run from one branch could go green on another
branch's code without a sign of it. Three things now stand in the way:

- **The name.** A run only looks for the images named for the code on disk.
- **The label.** The build writes the hash on both images (`swarmlab.source`).
- **The files.** Before any rig starts, the run lists the SHA-256 of every file in both images and
  compares them with the worktree. The rig image must hold exactly the source. The cell holds a
  part of it, and every file it holds must match. A difference is `REFUSING TO RUN: S0`, and every
  test in the run fails. The run then shows this check can go red, against a copy of the code with
  one line added.

What this costs: a build after every change to those folders, and old images that stay until they
are removed. `clean -- --images` removes the ones this worktree built and wrote down in
`conformance/out/docker-ledger`, by exact name, and leaves any image a container still uses.
`docker image ls 'smlab-*'` shows the rest. Cleaning up goes by the same file: it lists the runs
this worktree started, and only objects labelled with one of those runs are removed. Another
checkout's rigs and images are never touched, whatever they are named.

Two runs can also be kept apart by name: `SWARMLAB_DOCKER_PREFIX=mylab` puts `mylab` in place of
`smlab` in every image, project and container name (2 to 16 lower-case letters and digits).

The run needs an internet connection, for its controls. Before any rig starts, a one-off container
on Docker's default network asks DNS where `example.com` and one public resolver are, so no public
address has to be written in this repo. One of the broken cells (`open`) is then put on an ordinary
Docker network on purpose, and from there opens one connection to that address and asks two DNS
questions about `example.com`. Nothing else is sent. With no connection the addresses are not
found, the probe reports those ways out as not tried, and the run is red rather than green on no
evidence.

## What was built

| Part | Where | Tested by |
|---|---|---|
| Policy record, hash, validation of every closed set | `lib/core/policy/` (`shape.ts` lists the sets) | `validate.test.ts`, `schema-coverage.test.ts` |
| Rule catalogue (38 shared rules) | `lib/core/rules/catalogue.ts` | `catalogue.test.ts`: every rule is proven by shared tests that exist; a test of one harness is refused |
| Pi's own rules (4) | `lib/runtimes/pi/rules.ts` | `rules.test.ts` |
| `decide()` | `lib/core/decide.ts` | 41 scenario pairs, 5 seeded properties and a table of deferred fields, `decide.failclosed.test.ts` |
| Brain protocol, framing, shim client | `lib/door/protocol.ts`, `framing.ts`, `brain-server.ts`, `shim-client.ts` | `framing.test.ts`, `brain-server.test.ts` |
| The door, fake connector, sanitizer, receipts, observe buffer | `lib/door/` | `door.test.ts` |
| Discord connector, and the fake Discord it is tested against | `lib/door/connectors/discord.ts`, `lib/door/testing/fake-discord.ts` | `discord-connector.test.ts` |
| Launcher for one Pi agent in one Discord channel | `lib/lab/pi-discord/` | `shared-channel.test.ts`, `launcher.test.ts` in CI; `pi-discord.docker.test.ts` on a machine with Docker |
| Model route: key swap, token meter, budget | `lib/door/model-route.ts` | `model-route.test.ts` |
| Spend ledger, by calendar month | `lib/door/spend-ledger.ts` | `spend-ledger.test.ts`, `model-route.test.ts` `[U:budget-ledger]` |
| Model wire formats (one: OpenAI chat) | `lib/door/model-shapes.ts` | `model-route.test.ts` `[U:model-shape]` |
| Pi shim, RPC pump, preamble, tool gate | `lib/runtimes/pi/` | `rpc.test.ts`, `preamble.test.ts`, `gate.test.ts`, shim checks |
| Scripted model, fake Pi | `conformance/rig/` | `scripted-model.test.ts` |
| Fake-proof guards | `conformance/guards/` | `tripwire.test.ts`, `preflight.test.ts`, `lab-preflight.test.ts`, `fake-pi.test.ts` |
| Shim checks, broken shims, matrix | `conformance/suites/`, `conformance/broken/`, `conformance/matrix.ts` | `pi.fake.test.ts` (which also fails when the committed matrix no longer matches the suite), `pi.real.test.ts`, `matrix.test.ts` |
| The Docker rig: compose file, cell and rig images, sink, control, probe, runner | `conformance/docker/` | `compose.test.ts` and `matrix-fresh.test.ts` in CI; `pi.docker.test.ts` on a machine with Docker |
| The Pi adapter for the shared checks | `conformance/harnesses/pi.ts` | `harness-blind.test.ts` |

## The shim checks

Each check drives a fresh lab and reads only what can be seen from outside the harness: did the
canary reach the scripted model, did the fake connector get a post stamped by that model, was a
canary file touched, did a planted secret show up.

| # | Check | Fake Pi (CI) | Real Pi 1.5.2 |
|---|---|---|---|
| C1 | A delivered turn gives exactly one reply, from the model, for the right turn | pass | pass |
| C2 | Overheard lines arrive as context on the next turn and cause no reply | pass | pass |
| C3 | A dropped message never reaches the model | pass | pass |
| C4 | A tool the harness was offered, then denied mid-turn, does not run | pass | pass |
| C4a | A tool the policy never allowed is not offered to the harness | pass | pass |
| C4p | A shell tool on the allow list does not run once the agent is made public | pass | pass |
| C4+ | Positive control: an allowed tool does run | pass | pass |
| C5 | No verdict means no run (the shim gives up and says no) | pass | pass |
| C5v | The veto inside the cell says no on its own when nobody answers it | pass | pass |
| C8p | No real secret is readable from a tool, the harness did not inherit the host environment, and the key swap happened (process level) | pass | pass |
| C9p | The harness process reached for nothing outside this machine (its own runtime only) | pass | pass |
| C12 | Usage is counted; the turn after the budget is spent is refused | pass | pass |
| C15 | A policy change takes effect on the next message with no restart | pass | pass |
| C15t | The tools a turn may use follow the policy at that turn, in a session that is already running | pass | pass |
| C13 | Text that claims to be an admin does not change a tool verdict | not run | not run |

**C13 is not run, and was wrongly listed as a pass before.** No tool verdict depends on who asked
yet (approvals are not built), so a real admin gets the same answer as a forged one. The check
could not fail for the reason it names. It comes back with C6.

Must-fail: the same checks against eight deliberately broken shims. Each turned its named checks
red, on the fake Pi and on real Pi.

| Broken shim | What it does wrong | Must turn red |
|---|---|---|
| `ignores-verdicts` | A gate that announces itself, then lets every tool run without asking | C4, C4p, C5, C5v, C15t |
| `leaks-env` | The real key planted in Pi's environment | C8p |
| `inherits-env` | Pi started with the shim's own environment passed down | C8p |
| `gate-missing` | The gate file is not there | C1, C4+ (no turn reaches the model, no tool runs) |
| `gate-silent` | Pi loads a gate that never announces itself and blocks nothing | C1, C4+ (same) |
| `dials-out` | A working gate that also tries to connect to an address outside this machine when Pi starts | Every check that starts Pi |
| `unwatched` | Pi started with no tripwire loaded inside it | C9p, and nothing else |
| `chatty` | Answers without the model, twice, and for turns nobody opened | C1, C3 |

## The Docker cell

`npm run conformance:docker` starts one rig per check, on this machine's Docker:

```
  cell network (internal)      door  <->  cell      the only thing the cell can reach is the door
  outside network (internal)   sink, control        the sink stands in for "the internet"
```

- **cell**: the shim and real Pi 1.5.2. A read-only disk, a non-root user, every capability
  dropped, IPv6 off. It is handed a run nonce, a cell token and two timeouts.
- **door**: the sidecar's side, in one process: the door, the model route, the scripted model and
  the fake connector, and the check itself. It has no route out either.
- **sink**: accepts any connection and logs it. Only the **control** is on its network. The control
  hits it once, which proves the sink and its log work.
- Nothing from the laptop is mounted and no port is published. The one thing two containers share
  is a named volume: the cell writes there, the door reads it.
- Pi is installed from a lock file with an integrity hash for every package, on a base image pinned
  by digest, with no install script run.

Two things are read for every check. From inside: a probe, run in the cell, that tries each way
out and reports what happened. From outside: the sink's own log and a listener on the laptop. Both
must agree, and the sink's log must hold exactly one line, from the control. S1 to S3 also read
what Docker says it gave each container (`docker inspect`), not only what the compose file asked
for: a published port, a shared namespace, an added capability or a host path fails them.

| # | Check | Real Pi 1.5.2 in the cell |
|---|---|---|
| S0 | The rig is this machine's and the lab's own, holds no real credential, inherited nothing from the shell, and its sink can be hit | pass |
| S1 | The cell cannot reach the internet, the laptop or the sink, only the door. Nor can the door's container | pass |
| S2 | The shim, the gate and Pi itself cannot be written from inside the cell | pass |
| S3 | No host credential, host folder or secret of the run is in the cell's environment, mounts or disk | pass |
| C8 | A tool run by Pi finds the model key and the chat token nowhere: not in its environment, not in another process, not in any file it can read. The cell only ever presented its placeholder | pass |
| C9 | A tool run by Pi reaches nothing but the door, and the door hangs up on a wrong cell token | pass |
| C10 | With the gate swapped for one that lets everything run, a tool the policy denies does run, and still reaches nothing and reads no secret | pass |
| C1-C15t | The thirteen process-level checks above, with Pi in the cell (all but C9p, whose job C9 does here) | pass |

The ways out the probe tries, from the cell and from the door's container: the sink by name and by
address; a public address over TCP, a public resolver over IPv6 and asked directly over UDP; a
public name asked of Docker's own resolver; the laptop by the two names Docker gives it and by
address, on a port where the laptop is listening; the cloud metadata address; and Docker's own side
of the cell network, on the two ports a Docker engine would answer on and on the laptop's port.

**Negative controls.** The same checks against rigs broken in one way each. Every one turned its
named checks red, for the reason it names, and left the others green.

| Broken rig | What is wrong with it | Turned red |
|---|---|---|
| `route-out` | The cell is also on the sink's network | S1, C9, C10: the probe got through, and the sink logged it |
| `open` | The cell is also on an ordinary Docker network | S1, C9: it reached a public address, DNS and the laptop's listener. This also shows the probes can succeed |
| `leaks-env` | The run's model key is in the cell container's environment | S3, C8 |
| `leaks-file` | The run's model key is in a file in the cell, and in no environment or command line | S3, C8: only the search of the disk can find it |
| `writable` | The cell runs as root on a disk it can write | S2 |
| `host-mount` | A folder of the laptop is mounted into the cell | S3 |
| `socket` | An empty file is mounted where a Docker socket would be | S1, S3: the probe looks there |
| `door-out` | The door's container is also on the sink's network | S1: the door's side reached the sink, the cell still did not |
| `blind-sink` | The control cannot reach the sink, so its log is empty | S0, C9: an empty log is not a pass |
| `gate-kept` | C10 run in a cell that still has its gate | C10: the denied tool never ran, so the wall was not tested on its own |

**A real-looking key is refused twice.** The runner refuses to render a rig whose cell would be
handed anything shaped like a real credential, before Docker is asked for anything. And the cell's
own entry refuses to start with one in its environment, however it was started.

### Which rules this proves for Pi

The catalogue is shared by every harness, so a Pi test cannot be its proof. Each rule has two
lists. `tests` is proof that holds whatever the harness is: scenarios, door tests, unit tests of
shared code. `checks` names the shim checks above that a harness must pass for the rule to hold
with that harness in the loop. Each matrix file ends with one line per rule, built from its run:

| For Pi 1.5.2 | Rules |
|---|---|
| Shown at process level (5) | `ctl.applied`, `addr.observe`, `tools.lists`, `tools.no-verdict`, `turn.one-reply` |
| Shown only with Pi in the Docker cell (3) | `budget.cap` and `keys.model-route` (the route does its part at process level; that Pi has no other way to a model or a key is C9 and C8), `tools.posture` (C4p, with C10 behind it) |
| Not claimed for Pi yet (2) | `priv.no-forged-identity` (waits on C13), `tools.unknown` (waits on C7) |
| Need nothing from the harness (28) | Every "who may it hear and answer" rule, receipts, the sanitizer |

A second harness starts with nothing in the first three rows until its own runs put it there.

The middle row holds for the one machine the Docker run was made on. And `tools.posture` is still a
guardrail: C10 shows that when the gate fails, the denied tool does run. What held behind it is
that the tool reached nothing and read no secret, not that it did not run.

### Putting a second harness through the same checks

The lab, the checks, the matrix and the `chatty` shim name no harness. What differs comes in as
one object, a `HarnessUnderTest` (`conformance/suites/harness.ts`): its capabilities, its model
wire format, which native tool call is a shell, how to start its shim, how to read the tripwire inside its process, the ways of
breaking it that the suite must catch, and the spec checks that do not apply to it. Pi's is
`conformance/harnesses/pi.ts`. `harness-blind.test.ts` fails if a shared file imports a runtime
or names a harness again.

## How a run proves it is talking to fakes

| Guard | What it does | Negative control |
|---|---|---|
| F1 | `createDoor()` refuses any connector that is not the fake one, unless whoever starts the door names that surface as live | A connector with id `discord` must be refused, and still refused when a different surface is named |
| F7 | The fake Discord's rig refuses to start unless both Discord addresses are loopback, the bot token is the fake minted for that run, and the environment holds no Discord token, no token-shaped value and no pointer to a real secret file | The real REST and gateway hosts, a token from another run, a real-looking token and each kind of environment must be refused |
| F2 | The exact environment each shim, broken ones included, is about to hand to Pi is checked against a list of credential names and shapes. It is a list: a credential it has not been taught goes through, which is why Pi's environment is also listed by hand | `DISCORD_BOT_TOKEN=x` must be refused, by the guard and by a lab handed a harness that carries it |
| F4 | A reply only counts if it carries the scripted model's stamp for this run | The `chatty` shim's unstamped replies fail C1 |
| F5 | Work dirs must really be under the temp dir (links are followed), outside the home directory and nowhere near an agent's home. The Docker runner refuses a Docker that is not a local socket, and a container that is not named for its own rig. It removes only what carries a lab project's label and is named for that project | A `~/.hermes-x` path and `DOCKER_HOST=ssh://...` must be refused, and a lab handed either kind of work dir must not start. A container of another rig must be refused. A container that carries a lab label under another name must be left alone |
| F6 | A tripwire in the test process throws on a TCP connect, UDP send, DNS lookup or query, or fetch that is not loopback, and on a connect to a local socket file. It sees that process only | A connect to TEST-NET must throw and be recorded |
| F6c | The same tripwire, loaded first inside every Pi the lab starts (Node `--import`). The lab reads back what it saw. An attempt fails the check it happened in, and C9p fails if no tripwire was armed | The `dials-out` shim must turn every check that starts Pi red; the `unwatched` shim must turn C9p red; a fake Pi pointed at TEST-NET must be stopped |

**What F6 and F6c do not cover.** A tripwire patches Node. It sees the test process and the Pi
process, real or fake, and any Node process Pi starts. It does not see a program that is not Node:
a shell tool running `curl` would not be stopped or recorded. It patches the functions Node
offers, so code that reaches under them (a native addon) is not seen either. And its log sits in
the lab's work dir, where a harness with a shell could edit it: it catches a harness that dials
out by accident or by default, not one that is trying to hide. "Nothing left this machine" is
therefore shown at process level for Pi's own runtime behaving normally, not for everything Pi can
start. The Docker cell covers the rest (C9), on the one machine it was run on. Before this change the tripwire covered the test process alone, so that claim was not shown
for Pi at all.

Three variables keep a real Pi off the network at start-up (`PI_OFFLINE`, `PI_TELEMETRY`,
`PI_SKIP_VERSION_CHECK`). A test pins them, rig variables cannot override them, and the fake Pi
refuses to start without them.

The scripted model refuses any caller without this run's upstream key. The fake connector refuses
any token but this run's. The fake Pi announces itself as fake, and the matrix builder refuses to
build a matrix from it.

## What the spikes found

| # | Question | Result |
|---|---|---|
| 1 | Does `pi --mode rpc -e gate.ts` block a tool through `extension_ui_request`, and report `agent_settled`? | **Yes**, on Pi 1.5.2. `ctx.ui.select` carries the request as its title; allow runs the tool, deny blocks it, and silence blocks it at the timeout |
| 1a | What does Pi do when the `-e` file is missing, throws, or does not parse? | **It stops**: exit code 1, `Failed to load extension`, on Pi 1.5.2. It does not carry on without it |
| 1b | Can the gate say it is loaded before the first prompt? | **Yes.** A `session_start` handler calling `ctx.ui.notify` reaches the RPC client before any prompt |
| 1c | Does `--continue` with `--session-dir` pick the conversation back up after a restart? | **Yes**, on Pi 1.5.2: C15t sees the first turn's text in the request after the restart |
| 2 | Does `internal: true` on Docker Desktop cut the route out? | **Yes**, on Docker Desktop 4.76 for Mac (engine 29.5.2, Apple silicon). From a container on an internal network a public address is unreachable, a public name does not resolve, and the laptop cannot be reached by name or address; two containers on that network still reach each other. The same probes from an ordinary network succeed, so the probes can tell the difference. Not tried: any other Docker, or Docker on Linux |
| 3 | Will Pi talk to a scripted OpenAI-shaped endpoint from `models.json` with a placeholder key? | **Yes.** `"api": "openai-completions"`, a custom `baseUrl`, and a placeholder `apiKey`. With the tripwire loaded inside it, Pi 1.5.2 made no call to anything but this machine across the whole suite. That covers Pi's own Node runtime; the Docker cell covers what Pi starts |
| 4 | Does plain Node 24 run the lab's TypeScript with no build step? | **Yes.** It needs `allowImportingTsExtensions` in `tsconfig.json`, and `plain-node.test.ts` now guards it |

## Where the build departed from the plan

- **One branch, not four stacked PRs.** The pieces landed as separate commits in plan order.
- **A process-level suite was added.** The plan put every shim check inside Docker. With no Docker
  to run at first, the checks were written against a plain Pi process. They prove the shim and the
  door. They prove nothing about the cell. The Docker run came after, and runs the same checks again.
- **The Docker rig has one container where the plan had two.** The plan kept the test runner and
  the sidecar apart. Here the door, the model route, the scripted model, the fake connector and
  the check are one process in one container, because that is how the lab was already built. The
  runner that starts the rig is on the laptop, outside it, and reads results from container output.
- **The cell is given no `curl`.** The probe is a Node script in the cell image. It makes the same
  connections.
- **The Docker project is named `smlab-<nonce>`**, not `swarmlab-<nonce>` as the plan had it.
- **The images are named for their source**, not `smlab-cell:pi-1.5.2` and `smlab-rig:local` as
  first built. Fixed names were shared by every checkout on a machine. See "The images are per
  source" above.
- **An audit of the Docker cell changed four things.** The probe's IPv6 address came from the
  laptop's resolver, so on a network that answers no IPv6 question the whole run was red; the
  public resolver is now asked itself. Three broken rigs were added (`leaks-file`, `socket`,
  `door-out`), because the search of the disk, the socket check and the door's own probe had none.
  S1 to S3 now also judge what Docker says each container was given. And cleaning up now needs the
  lab's name as well as its label.
- **`budget.cap` and `keys.model-route` now also name C9 and C8.** Both are walls and the route is
  half of each, so the process matrix no longer claims them.
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

- **The gate has to say it is loaded.** The gate sends one notice when the session starts, and the
  shim writes no prompt to Pi until it has seen it. Pi 1.5.2 already stops when its `-e` file
  cannot load, but that is one version's behaviour and nothing we control. There is no longer any
  way to start Pi through the shim without a gate.
- **Tools are per turn in the protocol and per process in Pi.** When the tool list for a session
  changes, the shim stops that session's Pi and starts it again with the new list and
  `--continue`. The shim declares this (`toolChange: 'restart'`). C4 used to rely on the stale
  list; it now tightens the policy in the middle of a turn instead.
- **C13 was dropped to not-run**, and C5v and C15t were added. See the table above.
- **The fake Pi loads the real gate file.** It used to carry its own copy of the gate's logic, so
  the gate itself was never run in CI.
- **The model route takes its wire format as a part** (`ModelShape`). Only one exists.
- **The budget cap had five ways round it. Each is closed; what is left is under "What this does not show".** A reply with no usage was counted as
  free; it is now charged at one token per byte, with a receipt marked `unmetered`. So is a reply
  whose usage cannot be true: a zero either way, a missing count, a negative count, anything that
  is not a whole number. Calls sent at once all passed the same check; under a refusing cap they now go one
  at a time. Spend was kept in memory; it is now in a ledger by calendar month (UTC), and a route
  has no default for it. And `decide()` read a missing spend figure as zero; under a refusing cap
  it now says no when it is not told what has been spent.
- **The door now says no in four more places.** A tool decided after a slow lookup is refused if
  its turn ended meanwhile. A lookup that fails is a no, with a receipt. A direct message is known
  by its room kind as well as its flag. And an inbound scrub that fails drops the message; it used
  to deliver it unscrubbed.
- **The model route stops when spend cannot be recorded.** It checks the ledger can be written
  before it forwards a call, and a charge lost after a call stops every later one until the route
  is restarted. Stream events
  written as `data:` with no space, or with lines ending in CRLF or a bare CR, are now parsed, and
  a usage figure no longer stands once any output (text, a tool call, an event the route cannot
  read) follows it without a believable figure of its own. An event's data is read across all its
  `data:` lines. A reply is read by what is in it, not by its label: a stream of events is read as
  one under any content type, and an error body answering a streamed call is read as the plain
  body it is. The key is searched for in the
  raw text of every reply, in every string and property name of a JSON reply after JSON's escapes
  are undone, and in the content type. A price that is not two plain rates counts as no price.
- **`mem.dm-isolated` does not mean what the spec's row says.** The spec's rule is "a DM never
  shares scope with a group", proven by C11. Memory scopes are not built, so the rule here is
  narrower and blunter: no DM is delivered to a harness that does not keep sessions apart.
- **`tools.posture` is no longer claimed for Pi.** Its shim checks were C4 and C4a, which test the
  allow list on a team agent. It now names C4p (new) and C10, so only the Docker run can claim it.
- **`tools.gate-loaded` left the shared catalogue.** It was a Pi mechanism. It is now `pi.gate-loaded`
  in `lib/runtimes/pi/rules.ts`, with Pi's other three promises.
- **The protocol's capabilities gained three fields:** `toolChange`, `sessionIsolation` and
  `modelShape`. A shim's hello is now refused if its tool map holds anything but plain names.

## What this does not show

1. **The wall is shown on one machine, for the ways out that were tried.** Limits of the Docker run:
   - **One Docker.** Docker Desktop 4.76 for Mac, engine 29.5.2, where containers run inside a
     virtual machine. Docker on Linux, another version or another engine is not shown.
   - **A list, not a proof.** The probe tries the ways out listed above. A way out that is not on
     the list was not tried. A fault in Docker or in the kernel, and slow side channels, are out
     of reach of this kind of test.
   - **DNS is judged by the answer.** A public name does not resolve from the cell. Whether the
     question is passed on first is not a standing check. It was watched by hand once, with a
     packet capture on Docker's own network stack: eight kinds of question from the cell, over UDP
     and TCP, were answered "failed" at once and none left. The same questions from an ordinary
     Docker network were seen leaving, so the capture could see one.
   - **IPv6 has no control.** The cell has no IPv6 address and the IPv6 probe fails. But it fails
     from an ordinary Docker network on this machine too, so that probe was never seen to succeed.
     Tried by hand once: a container on an internal network had no IPv6 address even without the
     cell's own IPv6 setting.
   - **The cell can talk to Docker's side of its own network.** The probe tries three ports there.
     By hand once, all 65,535 TCP ports there were tried from a cell: every one refused but one,
     which timed out. A port that a lab container published on every interface timed out from the
     cell, and was reached from an ordinary Docker network. Neither is a standing check.
   - **Not every line of a wall check has a broken cell.** Ten broken rigs cover a route out, a
     leaked key (environment and file), a writable root cell, a host folder, a Docker socket's
     place, a door with a route out and a blind sink. No rig is broken by a published port, a
     shared process namespace, a lost no-new-privileges alone, an IPv6 address, an inherited shell
     variable, or a door that keeps a wrong cell token on the line. Those lines are tested on
     made-up reports only (`report.test.ts`).
   - **The run needs public DNS.** The probe's public addresses are looked up when a run starts.
     On a network that answers no such question the run fails; it does not pass untried.
   - **The cell token can be read inside the cell.** The shim holds it, so a tool can read it. It
     only names the cell to its own door, but anything in the cell can then speak as the cell: it
     could stop the shim and answer a live turn itself. Such a reply still goes through the door's
     outbound checks. That a reply came from the model is not walled.
   - **The lab's secrets can be guessed from the nonce.** C8 shows the strings are nowhere in the
     cell, which is what matters for a real key. It says nothing about a key that is weak.
   - **The door's side is sealed here, and would not be in use.** In the rig the door has no route
     out either. A door that talks to a real model and a real chat platform needs one. That side
     is not tested.
   - **The shared folder is a second channel.** The door reads files the cell wrote, to see what a
     tool touched. It reads them as data, and reads no link and no pipe the cell left there.
   - **No limits are tested.** The cell has a memory and process cap; nothing checks them (S4).
   - **The eight broken shims were not run again in a cell.** Only "the gate removed" was (C10).
   - **These are lab images.** The cell image holds the probe and the broken gate. Nothing in
     Swarm Map starts a cell like this, and no running agent is in one.
2. **A scripted model tests plumbing.** Nothing here shows what a real model would do with what it
   overheard.
3. **Identity in Pi is prompt text.** The preamble cannot be forged by a sender, but a model can
   still be talked into things. Privilege is never read from the prompt for that reason.
4. **The key is redacted from streamed reply text even when it is split across events**, by
   holding back any ending that could be the start of the key. That covers the text of the reply
   only. Streamed tool-call arguments and any other field are still checked one event at a time.
   A reply that is part JSON body and part event stream is searched as raw text for its JSON
   part, so a key written there with a JSON escape gets through. Comments a stream sends before
   its first event are held until that event comes, so a keep-alive does not keep anything alive.
   The key travels in a header the model never sees. That nothing else in the harness can reach
   it is the cell's job: shown for Pi in the lab's Docker cell (C8), within the limits in item 1.
5. **The tool map can be wrong, not just incomplete.**
6. **The key swap and the budget cap exist for one wire format.** `lib/door/model-route.ts` is
   shared code and enforces two wall rules (`budget.cap`, `keys.model-route`), but the only
   `ModelShape` written is OpenAI chat-completions, which is what Pi speaks. The Claude Agent SDK
   and Letta Code's Anthropic path use the Anthropic Messages API (`/v1/messages`, `x-api-key`,
   `input_tokens`/`output_tokens`). Until that shape is written and tested, those harnesses have
   no key swap and no cap. The route refuses such a call; it does not forward it unmetered.
   Three limits of the cap itself. The one-token-per-byte charge is a deliberate overcount, so
   an agent on a provider that reports no usage reaches its cap early. Under a refusing cap an
   agent's model calls wait for each other, so two busy rooms share one queue; a call the provider
   never answers is given up on after ten minutes. And the ledger file belongs to one route: two
   routes writing the same file is not supported. The lab itself uses a ledger kept in memory.
7. **Pi's sessions are not kept apart on disk.** Every session's Pi process runs in the same work
   dir, with the same home, and its transcript sits beside the others. With a file or shell tool
   allowed, a turn in one room can read another session's files. The session key separates them
   in name only. The Docker cell does not change this: it is one cell with one shared folder for
   every session. Until a cell gives each session its own mounts:
   - the door delivers **no direct message** to a harness that does not declare
     `sessionIsolation: 'sealed'` (rule `mem.dm-isolated`). Pi declares `'none'`, so with Pi,
     `dm.mode` `open` and `allowlist` are accepted by the policy but every DM is dropped with a
     receipt that says why;
   - **two rooms with different members still share files.** Nothing stops that yet. It belongs
     to `mem.scope`, which is not built.
8. **Rules in the spec that are not built, and what happens instead.** `bots.roles`,
   `dm.pairing` and `invite.policy` have no rule here. A policy that sets any of them away from its
   resting value is refused outright. (`bots.loop` is built now: the door counts bot messages
   delivered in a row in a room, and `decide()` stops at the limit.)
   A bot is admitted by the bots rules alone and is not checked against the user list. One model
   call can overshoot the cap, because the cap is checked before a call, not during it. A usage
   figure that is false but could be true (one token for a long reply) is believed. So is a
   provider that answers with an error status: the call is charged only if the reply reports usage. A charge the
   ledger loses stops the route, but a restart forgets that and the charge stays lost. C12b (a key
   scoped to one room) is listed as not-run.
9. **Not every line of every check has a broken shim behind it.** The eight broken shims prove the
   suite can go red for the gate, the environment, the tripwire and a harness that answers on its
   own. No broken shim isolates C2, C4a, C12 or C15, or the one-reply line of C1, the timing line
   of C5v, or the key-swap lines of C8p: those lines could be deleted with the must-fail runs
   still passing. The door's half of each is covered by its own tests (`P:observe`, the budget
   tests, `P:heartbeat-hash`, `P:one-reply`, `U:key-swap`); the harness's half is shown by the
   check passing, not by a shim that fails it. Also not pinned by any test: the working folder Pi
   is started in.
10. **A changed tool list costs a restart of that session's Pi.** The conversation is carried over
   with `--continue`. Anything Pi held only in memory is gone.
11. **Mutation checks were run by hand, not committed.** Every rule in `decide()` (36 mutations) and
   the main paths of the door, framing, sanitizer and model route (37 more) were broken on purpose
   once, and each turned a named test red. After the audit, eleven more were run the same way: the
   gate allowing everything, allowing on a timeout and allowing on an error; Pi inheriting the
   host environment; the shim not waiting for the gate; no restart on a changed tool list; no
   `--continue`; and four on stream redaction. The gate and environment ones were also run
   against real Pi. Each turned a named test red. After the second audit, twelve more: the
   public-posture list cut to shell only; each of the lab's two preflight calls removed; no
   charge for an unreported call; no queue under a cap; usage summed per stream event; refused
   calls charged; the ledger never written; no upstream timeout; Pi's offline flags deleted; the
   tripwire not loaded into Pi; and the lab not reading what the tripwire saw. A third audit
   re-ran those and found one survivor (C9p's "no tripwire armed" line could be deleted), now
   closed by the `unwatched` shim. It then added about forty more against its own fixes: usage
   figures that cannot be true, unknown spend, a ledger that cannot be written, the four door
   refusals, the credential and work-dir guards, the posture check and the brain token. Each
   turned a named test red, bar two that changed nothing the code does. A separate pass of 223
   mutations across the whole slice found 57 hand mutations and 45 deleted check lines that no
   test noticed. The ones that mattered now have tests (a wrong token of the right length, each
   redaction pattern, Pi's flags, its HOME and PATH, a folder per session, a broken shim caught
   only in part). The check lines in item 9 are still open, and so are smaller ones in policy
   validation, the RPC pump and the shim client.

## Still to build

| Item | Blocked on |
|---|---|
| The Docker run on a Linux host, and in CI | Images that CI can build or pull |
| A door container with a route out, apart from the test runner | Nothing; the rig merges them |
| S4 (limits), and the broken shims run again in a cell | Nothing; not started |
| Policy push from Swarm Map with a per-agent secret (`control.ts`) | Nothing; not started |
| C17 (a probe per declared capability), `why` command | Nothing; not started |
| `ask` approvals (C6), and C13 with it; memory (C11), real connectors, Hermes native mode | Out of this slice by design |
| A `ModelShape` for the Anthropic Messages API | Needed before the Claude Agent SDK or Letta Code's Anthropic path can have a key swap or a budget cap |
| A folder and home per session that other sessions cannot reach, then `sessionIsolation: 'sealed'` for Pi | A cell per session, or mounts per session inside one |
