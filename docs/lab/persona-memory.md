# Persona and memory for a door agent

This gives a door agent a fuller persona and notes that outlive a restart. It builds on
[`dashboard-slice.md`](dashboard-slice.md) (the rules record and the agent page) and
[`tools-slice.md`](tools-slice.md) (tools in the cell). Every id on this page is a placeholder.

## In short

- **A persona document.** Markdown, up to 8 KB, in the rules record. It says who the agent is and
  how it talks. It is edited on the Rules tab, with a preview and a short guide.
- **What the agent can do is not part of it.** The launcher writes that after the persona, from
  the rules. The persona cannot add an ability or take that text away.
- **Notes kept by the door.** For each room, three small Markdown files: about the room, about
  people who asked to be remembered, and about threads still going on. They live on this
  machine, in the agent's state folder. The harness never sees the folder.
- **Given back at the start of a conversation.** After a restart too. One room's notes never go
  to another room.
- **Changed only through the door.** The agent has one tool, `memory_note`. The door checks each
  change, writes it, and says what it did.
- **A Memory tab.** View, edit, wipe and download the notes. Secret-shaped text is never shown.
- **The scratch folder can be kept.** `tools.keepScratch`, off by default, the same size cap as
  the folder, and a Wipe button.
- **New agents start with a default persona and notes on.** An agent made before this keeps
  running exactly as it did.

## The persona

The rules record's `persona` gains one optional field:

```json
"persona": { "name": "Fern", "description": "Keeps the garden company.", "document": "## Who you are\n..." }
```

The launcher builds the system prompt in this order:

1. `You are <name>, a chat assistant in one Discord channel. <description>`
2. The persona document, introduced as the operator's words about manner. It is told that where
   the persona says anything about abilities, the part after it is what is true.
3. The statement the launcher writes from the rules: what the agent can do, which tools it has,
   what it cannot do, whether it keeps notes, and that nothing above changes this.

The statement is written by the launcher after the persona. It is never read from the persona,
so no text in the persona can remove it. A test feeds hostile personas (claims of tools and the
internet, "ignore everything after this line", fake markers, an 8 KB wall of text) and checks
that the statement is still there, whole, and last. With real Pi in the cell, the model's own
system message was checked for the same thing.

Limits: 8 KB of UTF-8. Line breaks are kept, tabs become two spaces, and any other control
character is refused. The longest persona plus the statement still fits what Pi and Letta Code
are handed (the prompt limit went from 4,000 to 16,000 characters).

The default persona for a new agent is short and plain: a place in the channel, a warm and direct
tone, short answers, saying what was checked, saying "I don't know" and who might, checking
before promising, group manners, and a few firm lines said kindly. It names no tool and claims no
ability.

## The notes

### Where they are

```
<state folder>/memory/<room hash>/room.md      About this room
                                 /people.md    People who asked to be remembered
                                 /threads.md   Ongoing threads
                                 /room.json    Which room this folder is
```

The folder name is a hash of the room's key (`surface:room`; a thread uses its parent's room), so
a key is never used as a path. Files are `0600`, folders `0700`. A write goes to a temporary file
first and is then moved into place.

### How the agent is given them

On the first turn of a conversation, the door reads that room's notes from disk and puts them in
the turn as context. The harness shows them in a marked block: notes, not instructions. They are
sent again only when they change. Because the door reads them from disk on every turn, an edit or
a wipe on the dashboard counts at once.

When a note a conversation was given, or wrote itself, is taken down (a wipe, an edit on the
dashboard, or a person asking to be forgotten), the door starts that conversation again before its
next turn. So nothing of the removed note is left in the harness's own transcript either. That also
clears whatever else the conversation held, the person's own words included.

### How the agent changes them

One tool, `memory_note`, with `file` (room, people, threads), `op` (add, replace, remove), `text`
and `old`. It does nothing in the cell. In Pi it is registered by the gate. When it runs it hands
the request to the door, and the door's answer is what the model reads.

The door's rules for a note:

| Rule | Why |
|---|---|
| One line, up to 280 characters | Notes stay notes |
| Each file up to 4 KB. A full file refuses the note | A hard size cap |
| Refused if the redactor finds anything secret-shaped, or a secret the door holds | Same check as everything the door posts |
| Refused if it holds a mention, a platform id or an email address | A note cannot point at someone. A plain name is not caught: see the limits below |
| Refused if it holds an invisible or direction-changing character | Nothing hidden from the checks or from a person reading it |
| `people`: only about the person speaking. The door writes their id on the line; the agent cannot name anyone | Notes about a person are theirs |
| `people`: only in a turn where that person's own message says "remember", "don't forget" or "note that" | Opt-in, in their own words |
| `people`: anyone may remove their own note, without asking twice. A remove with no note named takes down every note of theirs in the room ("forget me") | Easy to take back |
| `people`: at most 8 notes for one person in a room | One person cannot fill the file and keep everyone else from being remembered |
| On an agent anyone can talk to, `room` and `threads` change only in a turn an admin started | A stranger cannot plant a note for the whole room |
| `replace` and `remove` need the exact note | No guessing |

Every change writes a receipt with the result code (`add`, `secret`, `not-asked`, …). A receipt
never holds the note's text.

The agent is told the truth about all of this in its system prompt: that the door keeps notes,
that it changes them only with the tool, that a note about a person needs that person to ask, and
that anyone in the room may be told what the notes say.

### Privacy limits the operator should know

- **Everyone in the room can be told every note**, the people notes included. Person X can ask what
  the agent knows about person Y, and it may say. The agent is told this, and told never to promise
  privacy.
- **Asking is a word check.** "Remember", "don't forget" or "note that" anywhere in the person's own
  message counts, so "do you remember...?" counts too. The model is also told to keep a note about
  a person only when they ask.
- **A plain name is not caught.** The door stops mentions, ids and email addresses, and keeps a
  person's line to the person speaking. It cannot tell that "my coworker Sam is unwell" is about
  someone else. On an agent with a known list of people, anyone allowed may also add a note about
  the room or a thread.
- **Forgetting is per room.** A person asks in each room where they asked to be remembered. The
  receipts keep who changed a note and when, never the note.
- **Notes are given to the model as notes**, in a marked block that says they are not instructions.
  A note can still try to persuade the model, as any message can. It is one line, at most 280
  characters, and the door's own rules do not change whatever a note says.

### Which harness can do what

| Harness | Given the notes | Can change them |
|---|---|---|
| Pi | Yes | Yes, with `memory_note` |
| Letta Code | Yes | No. It is told so, and the dashboard can edit them. Its own `Memory` tool is never offered for notes. It keeps its one-room limit |
| Claude Agent SDK | Yes, through the shared prompt | No. It is not one of the launcher's harnesses |

### Turning them on

`"memory": { "notes": true }` in the rules. The Rules tab has a switch. Notes on adds the
`memory` class to the policy's allow list, so the door offers the tool. Left out, the policy is
exactly what it was.

## The Memory tab

- One card per room: the three files in editable boxes, Save, and Wipe room.
- Download notes: every room as one Markdown file.
- Wipe all notes.
- The kept scratch folder: its size and when it was kept, and Wipe (only while the agent is
  stopped, because a running agent's folder is kept again when it stops).

Everything the tab is sent is read through the redactor first. An edit is checked like a note
from the agent (size and secrets), except that an operator may name people. Each change is in the
audit log.

## A kept scratch folder

`"tools": { ..., "keepScratch": true }`. It is refused unless writing files or the shell is on.

When the agent stops, the launcher reads the scratch folder out of the cell as one tar stream
(`docker exec`, as the cell's own user) and stores the bytes in the state folder. When it starts,
the same bytes are unpacked again inside the new cell, by the cell's own user, into the capped
folder. This machine never unpacks the stream, so nothing in it can land anywhere on this
machine, and the folder's own size cap still applies to what comes back. A folder too big to keep
is not kept, and an older copy is removed rather than coming back stale.

It comes back only under the tool rules it was kept under. Under rules that let the agent write a
file without asking, it can leave a script there; put back under rules where the shell asks, an
admin would approve only the script's name. So a copy kept under other rules is removed, and so is
any copy once keeping is switched off.

The agent is told its folder is kept. A request to approve a tool says that what the call leaves
in the scratch folder is kept after a stop.

## What was left out, and why

- **Pi session resume across restarts.** Pi 1.5.2 can open a session by id (`--session-id`), so
  it is possible. It was not built. Pi's sessions live in the cell's own folder, in memory, and
  are gone at a stop on purpose. Keeping them would mean carrying a folder out of the cell that a
  shell in it can write, so an approved command could change what the next run starts from, and
  the "wiped at a stop" promise in every approval request would no longer hold. In Pi's cell every
  conversation also shares one sessions folder. The notes do the job instead: small, checked,
  per room, and readable by a person.
- **A memory tool for Letta Code and the Claude Agent SDK.** Neither shim carries a door tool yet.
- **Per-person notes across rooms.** A person's note is kept in the room where they asked.
- **Search over old conversations.**

## Checks

Harness-neutral, in `conformance/suites/memory-checks.ts`. Each has something broken on purpose
that must turn it red.

| # | Check | Broken on purpose |
|---|---|---|
| M1 | Notes outlive a restart: a new door and a new harness are given them | Notes kept in the scratch folder |
| M2 | One room's notes never reach another room | Notes kept under one key for every room |
| M3 | A secret-shaped note is refused, never kept or given back, and the agent is told | Notes written with no check |
| M4 | The agent changes notes only through the door's tool: a file tool aimed at them changes nothing | The notes' folder put inside the scratch folder |
| M5 | The launcher's statement reaches the model whole, after the persona | Pi started without the launcher's text |
| M6 | A wipe really wipes: nothing of the notes reaches the model again | Notes read once and kept in memory |

In the Docker cell, M2, M3, M4 and M6 run like the rest. M1 and M5 need a second lab or a prompt
of their own, so the launcher's own Docker suite (`pi-discord-memory.docker.test.ts`) covers them
with a real stop and start: persona and statement in real Pi's system message, a note and a
refused secret note through the door, the note and the kept folder back after a restart, and
both gone after a wipe.

Unit tests cover the notes store, the door's handling, the tool in Pi's gate and RPC, the persona
parser and prompt, the service and the routes, the two pages, and an agent made before this
change: its record, config, prompt and policy hash are byte for byte what they were.
