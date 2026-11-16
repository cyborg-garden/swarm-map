# The first door agent in the dashboard

This is the plan for the smallest slice that makes one door agent a normal row in Swarm Map, and
how to try what was built from it. It builds on the
[Pi in Discord launcher](pi-discord.md). Read that first if "door", "cell" or "dry run" are new.

Every id on this page is a placeholder.

## In short

- **A door agent is a fleet row.** It carries `runtime: "pi"` or `runtime: "letta-code"`, shows a
  runtime badge that names the harness, and its status comes from the door: running or stopped,
  and whether the cell was shown sealed.
- **It is made from a small form.** A name, a harness and one line about what it is for. The
  name is checked while it is typed, by the rule the server uses. The new agent's page opens on
  its Rules tab.
- **Swarm Map owns the rules.** One typed record per agent, in Swarm Map's data folder. The door's
  config and its start script are written from that record on every save. Nobody edits them by hand.
- **Start is checked first.** Start runs the launcher's dry run and refuses unless it ends
  "ready to start".
- **Secrets stay in two files.** The record holds the two paths. Swarm Map checks where each file is
  and who can read it, and never opens one. Only the launcher does, in its own process.
- **Hermes agents are untouched.** Hermes code never sees a door agent, and a Hermes-only route
  refuses a door agent's id.

## The shape

```
  rules record  --render-->  config.json + start.sh  --launcher-->  door + sealed cell
  (Swarm Map)                (generated, same folder)               (state/ in the same folder)
```

Everything for one agent lives in `<data dir>/door-agents/<id>/`:

| File | Holds | Written by |
|---|---|---|
| `record.json` | The rules record: the rules, the two secret file paths, a version | Swarm Map, on Save |
| `config.json` | The launcher's config | Rendered from the record |
| `start.sh` | The command a supervisor runs. Paths only | Rendered from the record |
| `dry-run.json` | The last dry run: when, the result, the rules it checked | Swarm Map |
| `started-by-page.json` | The pid of the door Swarm Map itself started last | Swarm Map |
| `door.log` | What the door printed | The door |
| `state/` | `receipts.jsonl`, `spend.json`, `run.json` | The door |

The fleet's `harnesses.json` also keeps one row for the agent, `{ id, name, runtime }`, where
`runtime` is `pi` or `letta-code`. That row reserves the name. Because Hermes code has no adapter
for either tag, every Hermes path already
leaves such a row alone: it is not listed as a Hermes agent, not matched to a container, and not
changed. This slice reuses that guard and adds the door paths beside it.

## What is in

1. **The rules record** (`lib/services/door-record.ts`). It holds the launcher's own config type
   (who is heard, the channel, mention required, named bots, loop limit, budget, persona, model)
   and is checked by the launcher's own parser and policy validator. No second set of rules.
2. **The lifecycle adapter** (`lib/services/door-agents.ts`, interface in `runtime-adapter.ts`):
   create, start, stop, status, logs, receipts, usage, remove. It talks to the launcher through a
   small interface, so tests swap in a stub.
3. **A supervisor command.** `start.sh` sits in the data folder. The page shows a `pm2` command
   that runs it. A door that exits with an error is restarted. A door stopped through Swarm Map
   stays stopped, and so does one killed by a signal, which pm2 does not count as an error.
4. **Usage from the spend ledger.** The month's spend against the budget. Today's cost and the
   invocation count are not kept by the door, so they show "—".
5. **Routes**, all resolved through `lib/harness-ref.ts` and covered by the route sweep:

   | Route | Does |
   |---|---|
   | `POST /api/harnesses/door` | Create a draft door agent from a name, a harness (`runtime`) and a one-line description |
   | `GET /api/harnesses/:id/door` | The record, status, usage and supervisor command |
   | `PUT /api/harnesses/:id/door/rules` | Save the rules and apply them |
   | `GET /api/harnesses/:id/door/receipts` | The decision log, newest first |
   | `GET /api/harnesses` and `GET`, `DELETE`, `start`, `stop`, `logs`, `usage` under `:id` | Now also answer for a door agent |

6. **The agent page** for a door agent: Overview, Rules, Receipts, Logs. No other tab is drawn.
   The Overview says which harness is in the cell and the one version of it that is pinned, when
   the cell's seal was last checked (or that it never was), whether the running door is on the
   rules now on record, and who started it: this page, a supervisor, or something else.
   `?tab=rules` in the address opens the page on that tab.
7. **The fleet table and the home page**: a runtime badge, Start and Stop, and no drift or
   database chip, since neither applies to a door agent.

## Which Node the start script names

`start.sh` ends by running the launcher with a Node named by its full path. A supervisor runs
that file again after a crash or a reboot, so the path has to keep working after Node is
upgraded. It is chosen in this order (`lib/services/door-node.ts`):

1. `SWARM_MAP_NODE`, when it is set in Swarm Map's environment: the full path of a Node binary.
2. The stable Homebrew path, when Swarm Map's own Node runs from a versioned Homebrew folder.
   `<prefix>/Cellar/<formula>/<version>/bin/node` is removed by `brew upgrade`.
   `<prefix>/opt/<formula>/bin/node` is the link Homebrew keeps pointed at the installed
   version, so that is written instead, if it is there and is the same major version.
3. Otherwise the Node Swarm Map runs on, as it is.

Before a start, and before a save is applied to a running door, the chosen Node is checked: it
must be there, be executable, and be new enough to run the launcher's TypeScript directly
(22.18 or newer). If not, nothing is run or stopped, and the refusal says which path and why. The
page shows it in the same place as a failed dry run.

`start.sh` is written again on every save and every start, and the Node is chosen again each
time. So an agent whose `start.sh` still names an old path picks up the new one the next time it
is started from Swarm Map, or its rules are saved. A supervisor that restarts a door on its own
runs the file as it was last written.

## The harness

The record's `runtime` is the harness, fixed when the agent is made. The launcher's config is
rendered with `"harness": "letta-code"` for a Letta Code agent and with no `harness` key for a
Pi agent, which is how the launcher has always read Pi: a Pi agent's `config.json` is written
exactly as before. An edit of the rules cannot change the harness.

What a harness cannot do is read from what its shim declares (`lib/lab/pi-discord/harnesses.ts`)
and shown in three places: the create form, the Overview, and for Letta Code beside the channel
field on the Rules tab. Letta Code keeps one memory for the whole agent, so it has one room
only. The rules enforce that at the door (`mem.one-scope`); the pages only say so.

## Who started the door

Start on the page runs `start.sh` as a plain background process, and Swarm Map writes down the
pid it started. When the door on record runs under that pid, the Overview says "this page" and
that nothing restarts it. When the door's parent process is pm2, it says "a supervisor". When
neither is true, as for a door started from a command line, it says that Swarm Map has no note
that it started this door and saw no supervisor. That is what it knows, and no more: a door the
page started before Swarm Map kept that note is shown the same way until it is next started.

## How Save applies

1. The rules are checked. A problem is listed and nothing is stored.
2. If the door is stopped: store the record, write `config.json` and `start.sh`. Done.
3. If the door is running: write the new config beside the old one, dry-run it, and only if it
   ends "ready to start" stop the door, store the record, write the files and start it again.
   If the dry run fails, or the door cannot be stopped, nothing is stored: the door keeps the old
   rules, the record still says the old rules, and the page says why.

## What is out

- No create wizard. A door agent is made from a three-field form, then filled in on its Rules tab.
- No Discord app set-up. That stays manual: the form and the page link to the [runbook](pi-discord.md).
- No secret entry. The two files are made by hand, as the runbook says.
- No changing an agent's harness or name after it is made.
- No adopting an agent that was started from the command line.
- No keys page, surfaces page, analytics, tiers, duplicate or restart-all for door agents.
- No new compose generator. The cell is still built by the launcher.
- The dashboard does not start `pm2` itself. Its Start button runs `start.sh` as a plain
  background process. The `pm2` command is shown for whoever wants a supervisor.
- The door's code still runs from the checkout. Only the generated script moved out of it.

## Order of work, test first

Each step starts with a test that fails for the right reason.

1. Record: defaults, validation through the launcher's parser, rendering, secret paths refused
   when they are relative or inside the repo.
2. Service with a fake state folder and a stubbed launcher: status, usage ("—" when unknown),
   receipts newest first, start refused on a failed dry run, save-and-apply, remove.
3. `harness-ref`: a door id resolves only on door routes; Hermes routes answer 409.
4. Routes, and the sweep: every route under `:id` either handles a door agent or refuses it
   without touching anything.
5. UI: the door page shows four tabs; the fleet row shows the badge.
6. Hermes unchanged: the fleet table and agent page for a Hermes agent render exactly as on
   `main`, held by stored snapshots taken before this change.
7. Run the app on a spare port with a temporary data folder and read the pages and routes.

## Try it

This runs the dashboard against an empty home folder, so it sees none of your agents and writes
nothing into your own Swarm Map data.

```bash
export TRY_HOME="$(mktemp -d)"
mkdir -p "$TRY_HOME/.hermes-swarm-map"
echo '{"onboarded":true}' > "$TRY_HOME/.hermes-swarm-map/settings.json"
HOME="$TRY_HOME" HSM_OPERATOR_TOKEN=try npx next dev --port 3947
```

1. Open `http://localhost:3947/login` and sign in with `try`.
2. **Harnesses**, then **Add door agent**. Give it a name, pick Pi or Letta Code, and add a line
   about what it is for. Its page opens on the Rules tab.
3. **Rules**: fill in the ids, the model and the two file paths, then **Save**. The Overview tab
   lists what is still missing.
4. **Start**. It needs Docker and the launcher's two images
   (`node lib/lab/pi-discord/cli.ts build`, with `--harness letta-code` for a Letta Code agent),
   and the two secret files in place. The dry run takes
   a few seconds. If it does not end "ready to start", the page shows the checks that failed and
   nothing is started.
5. **Receipts** and **Logs** fill in once the door is running.

## Tools and approvals

Added with [the tools slice](tools-slice.md).

- **Rules** has a **Tools** card. Three classes (read files, write files, shell), each Off, Ask an
  admin, or Allow. All Off by default. It edits the `tools` part of the same rules record, so the
  launcher's parser decides whether a choice is sound. For an agent that hears anyone in the
  channel the card is switched off, and says why.
- **Receipts** has an **Approvals only** box. It shows each tool call that waited for an admin:
  that it was asked, every answer and who gave it, and whether it ran. A receipt holds the tool's
  name and the call's short hash, never the command.

## What the tests cover, and what they do not

- The record, the service, the routes and the pages are tested with a stubbed launcher and a fake
  state folder. The launcher adapter is tested against a stand-in command that touches no Docker.
- One real dry run was made by hand through the adapter, on one machine, and ended "ready to
  start". No test starts a real door, connects to Discord or calls a model.
- A Letta Code agent made on the page is tested the same way: with a stubbed launcher. The
  launcher itself is run end to end with Letta Code in the cell by
  `conformance/suites/letta-code-discord.docker.test.ts`, against a fake Discord and a scripted
  model, on a machine with Docker. No test joins the two: a Letta Code door started from the
  page's Start button.
- "A supervisor" is read from the door's parent process, and only pm2 is recognised. A door under
  another supervisor is shown as one Swarm Map has no note of starting.
- Under `pm2`, a restart after an error exit goes straight to the launcher. The launcher still
  refuses a cell that is not sealed, but the dashboard's dry run is not run again.
- The dashboard cannot redact the door's log, because it never reads the secrets. The launcher
  redacts what it prints.

