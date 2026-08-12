# Platform Setup Guides

Hermes agents connect to messaging platforms to serve users. This guide covers setup for each supported platform.

> **Security default:** All platforms deny access by default. You must explicitly approve users, groups, and channels before an agent will respond.

---

## Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`
2. Copy the bot token it gives you
3. Paste it in the HSM wizard (Step 2) or add to `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated Telegram user IDs |
| `TELEGRAM_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in groups |

**Approving users:** Use the HSM **Surfaces** tab to add users, or add their numeric Telegram user IDs to `TELEGRAM_ALLOWED_USERS`.

**Group access:** New groups require approval via the HSM policy endpoint before the agent will respond in them.

---

## Signal

Signal requires [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) running as a sidecar (typically a Docker container on port 8080).

1. Start signal-cli-rest-api and register a phone number through it
2. Configure in the wizard or `.env`:

```env
SIGNAL_HTTP_URL=http://host.docker.internal:8080
SIGNAL_ACCOUNT=+15551234567
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `SIGNAL_HTTP_URL` | — | URL to signal-cli-rest-api (use `host.docker.internal` from inside Docker) |
| `SIGNAL_ACCOUNT` | — | Registered phone number in E.164 format |
| `SIGNAL_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated phone numbers for DM access |
| `SIGNAL_GROUP_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated phone numbers for group access |
| `SIGNAL_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in groups |
| `SIGNAL_GROUP_INVITE_POLICY` | `approved-only` | Controls whether agent auto-joins group invites |

**Voice memos:** Agents can transcribe incoming voice messages via local Whisper when available.

**Profile (display) name:** The name contacts see when they DM the agent's number lives in the signal-cli daemon, not in HSM/`.env`. Set it from the harness **Surfaces → Signal** settings ("Signal profile name" field) — HSM writes it via the daemon's `updateProfile` RPC. (The daemon has no read-back, so the field reflects HSM's last-saved value.)

---

## Mattermost

1. Create a bot account in **Mattermost System Console > Integrations > Bot Accounts**
2. Copy the bot token
3. Configure in the wizard or `.env`:

```env
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_TOKEN=your-bot-token
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `MATTERMOST_URL` | — | Your Mattermost server URL |
| `MATTERMOST_TOKEN` | — | Bot access token |
| `MATTERMOST_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated Mattermost usernames |
| `MATTERMOST_ALLOWED_CHANNELS` | *(empty = deny all)* | Comma-separated channel names |
| `MATTERMOST_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned |

---

## Slack

Slack runs over **Socket Mode** — the agent holds an outbound WebSocket to Slack, so you do **not** need a public URL or webhook endpoint. Setup is entirely in the Slack app config at [api.slack.com/apps](https://api.slack.com/apps), then two tokens go into HSM.

### 1. Create the app + enable Socket Mode

1. **Create New App** → *From scratch*, pick your workspace.
2. **Socket Mode** (left nav) → toggle **Enable Socket Mode**. When prompted, generate an **App-Level Token** with the `connections:write` scope. Copy it — it starts with `xapp-`. This is `SLACK_APP_TOKEN`.

### 2. Bot Token Scopes

**OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Needed for |
|-------|-----------|
| `app_mentions:read` | receive @mentions |
| `chat:write` | post replies |
| `channels:history`, `channels:read` | read/see public channels |
| `groups:history`, `groups:read` | read/see **private** channels |
| `im:history`, `im:read` | direct messages |
| `users:read` | resolve user identities |
| `reactions:write` *(optional)* | reaction lifecycle (typing/ack) |

### 3. Event Subscriptions

**Event Subscriptions** → toggle **Enable Events → On**. Leave **Request URL blank** (Socket Mode delivers events over the socket — Slack shows "you won't need to specify a Request URL"). Under **Subscribe to bot events**, add:

- `app_mention` — @mentions
- `message.channels` — messages in public channels
- `message.groups` — messages in private channels
- `message.im` — direct messages

> **Gotcha that costs the most time:** adding events (or scopes) is not enough — Slack requires you to **reinstall the app** afterward. Look for the yellow "you've changed permissions/events, reinstall" banner. Until you reinstall, the socket connects but **no events are delivered**, and the OAuth token keeps its old scopes.

### 4. Install + collect tokens

**OAuth & Permissions → Install to Workspace**. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is `SLACK_BOT_TOKEN`. Then **invite the bot to each channel** it should work in (`/invite @yourbot`); Slack only delivers channel events for channels the bot is a member of.

### 5. Configure in HSM

Paste both tokens in the wizard / **Surfaces → Slack**, or `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `SLACK_BOT_TOKEN` | — | Bot User OAuth token (`xoxb-`), from OAuth & Permissions |
| `SLACK_APP_TOKEN` | — | App-Level token (`xapp-`, `connections:write`), from Socket Mode |
| `SLACK_ALLOWED_USERS` | *(empty = deny all)* | Comma-separated Slack member IDs (`U…`) for **DM** access + admin actions |
| `SLACK_ALLOWED_CHANNELS` | *(empty = all channels the bot is in)* | Comma-separated **channel IDs** (`C…`) to restrict to. **Empty = respond in every channel the bot was invited to** (the usual choice). |
| `SLACK_REQUIRE_MENTION` | `true` | Agent only responds when @mentioned in channels |

**Access model** (same shape as the other surfaces): once the bot is in a channel, any member can @mention it and get answered; **DMs and admin actions (approvals, adding to channels) stay gated to `SLACK_ALLOWED_USERS`**. A member ID is the `U…` string from a user's Slack profile → *Copy member ID*.

### Troubleshooting

- **Bot connects but never responds to @mentions, and nothing appears in the logs.** The socket is up but events aren't arriving. Almost always: Event Subscriptions weren't enabled *or the app wasn't reinstalled* after adding events (step 3). Reinstall, then recreate the agent so the socket reconnects with the new subscriptions.
- **`missing_scope` errors / stale behavior.** The token in HSM predates a scope change. Reinstalling issues effects that a running agent won't pick up until you re-enter the current `xoxb-` token (Surfaces → Slack) and recreate it.
- **Do NOT set `SLACK_ALLOWED_CHANNELS=*`.** The `*` wildcard is **not yet honored** for Slack channels — it's read as a literal channel named `*`, which matches nothing and silently drops every message. Leave it **empty** (all channels the bot is in) or list explicit `C…` IDs. (Tracked: hermes-agent-mt#69.)
- **Private channels:** the bot needs `groups:read` + `groups:history` and must be invited to the private channel.

---

## Google Workspace (preview)

Requires [cyborg-garden/google-multiplayer-mcp](https://github.com/cyborg-garden/google-multiplayer-mcp) installed alongside HSM. Enable via the wizard in Step 3.

1. Deploy your agent with Google Workspace enabled
2. Visit the agent's OAuth callback URL to authorize access
3. Grants Calendar, Drive, and Gmail access to the agent

Currently in preview — expect breaking changes.

---

## Common Patterns

All platforms share these conventions:

| Env Var | Default | Description |
|---------|---------|-------------|
| `HERMES_DM_POLICY` | `approved-only` | Controls DM access across all platforms |
| `HERMES_APPROVAL_ADMIN_ONLY` | `true` | Only admins can run `/approve` |

- **Deny all by default.** Empty allowlists mean no access. You must explicitly approve users.
- **Wildcard `*`** in any allowlist permits all users/groups/channels for that field.
- **`REQUIRE_MENTION` defaults to `true`** on every platform — agents stay quiet in groups unless addressed.
- **Approval via HSM UI:** The **Surfaces** tab lets you manage approved users and groups without editing `.env` files.
- **Approval via `.env`:** Power users can edit allowlists directly and restart the agent.
- **Duplicating an agent gives it a fresh identity.** Duplicate copies the source's config/tools but resets `HERMES_AGENT_NAME` (the agent's HSM-policy identity) and `SOUL.md` to the new name, and strips surface credentials — so a duplicate never inherits the source's policy/persona or shares its surfaces. Customize the new SOUL.md and connect surfaces afterward.
