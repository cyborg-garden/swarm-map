# One Pi agent in one Discord channel: runbook

This starts one real Pi agent in one Discord channel, under the lab's rules. It builds on the
[Pi slice](pi-slice.md). Read that first if "door", "cell" or `decide()` are new to you.

Every id on this page is a placeholder. Keep your config, your token and your key outside the repo.

## In short

- **The door runs on your machine.** It holds the bot token and the model key, talks to Discord and
  to the model, and asks `decide()` about every message before Pi sees it.
- **Pi runs in the sealed cell.** It has no token, no key and no way out except the door.
- **One channel.** The bot is heard in one channel and its threads, and can post nowhere else.
- **Closed by default.** Mention needed, listed people only, other bots ignored, direct messages
  refused, no tools, a monthly budget that refuses when spent.
- **A dry run comes first.** It checks the config, proves the cell is sealed and connects nothing.
- **One command stops it.**

```
  Discord  <-->  door (your machine)  <-->  relay  <-->  cell: shim + Pi
                 token, key, rules,         a pipe       no token, no key,
                 receipts, budget                        no way out
  model    <-->  door
```

## What you need

- Docker running on this machine, and Node 24.
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

`permissions=0` gives the bot nothing server-wide. It gets what it needs in one channel, next.

## 3. Limit it to one channel

In the channel: **Edit Channel**, **Permissions**, add the bot, and allow exactly these four:

| Permission | Why |
|---|---|
| View Channel | To be sent the channel's messages |
| Send Messages | To reply |
| Send Messages in Threads | To reply in a thread of that channel |
| Read Message History | So a reply can sit under the message it answers |

Allow nothing else. If the server's other channels are open to everyone, the bot can see them too.
To close them at Discord, deny **View Channel** to the bot's role on each category. The door
does not rely on that: a message anywhere but the one channel is dropped, with a receipt.

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
| `persona.name` | the `agentId` | What the agent calls itself. One line, up to 40 characters |
| `persona.description` | empty | One line about what it is for, up to 600 characters. It cannot give the agent an ability |
| `discord.guildId` | none | The one server |
| `discord.channelId` | none | The one channel. Its threads count as part of it, private ones included, and share its conversation |
| `discord.adminUserIds` | none | Admins of this agent. At least one. They are also heard |
| `discord.allowedUserIds` | `[]` | Other people who are heard |
| `discord.allowedRoleIds` | `[]` | Holders of these roles are heard |
| `discord.anyoneInChannel` | `false` | Hear anyone who can post in the channel |
| `discord.mentionRequired` | `true` | Answer only when the bot is mentioned |
| `discord.bots` | `"none"` | Other bots: `"none"`, or `"mentions"` to hear any bot or webhook in the channel that writes the bot's mention. The lists of people do not apply to bots, and one bot cannot be named |
| `discord.botLoopLimit` | `4` | Bot messages answered in a row before a person has to speak |
| `discord.readAllMessages` | `false` | Ask Discord for the text of every message. Needed when `mentionRequired` is false |
| `budget.monthlyUsd` | none | Model spend allowed in a calendar month (UTC). After it, model calls are refused |
| `model.baseUrl` | none | An OpenAI-compatible base URL ending in `/v1`, over https |
| `model.id` | none | The model's name at that provider |
| `model.usdPerMTokIn`, `model.usdPerMTokOut` | none | The model's prices per million tokens. The budget is counted with them |

A setting the file does not know is refused. There is no setting for direct messages or tools:
both are off.

**What the agent is told about itself.** Pi's own introduction says it is a coding assistant that
can run commands. Here that is not true, so the launcher replaces it. The agent is told its name
and description, and then, in the launcher's words and not yours: that it can read the messages it
is sent and answer in text, that it has no tools (no commands, files, web, links, images or
attachments, no posting elsewhere, no direct messages), that a mention it writes pings nobody,
that it forgets when it is restarted, and that it must say so when asked for something it cannot
do. A changed persona takes effect on the next `start`.

## 6. Dry run

```bash
node lib/lab/pi-discord/cli.ts dry-run --config /path/to/config.json
```

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
| S0d | What Docker really gave the cell matches what was written |
| S1 | From inside, only the door answers: not the internet, not your machine, not the sink |
| S2 | The shim, the gate and Pi cannot be changed from inside |
| S3 | No folder of your machine is in the cell |
| S9 | The dry run left no container behind |

## 7. Start

```bash
node lib/lab/pi-discord/cli.ts start --config /path/to/config.json
```

It stays in the foreground and prints one line per state change. In order: the cell comes up and is
checked from outside, then the door connects to Discord, then the cell joins the door. If any step
fails, everything is taken down again and nothing is left running. To keep it running after you
close the terminal, start it under `nohup` or your own process manager.

If the last run was killed before it could clean up, `start` removes the containers it left first.

## 8. Verify

1. In the channel, mention the bot. It should answer in that channel.
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
| `drop adm.rooms` | Not the allowed channel |
| `drop adm.users` | The sender is not on the list |
| `drop addr.mention` | No mention |
| `drop dm.closed` | A direct message |
| `drop bots.mode` / `bots.loop` | Another bot, or too many bot messages in a row |
| `drop in.once` | An edited message is not read again; a reply to a deleted message is not posted |
| `allow out.still-allowed` | A reply was posted |
| `allow out.size` | The reply was too long and was cut |
| `deny budget.cap` | The month's budget is spent |

## 9. Stop

```bash
node lib/lab/pi-discord/cli.ts stop --config /path/to/config.json
```

That is the kill switch. It stops the door, which closes the Discord connection, and removes the
cell's containers, network and volume by name. Ctrl-C in the terminal where it runs does the same.
If a run was killed some other way, `stop` still removes what it left.

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
   `pi-discord.docker.test.ts` through the library. The command's own last steps (reading the two
   files from your environment, Ctrl-C) are not run by a test.
3. **The cell is shown sealed on one machine**, with the limits listed in the Pi slice. The relay
   is new: it is the one container with a route out, because it has to reach the door on your
   machine. It carries two ports and holds nothing.
4. **Conversations do not outlive a stop.** The cell's folder is removed with it.
5. **One process, no supervisor.** If the cell stops, messages are dropped with a receipt saying
   no harness is connected, until you stop and start again. If the door stops, the cell stays
   up, sealed and silent, until `stop` or the next `start` removes it.
6. **Text only.** Attachments are listed for the door and not passed to Pi. There are no slash
   commands and no reactions. A reply to the bot with its ping switched off counts as addressed
   to it, but without `readAllMessages` Discord sends no text for such a message, so the agent is
   handed an empty one.
7. **How Pi behaves as a chat partner is not tested.** It is a coding agent started with no tools
   and told so. That the model is given that text is tested. That a real model keeps to it is not.
8. **The budget is counted with the prices you give.** They are not checked against the
   provider's. One call can overshoot the cap, because the cap is checked before a call.
9. **The bot-loop count is kept in memory.** It starts again from nothing when the door restarts.
