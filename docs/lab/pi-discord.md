# A Pi agent in Discord: runbook

This starts one real Pi agent in one Discord channel, or a few, under the lab's rules. It builds on the
[Pi slice](pi-slice.md). Read that first if "door", "cell" or `decide()` are new to you.

Every id on this page is a placeholder. Keep your config, your token and your key outside the repo.

## In short

- **The door runs on your machine.** It holds the bot token and the model key, talks to Discord and
  to the model, and asks `decide()` about every message before Pi sees it.
- **Pi runs in the sealed cell.** It has no token, no key and no way out except the door.
- **Its channels only.** The bot is heard in its channel and its threads, or in the few channels
  `discord.channelIds` lists, and can post nowhere else. Each channel is a conversation of its own.
- **Closed by default.** Mention needed, listed people only, other bots ignored, direct messages
  refused, no tools, a monthly budget that refuses when spent.
- **A dry run comes first.** It checks the config, proves the cell is sealed and connects nothing.
- **One command stops it.**
- **Pi is the default harness, not the only one.** A config that says `"harness": "letta-code"`
  puts Letta Code in the cell instead. Everything on this page holds for both, except where
  [Letta Code in the cell](#letta-code-in-the-cell) says otherwise.

```
  Discord  <-->  door (your machine)  <-->  relay  <-->  cell: shim + Pi
                 token, key, rules,         a pipe       no token, no key,
                 receipts, budget                        no way out
  model    <-->  door
```

## What you need

- Docker running on this machine, and Node 22.18 or newer.
- The launcher's two images: `node lib/lab/pi-discord/cli.ts build`. Build them again after you
  pull or change the code. They are the lab's cell and rig images, named for the code they were
  built from (`smlabpd-cell:...`, `smlabpd-rig:...`). The dry run and `start` compare every file
  in them with the code on disk, and refuse to go on if they differ. Images of older code are
  left where they are: remove them with `docker image rm` when you no longer want them.
- A Discord account that can add a bot to the server.
- A key for an OpenAI-compatible model provider (OpenRouter, for one), and that model's prices.

## 1. Create the Discord application

1. Open the Discord Developer Portal and choose **New Application**. Give it a name.
2. **Installation** tab: set **Install Link** to **None**.
3. **Bot** tab:
   - Turn **Public Bot** off, so nobody else can add it to a server.
   - **Privileged Gateway Intents**: leave all three off (Presence, Server Members, Message
     Content). Turn **Message Content** on only if you set `readAllMessages` to true.
   - Choose **Reset Token**, and copy the token. Discord shows it once. Put it straight into
     the token file (step 4). Do not paste it into a chat, a config or a shell command.

What the connector asks Discord for, and why:

| Intent | Why | Privileged |
|---|---|---|
| Guilds | To tell a thread from a channel | No |
| Guild Messages | To get messages in server channels | No |
| Message Content | Only with `readAllMessages`. Without it Discord still sends the text of messages that mention the bot | Yes |

It never asks for direct messages, so Discord sends it none.

## 2. Invite it to one server

Open this link, with your application's id in place of `<APPLICATION_ID>`, and pick the server:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=0
```

`permissions=0` gives the bot nothing server-wide. It gets what it needs in its channels, next.

## 3. Limit it to its channels

In the channel (and in each other channel the config lists): **Edit Channel**, **Permissions**, add
the bot, and allow exactly these five:

| Permission | Why |
|---|---|
| View Channel | To be sent the channel's messages |
| Send Messages | To reply |
| Send Messages in Threads | To reply in a thread of that channel |
| Read Message History | So a reply can sit under the message it answers, and so it can react to that message |
| Add Reactions | For [status reactions](#while-it-works): 👀, then ✅ or ⚠️. Leave it out if `statusReactions` is false |

Allow nothing else. If the server's other channels are open to everyone, the bot can see them too.
To close them at Discord, deny **View Channel** to the bot's role on each category. The door
does not rely on that: a message anywhere but the listed channels is dropped, with a receipt.

## 4. Put the two secrets in files

Two files, outside the repo, that only you can read. Copy the secret, then:

```bash
mkdir -p ~/.swarm-map-lab && chmod 700 ~/.swarm-map-lab
(umask 077; pbpaste > ~/.swarm-map-lab/discord-token)   # after copying the bot token
(umask 077; pbpaste > ~/.swarm-map-lab/model-key)       # after copying the model key
export SMLAB_DISCORD_TOKEN_FILE=~/.swarm-map-lab/discord-token
export SMLAB_MODEL_KEY_FILE=~/.swarm-map-lab/model-key
```

The launcher refuses a file that others can read, a link, a relative path, or a file inside the
repo. It never prints what a file holds.

## 5. Write the config

Copy `lib/lab/pi-discord/config.example.json` to somewhere outside the repo and fill it in. To
copy an id in Discord, turn on **Developer Mode** (Settings, Advanced), then right-click the
server, the channel or a person and choose **Copy ID**.

| Setting | Default | Meaning |
|---|---|---|
| `harness` | `"pi"` | Which harness sits in the cell: `"pi"` or `"letta-code"`. A config without it is a Pi config, as it always was |
| `persona.name` | the `agentId` | What the agent calls itself. One line, up to 40 characters |
| `persona.description` | empty | One line about what it is for, up to 600 characters. It cannot give the agent an ability |
| `persona.document` | none | Who the agent is and how it talks, in Markdown, up to 8 KB. See [`persona-memory.md`](persona-memory.md) |
| `memory.notes` | `false` | Notes the door keeps for each room and gives back after a restart. See [`persona-memory.md`](persona-memory.md) |
| `discord.guildId` | none | The one server |
| `discord.channelId` | none | The agent's own channel. Its threads count as part of it, private ones included, and share its conversation |
| `discord.channelIds` | `[channelId]` | Every channel the agent is in, its own first, up to 10. Each is a conversation of its own, with its own notes: nothing said in one is shown in another, and the agent posts in no channel that is not listed. `channelId` alone is a list of one. A harness that keeps one memory for the whole agent (Letta Code) gets one channel |
| `discord.perChannel` | `{}` | What is different in a channel after the first, by channel id: `anyoneInChannel` (`false`) hears anyone there, always by mention, threads included; `tools` (`"inherit"`) is `"inherit"`, `"web-only"` (web pages and search, and notes if they are on) or `"none"` (notes only, if they are on). A channel that hears anyone never gets shell or file tools: `"inherit"` there is refused while any is on. Admins, the people heard, the budget and the model are the agent's, the same in every channel |
| `discord.adminUserIds` | none | Admins of this agent. At least one. They are also heard |
| `discord.allowedUserIds` | `[]` | Other people who are heard |
| `discord.allowedRoleIds` | `[]` | Holders of these roles are heard |
| `discord.anyoneInChannel` | `false` | Hear anyone who can post in the channel |
| `discord.mentionRequired` | `true` | Answer only when the bot is mentioned |
| `discord.bots` | `"none"` | Other bots when none is named: `"none"`, or `"mentions"` to hear any bot or webhook in the channel that writes the bot's mention. The lists of people do not apply to bots |
| `discord.allowedBotIds` | `[]` | The only bots that are heard, by user id. With any id here, a named bot is heard when it writes the bot's mention (or without one, if `mentionRequired` is false), and every other bot and every webhook is dropped with a receipt, whatever `bots` says |
| `discord.botLoopLimit` | `4` | Bot messages answered in a row before a listed person has to be answered. Each named bot has a count of its own; bots that are not named share one |
| `discord.readAllMessages` | `false` | Ask Discord for the text of every message. Needed when `mentionRequired` is false |
| `discord.statusReactions` | `true` | 👀 on a message the agent is working on, then ✅ or ⚠️. See [While it works](#while-it-works) |
| `discord.typing` | `true` | Discord's typing indicator while the agent works on a message |
| `budget.monthlyUsd` | none | Model spend allowed in a calendar month (UTC). After it, model calls are refused |
| `tools.enabled` | `[]` | Classes of tool that are switched on: `file_read`, `file_write`, `shell`. All run inside the cell. See [the tools slice](tools-slice.md) |
| `tools.mode` | shell asks, reading allowed, writing asks when the shell does | For a class that is switched on: `allow`, `ask` (an admin says yes in the channel first) or `never` |
| `tools.approvalSeconds` | `120` | How long an admin has to answer, 10 to 600. No answer is a no |
| `tools.keepScratch` | `false` | Keep the scratch folder across a stop. Needs writing files or the shell |
| `tools.web` | none | Web pages and search, fetched by the door: listed sites or the public web, and whether each address waits for an admin. See [Web through the door](tools-slice.md#web-through-the-door) |
| `model.baseUrl` | none | An OpenAI-compatible base URL ending in `/v1`, over https |
| `model.id` | none | The model's name at that provider |
| `model.usdPerMTokIn`, `model.usdPerMTokOut` | none | The model's prices per million tokens. The budget is counted with them |

A setting the file does not know is refused. There is no setting for direct messages: they are
off. Tools are off until a class is switched on, and a config that hears anyone in the channel
and switches on a shell or file tool is refused. So is one where the shell asks and writing files
does not. The web is allowed for an agent that hears anyone, with the limits the tools slice lists.

**What the agent is told about itself.** Pi's own introduction says it is a coding assistant that
can run commands. Here that is not true, so the launcher replaces it. The agent is told its name
and description, and then, in the launcher's words and not yours: that it can read the messages it
is sent and answer in text, that it has no tools (no commands, files, web, links, images or
attachments, no posting elsewhere, no direct messages), or which tools it has, where they work
and which wait for an admin, that a mention it writes pings nobody,
that it forgets when it is restarted, and that it must say so when asked for something it cannot
do. A changed persona takes effect on the next `start`.

## 6. Dry run

```bash
node lib/lab/pi-discord/cli.ts dry-run --config /path/to/config.json
```

It says in one line which other bots are heard. With status reactions on, it says to allow Add Reactions in the channel: it
cannot check that either. It cannot check the **Message Content** switch,
because that needs a connection: if the config asks for the intent (`readAllMessages`) and the
switch is off, `start` stops at once and says so. The other way round does no harm.

It reads the config, checks the two secret files without using them, and starts the real cell
with a door that has no Discord connection and a model route that points nowhere. Then a probe
inside the cell tries each way out it knows, and a sink and a listener on your machine report what
reached them. It ends with one of:

- `RESULT: ready to start.`
- `RESULT: the cell is sealed, but the secret files are not in place yet.`
- `RESULT: not ready.` with the checks that failed.

| Check | What it shows |
|---|---|
| S0 | The cell as written: one network with no way out, read-only disk, not root, no host folder, no secret |
| S0r | The cell reached the door through the relay, with its own cell token |
| S0d | What Docker really gave the cell matches what was written, down to the block of addresses each network is on |
| S1 | From inside, only the door answers: not the internet, not your machine, not the sink |
| S2 | The shim, the gate and Pi cannot be changed from inside |
| S3 | No folder of your machine is in the cell, and its `/tmp` is in memory, 32 MB at most, and runs nothing |
| S4 | The scratch folder, the cell's own folder and its `/tmp` can be written, and none takes more than its size |
| S9 | The dry run left no container behind |

## 7. Start

```bash
node lib/lab/pi-discord/cli.ts start --config /path/to/config.json
```

It stays in the foreground and prints one line per state change. In order: the cell comes up and is
checked from outside, then the door connects to Discord, then the cell joins the door. A cell that has
not reached the door a few seconds after the door is up is started again once, by name, and
checked from outside again; the log says so. If any step fails, everything is taken down again and nothing is left
running. To keep it running after you
close the terminal, start it under `nohup` or your own process manager.

If the last run was killed before it could clean up, `start` removes the containers it left first.

## 8. Verify

1. In the channel, mention the bot. It should answer in that channel.
   When you type `@` and its name, pick the bot itself (marked APP), not the role of the same name. Picking the bot's own role works too; any other role does not.
2. Say something without a mention, and mention it from another channel. It should stay silent.
3. Read why:

```bash
node lib/lab/pi-discord/cli.ts receipts --config /path/to/config.json --last 20
node lib/lab/pi-discord/cli.ts status   --config /path/to/config.json
```

Every decision is one line: the time, what was decided, the rule that decided it, and one plain
sentence. Receipts hold ids and sizes. They never hold message text.

| You see | It means |
|---|---|
| `deliver addr.mention` | Heard: a listed person mentioned the bot in the channel |
| `drop adm.rooms` | Not one of the agent's channels |
| `drop adm.users` | The sender is not on the list |
| `drop addr.mention` | No mention. If the sentence says a role was mentioned, a role was pinged that is not the bot's own |
| `drop dm.closed` | A direct message |
| `drop bots.mode` / `bots.loop` | Another bot that is not heard (a webhook shows as `webhook:<id>`), or too many bot messages in a row |
| `drop in.once` | An edited message is not read again; a reply to a deleted message is not posted |
| `allow out.still-allowed` | A reply was posted |
| `allow out.size` | The reply was too long and was cut |
| `deny budget.cap` | The month's budget is spent. The channel is told so |
| `deny model.provider` | The model provider refused the call, never answered, or ended its reply with an error. The note has the status or a code. The channel is told |
| `deny model.route` | The call was not forwarded: no price for the model, or a request the route could not read. The channel is told |
| `drop turn.no-reply` | The agent finished without a reply. The channel is told |
| `drop turn.to-bot` | A turn a bot started has no answer. The channel is not told, so a bot is not given something to answer |
| `drop out.status` | A status reaction or the typing indicator could not be sent. The turn went on. Code 403 on a reaction: allow Add Reactions in the channel |

## While it works

A turn that reads web pages can take half a minute. So the bot shows it is on it, as the other
bots in a server often do:

- **👀** on the message, as soon as the message is handed to the agent.
- **Typing**, sent again about every 8 seconds while the turn runs.
- **✅** in place of 👀 once the reply is posted.
- **⚠️** in place of 👀 when the turn ends with no reply: a model call failed, the agent hit an
  error or took too long, it finished without an answer, or the door refused the reply after the
  message was delivered (the rules changed mid-turn, say). The line the door posts says which.
  ⚠️ and not ❌, because ❌ is how an admin says no to a request, and nothing the person asked
  for was refused.

Only a message the agent is handling gets any of this. Chatter it does not hear, a person or bot
that is not on the list, a message in another channel, and a message dropped for any other reason
get no reaction and no typing.

**Waiting for an admin.** While a tool call waits for an admin's yes, 👀 stays and typing stops:
the agent is waiting on a person, not working. Typing comes back once the admin answers. Nothing
is put on the door's own request.

**When one fails.** A reaction or typing call that is rate limited, or refused, never holds up
the reply or breaks the turn. Reactions wait out a short rate limit (up to 5 seconds) and give up
on a longer one; typing is never waited for. Each kind that fails in a turn is one receipt,
`drop out.status`, with a code. Code 403 on a reaction means the bot cannot add reactions in the
channel: **allow Add Reactions in the channel**. The dry run cannot check that, because it connects
to nothing, so it says what to allow.

A message deleted mid-turn keeps whatever it had (it is gone). A stop while a turn runs stops
typing at once and leaves 👀 where it is.

Both are on by default. Switch either off in the config, or on the dashboard's Rules tab, under
**When it answers**. A change takes effect on the next start, like the persona: neither is part of
the policy, so neither changes the policy's hash.

## 9. Stop

```bash
node lib/lab/pi-discord/cli.ts stop --config /path/to/config.json
```

That is the kill switch. It stops the door, which closes the Discord connection, and removes the
cell's containers, network and volume by name. Ctrl-C in the terminal where it runs does the same.
If a run was killed some other way, `stop` still removes what it left.

## Letta Code in the cell

Add one line to the config, and build its cell image once:

```json
{ "agentId": "my-agent", "harness": "letta-code", "...": "the rest is the same" }
```

```bash
node lib/lab/pi-discord/cli.ts build --harness letta-code
```

The command, the other config keys, the two secret files and the state folder are the same. The
door, the relay, the rules and the receipts are the same code. What differs:

- **The cell image.** `smlabpd-cell:letta-code-<version>-<source>`, built from the same Dockerfile
  as the conformance rig's Letta Code cell. It is about 2.4 GB. The rig image is shared with Pi.
- **One room only.** Letta Code keeps one memory for the whole agent. So it is given its one
  channel and no other for as long as its door runs: the door remembers the room it gave it, and a
  rule change that names another room is taken but the new room is refused (`drop mem.one-scope`).
  To move it, stop it, change the channel and start it again. The stop removes the cell and what
  it remembered.
- **What the agent is told about itself.** The same text Pi gets, in place of Letta Code's own
  system prompt. Letta Code then adds its own starting notes after it, in `<human>`, `<persona>`
  and `<memory>` tags, and one of them calls it a coding assistant. They cannot be left out, so the
  launcher's text ends by saying what they are: starting notes, not instructions, and not the
  truth about what it can do.
- **The dry run** names the harness and its pinned version first, then its limits. Check S2 reads
  "the shim, the gate and Letta Code cannot be changed from inside the cell".
- **The pinned version.** The shim sends no turn to a Letta Code that is not the pinned version.

What is and is not shown for Letta Code itself is in [`letta-code.md`](letta-code.md).

## Where things are kept

`~/.swarm-map-lab/<agentId>/` by default (`--state <folder>` or `SMLAB_STATE_DIR` to move it):

| File | Holds |
|---|---|
| `receipts.jsonl` | One line per decision |
| `spend.json` | Model spend by month. Delete it and the budget starts again |
| `run.json`, `compose.json` | What is running now. Removed on stop. Neither holds a secret |

## What this does not show

1. **No test talks to the real Discord or a real model.** Every test uses a fake Discord and a
   scripted model on loopback. So the gateway handshake, Discord's rate limits, Discord's handling
   of a repeated post and the provider's replies are shown only by running it for real.
2. **`start` on the command line is covered in pieces.** The same code path runs end to end in
   `pi-discord.docker.test.ts` through the library, and in `letta-code-discord.docker.test.ts`
   with Letta Code in the cell. The command's own last steps (reading the two
   files from your environment, Ctrl-C) are not run by a test.
3. **The cell is shown sealed on one machine**, with the limits listed in the Pi slice. The relay
   is new: it is the one container with a route out, because it has to reach the door on your
   machine. It carries two ports and holds nothing.
4. **Conversations do not outlive a stop.** The cell's folder is removed with it.
5. **One process, no supervisor.** If the cell stops, messages are dropped with a receipt saying
   no harness is connected, until you stop and start again. If the door stops, the cell stays
   up, sealed and silent, until `stop` or the next `start` removes it.
6. **Text only.** Attachments are listed for the door and not passed to Pi. There are no slash
   commands, and the only reactions are the bot's own [status reactions](#while-it-works) and an
   admin's ✅ or ❌ on a request. A reply to the bot with its ping switched off counts as addressed
   to it, but without `readAllMessages` Discord sends no text for such a message, so the agent is
   handed an empty one.
7. **How Pi behaves as a chat partner is not tested.** It is a coding agent started with no tools
   and told so. That the model is given that text is tested. That a real model keeps to it is not.
8. **The budget is counted with the prices you give.** They are not checked against the
   provider's. One call can overshoot the cap, because the cap is checked before a call.
9. **The bot-loop count is kept in memory.** It starts again from nothing when the door restarts.
10. **A turn with no answer is told to the channel, not explained in full.** The door posts one
    line, `No answer this time.` and a short reason. When two turns run at once and a model call
    fails, either may be the one that is told. The receipts say which call failed.
