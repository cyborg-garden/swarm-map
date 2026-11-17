# The tools slice: a door agent's first tools

This adds the first useful tools to an agent behind the door, with an approval step in the chat
room. It builds on [`primitives.md`](primitives.md) (the contracts), [`pi-slice.md`](pi-slice.md)
(the door and the cell) and [`pi-discord.md`](pi-discord.md) (the launcher). Every id on this page
is a placeholder.

## In short

- **Off by default.** An agent has no tools until its rules switch a class of tool on.
- **Three classes in this slice.** Read files, write files, and a shell. All three run inside the
  sealed cell and nowhere else. There is no web access.
- **Each class has a mode.** `never`, `ask` or `allow`. Shell starts at `ask`.
- **`ask` means a person says yes in the room.** The door posts what the agent wants to run. An
  admin answers. No answer in time is a no.
- **The door decides, not the harness.** Every tool call is put to `decide()`. The harness only
  carries the question and the answer.
- **An agent anyone can talk to gets none of these.** A public agent loses shell and file tools
  whatever its rules say, and an agent that hears anyone in its channel is a public one.

## What an agent can do

| Class | Pi's tools | Where it reaches |
|---|---|---|
| `file_read` | `read`, `ls`, `grep`, `find` | The scratch folder only |
| `file_write` | `write`, `edit` | The scratch folder only |
| `shell` | `bash` | The whole cell: no network but the door, no secret, no folder of the host |

**The scratch folder** is one path in the cell, and it is where the harness is started. Under the
launcher it is a mount that lives in memory, of a fixed size (64 MB), on a disk that is otherwise
read-only. It is gone when the agent stops. Keeping it across stops is not built: see "What was
left out".

**What a tool gets back goes to the model and nowhere else.** The door never posts tool output.
If the model repeats it in a reply, that reply goes through the same outbound checks as any other:
secrets redacted, then cut to size.

## The rules

The rules record already has the lists this needs: `tools.allow` and `tools.ask`. A class in
neither list is `never`. A class in both is `ask`.

The launcher's config, and the dashboard's Tools card, write those lists from a simpler shape:

```json
"tools": { "enabled": ["file_read", "file_write", "shell"], "mode": { "shell": "ask" }, "approvalSeconds": 120 }
```

`enabled` is empty by default. A class that is enabled with no mode gets `ask` for shell and
`allow` for reading files. Writing files gets `ask` when the shell asks and `allow` otherwise.
`approvalSeconds` is how long an admin has to answer.

**A shell that asks and file writing that does not are refused together.** An admin is shown a
command, not the files it runs. If the agent could write `run.sh` without asking, a yes to
`sh run.sh` would run whatever it put there, unseen. This was tried: with writing allowed and the
shell asking, a script written in the same turn ran on the admin's yes to its name. The launcher
and the dashboard's Tools card refuse that pairing, and the card does not offer it.

**Hearing anyone makes an agent public.** The launcher writes `posture: public` into the record
for a config with `anyoneInChannel`, and refuses such a config outright if it also switches a tool
on, so nobody is left thinking a tool is on. `decide()` is the wall behind that refusal.

`decide()` answers a tool call in this order. The first line that applies wins.

1. The record is not valid: no.
2. The agent is public: no to shell, file, code-exec and chat-admin tools, and to any tool it
   cannot classify.
3. The class is on the deny list: no.
4. The class is on the ask list: **ask**.
5. The class is on the allow list: yes.
6. Otherwise: no.

## Approval in the room

When `decide()` says ask, the door holds the call and posts in the same room, under the message
that started the turn:

````
Approval needed. The agent wants to run bash:
```
{"command":"ls -la","timeout":60}
```
An admin can reply approve or deny, or react ✅ or ❌. No answer in 120 seconds means no. Whatever it starts or changes in the agent's cell stays until the agent is stopped. (call 3fa9c1d2e4b6)
````

What makes that safe to act on:

- **It shows the whole call.** The line in the block is the call's input as JSON, complete, as the
  gate will run it: here with the time limit the gate put on it. A call too long to show in full
  (1,200 characters) is refused, never cut and then approved.
- **Nothing in it is hidden or can ping.** Every character outside plain printable ASCII, and
  `@`, `<` and the backtick, is written as a `\u` escape, and so is every space past the third in a
  row, so blank space cannot push the end of a command out of sight. So the text cannot hide a character,
  break out of its block, or mention anyone. The escapes are still JSON: read back, it is the
  same input, byte for byte.
- **A call with something secret-shaped in it is refused** rather than shown with a part
  blanked out, because then what was shown would not be what runs.
- **The yes is tied to that one call.** The door takes a hash of the tool name and input. The
  answer it sends the cell carries that hash. The gate in the cell works out the hash of what it
  is about to run, and runs only if the two are the same.
- **Only an admin's own account can answer.** The answer must be a reply to the request, or a
  reaction on it, in the same room, from a user id on the admin list. Whoever the surface says
  sent it is what counts: not a name, not what the text claims. Another person, another bot (a
  named one too) and the agent itself are refused, with a receipt, and the request stays open.
- **One request, one answer.** An answered request is closed. Answering it again does nothing,
  and the same command asked again is a new request that needs its own yes.
- **Silence is a no.** At the time limit the door says no.
- **A yes is checked again when it lands.** If the turn is over, or the rules changed so the tool
  is now denied, the call does not run.

A reply to an open request is an answer to the door. It is never passed to the model.

On Discord a reaction always reaches the door. A reply's text only does if it pings the bot, which
a reply does unless the ping is switched off, or if the agent reads all messages. The door asks
Discord for reactions only when a class of tool is set to ask.

Every step writes a receipt: asked, each answer that was refused, approved or denied or timed
out. A receipt holds the tool's name, the call's hash and ids. It never holds the command.

## Fails closed

The chain is gate, shim, door. Each link says no on its own when the next one is quiet:

| Who waits | Says no when |
|---|---|
| The gate in the cell | The shim does not answer in time, answers anything but yes for this exact call, or there is no channel |
| The shim | The door does not answer in time, or the link is gone |
| The door | The turn is not live, the lookup fails, nobody is on the admin list, the request cannot be posted, or no admin answers in time |

Where `ask` is in use the launcher gives the shim and the gate a little longer than the door's
approval time, so the door's no arrives first. If it does not, theirs does.

## When a model call fails

A turn with tools on makes more model calls than one without, and each can fail. None of them
fails quietly.

- **Every call that does not complete leaves a receipt that says why.** The model route writes
  one when it refuses a call (`model.route`: no price, so it cannot be metered; not a model call;
  not readable; the wrong stand-in key), when the budget refuses it (`budget.cap`), and when the
  provider refuses it, never answers, or ends its reply with an error (`model.provider`, with the
  status or a fixed code in the note). The provider's own words are never written down.
- **The room is told in one short line.** When a turn ends with nothing to post, the door posts
  `No answer this time.` and the reason, under the message that started the turn. With no model
  failure to point at, it says the agent finished without a reply, that something went wrong
  inside the agent, or that it took too long and the door stopped waiting. The line is the door's
  own text and goes through the same outbound checks as a reply. A message deleted mid-turn gets
  no line. A turn a bot started gets no line either, only the receipt (`turn.to-bot`): a line
  would be one more message for the bot to answer, and would keep a bot loop going.
- **Metering is unchanged.** A call the route cannot meter is still not forwarded. A call it
  forwards is charged by the usage the provider reports, or by size when it reports none, and
  that includes a reply that ends in an error.
- **A slow model is not a failure.** A call can take minutes. The route waits up to ten. With
  tools on, a turn is allowed ten minutes too, not counting time spent waiting for an admin, since
  it makes at least two calls; with none it is allowed three. After that the room is told the door
  stopped waiting. The harness is not stopped: if it answers later, the answer is dropped, with a
  `turn.known` receipt.

The checks for this are C6m, C6b and C6s in `conformance/suites/failure-checks.ts`. A shim link
that reports a failed turn as one that answered "All done." must turn C6m and C6b red. C6s waits
out a model that never answers, so a shim has nothing to cover up there: what turns it red is a
door that says nothing at the deadline, and that is held by the door's own tests.

## Limits

| Limit | Default | Enforced by |
|---|---|---|
| Time for one shell call | 60 seconds | The gate sets the call's own timeout before it asks, so the limit is part of what is approved |
| Output of one call | 16,000 bytes, then cut with a note | The gate, before the model sees it |
| Tool calls per conversation | 30 in an hour | The door |
| Scratch folder | 64 MB | The mount |
| The cell's own folder (its harness's settings, sessions and home) | 256 MB, in memory, gone on stop | The mount |
| Processes and memory | 256 and 1 GB, as before | Docker |

## What is a wall and what is a guardrail

- **Wall:** the cell. Whatever runs in it reaches only the door and holds no secret. That was
  shown with the gate removed (C10) and still is.
- **Wall:** who may answer a request, and that an answer is used once. The door does that, and
  the cell has no part in it.
- **Guardrail:** the gate. It is what holds a call until the answer comes, checks the hash, keeps
  file tools in the scratch folder and applies the time and output limits. It sits in the cell on
  a disk the cell cannot write. A model cannot talk its way past it, because the model does not
  run the gate. Something that takes over the cell's own processes could run anything the cell
  can run, and the wall is what is left.
- **So `ask` is a control on the model, not on the cell.** That is the right size for it: the
  cell has nothing to steal and nowhere to send it.
- **A yes to a shell command reaches past that command.** Something it starts in the background
  keeps running after it, with no further yes, until the agent is stopped. A file it changes stays
  changed, and that includes the harness's own settings, so it can change how later commands run.
  The request says so on its last line. Approve only what you would let run unattended.
- **The time and output limits are the gate's, in the cell.** The door holds who may answer, the
  count of calls, and the turn. It does not see a shell call run.
- **A shell can call the model through the door, outside a turn.** It finds the cell's stand-in key
  in the harness's settings. Such a call is metered and counted against the monthly budget like any
  other; the budget is what bounds it.
- **File tools stay in the scratch folder only while there is no shell.** The gate follows every
  path a file tool is given, links and all, and hands the tool the plain path it checked. A shell
  is not held to that: it can read the rest of the cell's disk, which holds the harness and this
  lab's code, and no secret. The check and the open are also two steps, so a shell that swaps a
  link between them could win that race. With no shell there is nothing in the cell to make a link.

## The checks

Harness-neutral, in `conformance/suites/tool-checks.ts`. A harness runs them when its adapter
says its shim can hold a call. Each has something broken on purpose that must turn it red.

| # | Check | Broken on purpose |
|---|---|---|
| C6 | A tool in ask mode does not run until an admin says yes, then runs | Gate that asks nobody |
| C6n | An answer from a non-admin, a bot, a named bot or the agent changes nothing | A chat surface that reports every answer as the admin's |
| C6d | An admin's no: the tool does not run | Gate that asks nobody |
| C6t | No answer in time: the tool does not run | Gate that asks nobody |
| C6x | What ran is exactly what was shown | Gate that runs more than it asked about |
| C6r | A yes is used once | Gate that asks nobody |
| W1 | A file tool cannot leave the scratch folder: `..`, a full path, a link | Gate with no path check |
| W1+ | Positive control: file tools work inside the scratch folder | (a control: it shows W1 was not green because nothing ran) |
| L1 | A shell call past the time limit is stopped | Gate that applies no limits |
| L2 | Output past the cap does not reach the model | Gate that applies no limits |
| C5v | (existing) The gate says no on its own when nobody answers | Gate that takes silence for yes |
| C9 | (existing, Docker) A tool reaches nothing but the door | A cell with a route out |
| C6m | A model call the provider refuses, after a tool ran, leaves a receipt and tells the room why | A shim that reports a failed turn as one that answered; in a cell, a gate that asks nobody |
| C6b | A model call refused because the budget is spent leaves a receipt and tells the room why | A shim that reports a failed turn as one that answered |
| C6s | A model call slower than the turn is allowed tells the room the door stopped waiting | (none in the harness suite: the door's own tests) |

Results are in "What was run".

## Letta Code

Not built here. Its shim asks the door before a tool runs and takes a plain yes or no. It does not
check that a yes names the call, keeps no file tool in a scratch folder and applies no limits. So
it does not tell the door it can hold a call, the door never offers it a tool in ask mode, and its
matrix lists each of the ten tool checks as not run, with that reason. The launcher refuses a
config that names Letta Code and switches a tool on, and the dashboard's Tools card is switched
off for such an agent.

## The Claude Agent SDK

Not built here either, for the same reason: its shim ([`claude-sdk.md`](claude-sdk.md)) puts every
tool call to the door and takes a plain yes or no, and does not say it can hold a call. Its two
matrices list the ten tool checks as not run, with that reason. It is not one of the launcher's
harnesses, so no config can switch a tool on for it.

## A later tool: fetch through the door

Not built. The shape, so that nothing here has to change for it:

- The tool is a call to the **door**, not a socket in the cell. The cell still has no route out.
- Its class is `network`. `decide()` gets the host and method (the `egress` event that is already
  in the contracts), and the rules name the hosts: `egress.hosts`, default deny, private ranges
  blocked.
- The door makes the request itself, with no agent credential, follows no redirect to a host that
  is not listed, caps the size and time, and hands back text. In `ask` mode the URL is what is
  shown.
- What comes back is untrusted text. It goes to the model only.

## What was left out

- **Keeping the scratch folder.** It is always wiped on stop. A kept folder needs a volume, and
  a plain Docker volume has no size cap.
- **Role-holders as approvers** (`approverRoles`). Still refused by `decide()`.
- **Per-room tool lists**, code-exec, browser, MCP and memory tools.
- **Limits in the rules record.** They are fixed numbers handed to the door and the cell at start.
- **"Approve always".** Every call in `ask` mode needs its own yes.

## What was run

One machine: Docker Desktop for Mac, engine 29.5.2, Apple silicon. A scripted model and a fake chat
room throughout. No real model, no real chat platform, no real credential.

| Run | Result |
|---|---|
| Real Pi 1.5.2 as a process | 24 checks pass: the 14 shared ones and the 10 tool checks. 13 shims and rigs broken on purpose each turned its named checks red and left the others green |
| Real Pi 1.5.2 in the sealed Docker cell | 30 checks pass: 4 on the seal, 13 shared, C8, C9, C10 and the 10 tool checks. 16 rigs broken on purpose each turned its named checks red, 5 of them cells with a broken gate |
| The launcher's own cell, with a fake Discord | All 19 tests of the Pi launcher's Docker suite pass in one run, and all 15 of the Letta Code launcher's. In them a shell command waited in the channel, did not run on a tick from the person who asked or from a stranger, and ran on the admin's tick. A file write waited for the admin's tick too. File tools worked in the scratch folder and were refused outside it four ways. Stopping removed the cell and its volume |
| The scratch folder's size | 72 MB written to a 64 MB folder: no more than 64 MB landed. With the mount left out on purpose, all of it landed and three checks went red |
| The cell's own folder | Before the audit, 200 MB written there from a shell landed on Docker's disk. Now 264 MB written to it lands no more than 256 MB, and 300 MB from a shell stopped at 256 MB. With it left a plain volume on purpose, three checks went red |
| Hand mutations | 77 lines broken one at a time in `decide()`, the door, the gate, the shim, the connector, the launcher and the page. 76 turned a named test red. One changes nothing the code does |
| Letta Code 0.34.60, process and Docker | The shared checks pass as before. The 10 tool checks are listed as not run, with the reason |
| Claude Agent SDK 0.3.325, process and Docker | 20 checks pass as a process and 26 in the cell, as before. The 10 tool checks are listed as not run, with the reason |
| Audit mutations | 28 lines broken one at a time in `decide()`, the door's answer handling, the scratch-folder check, the gate, the launcher's config, the cell and the Tools card. All 28 turned a named test red |

The fake-Pi run of the same checks is part of `npx vitest run`. The real runs are the ones under
"Run it" in [`pi-slice.md`](pi-slice.md), and they rewrite the four matrix files.

What this does not show:

- **Nothing here is a real model.** A scripted model asks for exactly the calls a check wants.
  Whether a real model uses the tools well, or tries to talk an admin into a yes, is not tested.
- **The approval text was read by tests, not by people.** That an admin understands a request at
  a glance is not something a test shows.
- **Real Discord was not used.** Replies and reactions were driven through a fake on loopback.
- **Not every line of a check has something broken behind it.** Each tool check goes red for a
  broken gate or a broken rig. The lines that read the door's receipts, and that the request names
  the right tool and hash, are held by the door's own tests and not by a broken shim.
- **The call limit per conversation has no check in the harness suite.** It is the door's alone
  and is tested there.
- **In the conformance rig the scratch folder is a shared volume**, so the suite can see what a
  tool touched. The capped mount is the launcher's, and is checked in the launcher's own runs.
