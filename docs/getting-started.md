# Getting Started

This guide takes you from a fresh clone to one running Hermes agent.
The setup wizard does most of the work.

## Prerequisites

- A **Docker-compatible engine**, running. [Docker Desktop](https://docker.com/products/docker-desktop) and [OrbStack](https://orbstack.dev) both work, because Swarm Map only calls the `docker` CLI.
- **Node.js 20.9 or newer** ([download](https://nodejs.org)). Next.js 16 needs it.
- **pnpm**, the package manager this repo uses.
- An API key from one model provider (Anthropic, OpenRouter, Z.ai, Google or AWS Bedrock). With Ollama you need no key.

## Install

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed    # first run only: writes settings and tier config
pnpm dev     # http://localhost:3000
```

`pnpm dev` starts on port 3000.
If that port is taken, it tries the next one, up to 3010.

On first run Swarm Map generates an operator token.
It writes the token to `.env.local` (gitignored, mode `0600`) and logs the path.
Sign in at `/login` with the `HSM_OPERATOR_TOKEN` value from that file.
To choose your own token, set `HSM_OPERATOR_TOKEN` in `.env.local` before you start (see `.env.example`).

## Create Your First Agent

Open **Harnesses** and click **Create New**.
The setup wizard has 5 steps.

### Step 1: Identity

<!-- screenshot: wizard-step-1-identity -->

- **Name.** For example "Research Assistant". The name becomes the agent's slug.
- **Persona** (optional). Describe the agent's purpose and personality. This becomes the agent's `SOUL.md`. Left blank, the agent gets a default `SOUL.md` that covers behavior across platforms, memory isolation, session lifecycle and guardrails.
- **Tier.** Individual (just you), Team (shared) or Org (organization-wide).
- **Use-case package** (optional, shown when templates exist). A package presets the model, provider, platforms and browser for a common use.

### Step 2: Model

<!-- screenshot: wizard-step-2-model -->

Choose a provider and a model.
The wizard suggests models for each provider. You can type any other model name.

| Provider | Suggested models | Key needed |
|----------|------------------|------------|
| Anthropic | claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6 | Yes |
| OpenRouter | Any model on OpenRouter | Yes |
| Ollama | qwen3:8b, llama3.3:70b, and others | No |
| Z.ai (GLM) | glm-5.2, glm-4.6, glm-4.5-flash | Yes |
| Google | gemini-2.5-flash, gemini-2.5-pro | Yes |
| AWS Bedrock | anthropic.claude-sonnet-4-6-v1 | Yes |

With Ollama you pick a runtime.
The default uses the Ollama daemon on your host.
Bundled mode runs a small `qwen2.5:0.5b` model in a sidecar container, with nothing to set up on the host.

You can also set a fallback model.
The agent switches to it when the primary provider fails, so a fallback from a different provider covers an outage.

### Step 3: Platforms

<!-- screenshot: wizard-step-3-platforms -->

Connect the agent to chat platforms. You can skip this and connect them later from the agent's **Surfaces** tab.

- **Mattermost.** Server URL and bot token.
- **Telegram.** The bot token from [@BotFather](https://t.me/BotFather).
- **Discord.** A bot token.
- **Slack.** A bot token (`xoxb-`) and an app token (`xapp-`).
- **Signal.** Register or connect a number. This needs a signal-cli daemon.
- **Google Workspace.** Calendar, Drive and Gmail. You finish the OAuth setup after deploy.
- **GitHub Tools.** Repos, issues and PRs. Add a GitHub token in step 4.
- **Notion.** Pages, databases and search. Needs a Notion integration token.

The same step asks **who can talk to this agent**:

- **Team** (the default). Allowlisted people and roles.
- **Private.** Just you, or a few allowlisted people.
- **Public.** Anyone in approved channels. DMs, terminal, file access and Discord history tools are off. Captcha solving, browser login, GitHub and Google can't be added.

Every agent can browse through Camofox.
The **browser-ops** option adds captcha solving and logged-in browsing. It needs a Camofox container on the host, and public agents can't have it.

See [Platform Setup](platforms.md) for each platform's details.

### Step 4: Keys

<!-- screenshot: wizard-step-4-keys -->

Paste the API key for your provider, or pick a key already saved on this machine.
A new key is stored in `~/.hermes-{name}/.env`, readable only by your user. It does not leave your machine.
Tick **Save this key for reuse** to offer it to later agents.

Under **Optional integrations** you can add a GitHub token (for GitHub Tools) and a Brave Search key (for web search).

With Ollama there is no key. Make sure Ollama is running and the model is pulled, or choose bundled mode in step 2.

### Step 5: Deploy

<!-- screenshot: wizard-step-5-deploy -->

Review the settings and click Deploy. Swarm Map then:

1. Pulls the `ghcr.io/cyborg-garden/hermes-agent-mt:latest` image
2. Writes `~/.hermes-{name}/` with config, persona and plugins
3. Generates a hardened `docker-compose.yml`
4. Starts the container
5. Polls the agent's health endpoint for up to 30 seconds

A green "Agent deployed!" banner shows the agent's port and whether the health check passed.

## Verify It Works

The agent now appears on the dashboard and on the Harnesses page.

<!-- screenshot: dashboard-with-agent -->

From the dashboard you can:

- See whether it is running or stopped
- See today's cost and session count
- Open the agent's page for its full configuration

**Test through the API.**

The first agent's API is on port 8642. Each later agent gets the next free port in steps of 10 (8652, 8662, and so on).
The port is published on the host's loopback address (`127.0.0.1`), so run these commands on the machine the agent runs on.
To publish it on another address of the host, set `apiBindHost` to an IP address with `PUT /api/settings`. This applies to compose files generated or regenerated after the change.

```bash
# Check agent health
curl http://localhost:8642/health

# Send a message
curl -X POST http://localhost:8642/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

**Test through a chat platform.**
If you connected a platform, message the bot from an account on its allowlist.
New agents start closed: add yourself, and the groups or channels it should answer in, from the **Surfaces** tab first.

## What's Running

The agent is one Docker container with:

- **Defaults set for you.** Context compression, memory, a daily session reset and voice transcription.
- **Hardening.** All Linux capabilities dropped except the few the init needs, and a read-only root filesystem.
- **The Swarm Map policy plugin.** The agent asks Swarm Map who its admins are and which groups it may answer in.
- **A boot checklist.** `BOOT.md` lists startup checks: the Swarm Map connection, memory and skills. The `boot_md` plugin that runs it is copied in but not enabled by default.

## Already Have a Hermes Agent?

You don't need to start over.
Click **Import** on the Harnesses page and point it at your existing data directory.
Swarm Map copies it into a managed setup with the base package plugins, hardening and a new compose file. Your original stays as it was.

See [Migrating Existing Agents](migrating.md) for the full guide.

## Door agents (lab-grade)

Swarm Map can also run a second kind of agent, the door agent.
A guard process outside the agent (the "door") holds the chat token, the model key, the rules, the receipts and the budget.
The agent itself runs in a sealed Docker cell.
Door agents use the Pi harness (the default) or Letta Code, and they live in Discord only.

This path is newer and less proven than the Hermes path above.
To try one, click **Add door agent** on the Harnesses page.
The form asks for a name, a harness and one line about what the agent is for.
Read [the first door agent in the dashboard](lab/dashboard-slice.md) before you start one.

## Next Steps

- [Migrating Existing Agents](migrating.md): import and upgrade existing Hermes setups
- [Platform Setup](platforms.md): Signal, Telegram, Mattermost, Discord and Slack
- [API Reference](../README.md#api-reference): manage agents programmatically
- [ROADMAP](ROADMAP.md): what's coming next
