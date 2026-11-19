# Platform Setup Guides

Hermes agents talk to people through chat platforms. This guide covers setup for each one Swarm Map supports: Telegram, Signal, Mattermost, Discord and Slack.

Door agents are set up differently and live in Discord only. See [the Pi in Discord runbook](lab/pi-discord.md).

> **Security default:** a new agent answers nobody. You approve users, groups and channels before it responds.

Every setting below is an environment variable in the agent's `.env`.
You can set most of them from the agent's **Surfaces** tab instead of editing the file.
The full list per platform, and how each is treated on disconnect and duplicate, lives in [`lib/surfaces/registry.ts`](../lib/surfaces/registry.ts). [Surface permissions](surface-permissions.md) explains the model.

---

## Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`
2. Copy the bot token it gives you
3. Paste it in the setup wizard (step 3, Platforms), in **Surfaces → Telegram**, or in `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | none | Bot token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated numeric Telegram user IDs |
| `TELEGRAM_GROUP_ALLOWED_CHATS` | *(empty)* | Comma-separated group chat IDs (negative numbers) the agent may answer in |
| `TELEGRAM_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in groups |

**Approving users:** add them on the **Surfaces** tab, or put their numeric user IDs in `TELEGRAM_ALLOWED_USERS`. A username typed on the Surfaces tab is turned into the numeric ID before it is saved.

---

## Signal

Signal needs a signal-cli daemon on the host. Swarm Map ships one in [`infra/signal-cli/`](../infra/signal-cli/): signal-cli in JSON-RPC daemon mode, reachable on port 8080.

1. In the wizard (step 3) or **Surfaces → Signal**, click **Register / connect a Signal number**. The dialog checks for the daemon and can start it, then registers and verifies the number.
2. The agent's `.env` gets:

```env
SIGNAL_HTTP_URL=http://host.docker.internal:8080
SIGNAL_ACCOUNT=+15551234567
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `SIGNAL_HTTP_URL` | `http://host.docker.internal:8080` | The signal-cli daemon, as the container sees it |
| `SIGNAL_ACCOUNT` | none | Registered phone number in E.164 format |
| `SIGNAL_ALLOWED_USERS` | the agent's admins, or `0` | Who may DM the agent. `0` means nobody |
| `SIGNAL_GROUP_ALLOWED_USERS` | *(empty = no groups)* | Group IDs the agent may answer in, or `*` for all |
| `SIGNAL_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in groups |
| `SIGNAL_GROUP_INVITE_POLICY` | `approved-only` | Whether the agent accepts a group invite on its own |

Leave `SIGNAL_ALLOWED_USERS` set. The Signal adapter reads an unset list as `*` and an empty one as open, which answers strangers. Swarm Map writes `0` for that reason.

**Voice memos:** agents can transcribe incoming voice messages with local Whisper when it is available.

**Profile (display) name:** the name contacts see lives in the signal-cli daemon, not in `.env`. Set it in **Surfaces → Signal** ("Signal profile name"). Swarm Map sends it to the daemon with the `updateProfile` call. The daemon can't report the name back, so the field shows the value Swarm Map last saved.

---

## Mattermost

1. Create a bot account in **Mattermost System Console > Integrations > Bot Accounts**
2. Copy the bot token
3. Configure it in the wizard, in **Surfaces → Mattermost**, or in `.env`:

```env
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your-bot-token
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `MATTERMOST_URL` | none | Your Mattermost server URL |
| `MATTERMOST_TOKEN` | none | Bot access token |
| `MATTERMOST_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated Mattermost user IDs |
| `MATTERMOST_ALLOWED_CHANNELS` | *(empty = deny all)* | Comma-separated channel IDs |
| `MATTERMOST_ADMIN_USERS` | *(empty)* | Mattermost's own admin list for the agent |
| `MATTERMOST_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned |

---

## Discord

1. Create an application and a bot in the [Discord developer portal](https://discord.com/developers/applications), and copy the bot token
2. Invite the bot to your server
3. Paste the token in the wizard (step 3), in **Surfaces → Discord**, or in `.env`:

```env
DISCORD_BOT_TOKEN=your-bot-token
```

A new Discord agent starts closed. These are the values Swarm Map writes:

| Env Var | Written as | Description |
|---------|-----------|-------------|
| `DISCORD_BOT_TOKEN` | your token | Bot token |
| `DISCORD_ALLOWED_USERS` | *(empty)* | User IDs the agent answers |
| `DISCORD_ALLOWED_CHANNELS` | `0` | Channel or category IDs. `0` matches no channel. An empty value would mean every channel, so Swarm Map never writes one |
| `DISCORD_CHANNEL_SCOPED_ACCESS` | `true` | Anyone in an approved channel, or its threads, may talk to the agent. Does nothing until a channel is approved |
| `DISCORD_DM_ALLOWED_USERS` | the agent's admins, or empty | Who may DM. Empty means nobody |
| `DISCORD_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned |
| `DISCORD_THREAD_REQUIRE_MENTION` | `true` | The mention rule holds inside threads too |
| `DISCORD_ALLOW_BOTS` | `none` | Whether other bots are answered |
| `DISCORD_BOTS_REQUIRE_INLINE_MENTION` | `true` | A bot sender must @mention the agent in the message; a reply ping is not enough |

Also available: `DISCORD_ALLOWED_ROLES` (members of these roles count as allowed users) and `DISCORD_IGNORED_CHANNELS` (deny beats allow).
A category ID in a channel list covers every channel in that category, including ones made later.

To open the agent up, approve channels and add users on the **Surfaces** tab.

---

## Slack

Slack runs over **Socket Mode**. The agent holds an outbound WebSocket to Slack, so you need no public URL or webhook endpoint. You set everything up in the Slack app config at [api.slack.com/apps](https://api.slack.com/apps), then give Swarm Map two tokens.

### 1. Create the app and enable Socket Mode

1. **Create New App** → *From scratch*, and pick your workspace.
2. **Socket Mode** (left nav) → toggle **Enable Socket Mode**. When prompted, generate an **App-Level Token** with the `connections:write` scope. Copy it. It starts with `xapp-` and is your `SLACK_APP_TOKEN`.

### 2. Bot Token Scopes

**OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Needed for |
|-------|-----------|
| `app_mentions:read` | receive @mentions |
| `chat:write` | post replies |
| `channels:history`, `channels:read` | read and see public channels |
| `groups:history`, `groups:read` | read and see **private** channels |
| `im:history`, `im:read` | direct messages |
| `users:read` | resolve user identities |
| `reactions:write` *(optional)* | reaction lifecycle (typing, ack) |

### 3. Event Subscriptions

**Event Subscriptions** → toggle **Enable Events → On**. Leave **Request URL** blank: Socket Mode delivers events over the socket, and Slack says "you won't need to specify a Request URL". Under **Subscribe to bot events**, add:

- `app_mention`: @mentions
- `message.channels`: messages in public channels
- `message.groups`: messages in private channels
- `message.im`: direct messages

> **The step people miss:** after you add events or scopes, Slack requires you to **reinstall the app**. Look for the yellow "you've changed permissions/events, reinstall" banner. Until you reinstall, the socket connects but **no events arrive**, and the OAuth token keeps its old scopes.

### 4. Install and collect tokens

**OAuth & Permissions → Install to Workspace**. Copy the **Bot User OAuth Token**. It starts with `xoxb-` and is your `SLACK_BOT_TOKEN`. Then **invite the bot to each channel** it should work in (`/invite @yourbot`). Slack only delivers events for channels the bot is a member of.

### 5. Configure in Swarm Map

Paste both tokens in the wizard, in **Surfaces → Slack**, or in `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `SLACK_BOT_TOKEN` | none | Bot User OAuth token (`xoxb-`), from OAuth & Permissions |
| `SLACK_APP_TOKEN` | none | App-Level token (`xapp-`, `connections:write`), from Socket Mode |
| `SLACK_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated Slack member IDs (`U…`) for **DM** access and admin actions |
| `SLACK_ALLOWED_CHANNELS` | *(empty)* | Comma-separated **channel IDs** (`C…`) the agent may answer in |
| `SLACK_CHANNEL_POLICY` | `approved-only` | With `approved-only`, an empty channel list means **no channels**. List the channels you want |
| `SLACK_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in channels |

**Access model:** in an approved channel, any member can @mention the agent and get an answer. **DMs and admin actions (approvals, adding to channels) stay limited to `SLACK_ALLOWED_USERS`.** A member ID is the `U…` string from a user's Slack profile → *Copy member ID*.

### Troubleshooting

- **The bot connects but never answers @mentions, and the logs show nothing.** The socket is up but events aren't arriving. Usually Event Subscriptions weren't enabled, or the app wasn't reinstalled after adding events (step 3). Reinstall, then recreate the agent so the socket reconnects with the new subscriptions.
- **The bot is in a channel but stays silent there.** The channel isn't in `SLACK_ALLOWED_CHANNELS`. Under `approved-only`, an empty list approves nothing.
- **`missing_scope` errors or stale behavior.** The token in Swarm Map predates a scope change. A running agent keeps the old token. Re-enter the current `xoxb-` token (Surfaces → Slack) and recreate the agent.
- **Do not set `SLACK_ALLOWED_CHANNELS=*`.** The Slack adapter does not honor `*` for channels (hermes-agent-mt#69). It reads it as a channel literally named `*`, which matches nothing and drops every message. List explicit `C…` IDs.
- **Private channels:** the bot needs `groups:read` and `groups:history`, and it must be invited to the private channel.

---

## Google Workspace (preview)

Requires [cyborg-garden/google-multiplayer-mcp](https://github.com/cyborg-garden/google-multiplayer-mcp) installed alongside Swarm Map. Turn it on in step 3 of the wizard. Public agents can't have it.

1. Deploy your agent with Google Workspace enabled
2. Visit the agent's OAuth callback URL to authorize access
3. The agent gets Calendar, Drive and Gmail access

This is a preview. Expect breaking changes.

---

## Common Patterns

- **Closed by default.** Swarm Map writes deny values for new agents: `0` where an empty list would mean "everyone" (Signal DMs, Discord channels), and `approved-only` for Slack channels.
- **Mention required.** Every `*_REQUIRE_MENTION` starts as `true`, so agents stay quiet in groups unless addressed.
- **Wildcard `*`.** On most lists `*` means everyone. Slack channel lists don't honor it. Swarm Map never writes `*` for you.
- **Approve from the Surfaces tab.** It manages users, groups and admins without editing `.env`. Usernames are turned into native IDs before they are saved.
- **Or edit `.env`.** Edit the allowlists directly and recreate the agent.
- **Admins are a separate list.** Who the agent answers (the allowlists) is distinct from who may approve gated tools (the agent's admins). See [Surface permissions](surface-permissions.md).
- **Duplicating an agent gives it a fresh identity.** Duplicate copies the source's config and tools. It resets `HERMES_AGENT_NAME` (the name the policy plugin uses) and `SOUL.md` to the new name, and strips surface credentials and allowlists. A duplicate never inherits the source's persona or shares its surfaces. Edit the new `SOUL.md` and connect surfaces afterward.
