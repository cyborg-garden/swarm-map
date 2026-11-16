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
`allow` for the two file classes. `approvalSeconds` is how long an admin has to answer.

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
An admin can reply approve or deny, or react ✅ or ❌. No answer in 120 seconds means no. (call 3fa9c1d2e4b6)
````

What makes that safe to act on:

- **It shows the whole call.** The line in the block is the call's input as JSON, complete, as the
  gate will run it: here with the time limit the gate put on it. A call too long to show in full
  (1,200 characters) is refused, never cut and then approved.
- **Nothing in it is hidden or can ping.** Every character outside plain printable ASCII, and
  `@`, `<` and the backtick, is written as a `\u` escape. So the text cannot hide a character,
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

## Limits

| Limit | Default | Enforced by |
|---|---|---|
| Time for one shell call | 60 seconds | The gate sets the call's own timeout before it asks, so the limit is part of what is approved |
| Output of one call | 16,000 bytes, then cut with a note | The gate, before the model sees it |
| Tool calls per conversation | 30 in an hour | The door |
| Scratch folder | 64 MB | The mount |
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

Results are in "What was run".

## Letta Code

Not built here. Its shim asks the door before a tool runs and takes a plain yes or no. It does not
check that a yes names the call, keeps no file tool in a scratch folder and applies no limits. So
it does not tell the door it can hold a call, the door never offers it a tool in ask mode, and its
matrix lists each of the ten tool checks as not run, with that reason.

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

Nothing yet. This page was written before the code. The results go here.
