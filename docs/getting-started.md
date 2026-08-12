# Getting Started

Deploy your first AI agent in under 5 minutes.

## Prerequisites

- **Docker Desktop** running ([download](https://docker.com/products/docker-desktop))
- **Node.js 18+** ([download](https://nodejs.org))
- An API key from at least one provider (Anthropic, OpenRouter, Google) — or use Ollama for free local inference

## Install

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
npm install
npm run seed    # first run only
npm run dev     # opens http://localhost:3000
```

## Create Your First Agent

The setup wizard walks you through 5 steps:

### Step 1: Identity

<!-- screenshot: wizard-step-1-identity -->

- **Name** your agent (e.g., "Research Assistant")
- **Persona** (optional) — describe the agent's purpose and personality. This becomes the agent's SOUL.md. If left blank, agents ship with an opinionated default SOUL that covers multi-platform behavior, memory isolation, session lifecycle, and behavioral guardrails.
- **Tier** — Individual (just you), Team (shared), or Org (organization-wide)

### Step 2: Model

<!-- screenshot: wizard-step-2-model -->

Choose your AI provider and model:

| Provider | Example Models | API Key Required? |
|----------|---------------|-------------------|
| Anthropic | claude-sonnet-4-6, claude-opus-4-6 | Yes |
| OpenRouter | Any model on OpenRouter | Yes |
| Ollama | qwen3:8b, llama3.3:70b | No (local) |
| Google | gemini-2.5-flash, gemini-2.5-pro | Yes |
| AWS Bedrock | anthropic.claude-sonnet-4-6-v1 | Yes |

**Tip:** Set a fallback model from a different provider for resilience. If your primary provider has an outage, the agent automatically falls back.

### Step 3: Platforms

<!-- screenshot: wizard-step-3-platforms -->

Connect your agent to messaging platforms. You can skip this and configure later.

- **Telegram** — Paste your bot token from [@BotFather](https://t.me/BotFather)
- **Signal** — Enter a registered phone number (requires signal-cli daemon)
- **Mattermost** — Server URL + bot token
- **Google Workspace** — Calendar, Drive, Gmail (requires OAuth setup after deploy)

### Step 4: Keys

<!-- screenshot: wizard-step-4-keys -->

Enter your API key for the chosen provider. Keys are stored locally in `~/.hermes-{name}/.env` with file permissions locked to your user. They never leave your machine.

Optional: Add GitHub token (for code tools) or Brave Search key (for web search).

**Using Ollama?** No key needed — just make sure Ollama is running and your model is pulled.

### Step 5: Deploy

<!-- screenshot: wizard-step-5-deploy -->

Review your settings and hit Deploy. HSM will:
1. Pull the `ghcr.io/cyborg-garden/hermes-agent-mt:latest` Docker image
2. Scaffold `~/.hermes-{name}/` with config, persona, and plugins
3. Generate a hardened `docker-compose.yml`
4. Start the container
5. Health check until the agent is ready

You'll see a green "Agent deployed!" banner with the assigned port.

## Verify It Works

After deployment, your agent appears on the dashboard.

<!-- screenshot: dashboard-with-agent -->

**From the dashboard you can:**
- View live status (running/stopped)
- Check today's cost and session count
- Open the agent detail page for full configuration

**Test via API:**
```bash
# Check agent health
curl http://localhost:8642/health

# Send a message
curl -X POST http://localhost:8642/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'
```

**Test via messaging platform:**
If you connected Telegram or Signal, send a message to your bot. The agent will respond (after you approve the group/DM if approval policies are enabled).

## What's Running

Your agent is a Docker container with:
- **Opinionated defaults** — compression, memory, session reset, voice transcription all configured
- **Security hardening** — non-root user, dropped capabilities, read-only filesystem
- **HSM integration** — policy plugin reports back to HSM for group approval and budget checks
- **Boot checklist** — on startup, the agent verifies its HSM connection, memory, and skills

## Already Have a Hermes Agent?

You don't need to start from scratch. Click **Import** on the dashboard, point at your existing data directory, and HSM copies it into a managed setup with MT plugins, security hardening, and a new compose file — your original stays untouched.

See [Migrating Existing Agents](migrating.md) for the full guide.

## Next Steps

- [Migrating Existing Agents](migrating.md) — import and upgrade existing Hermes setups
- [Platform Setup](platforms.md) — detailed guides for Signal, Telegram, Mattermost
- [API Reference](../README.md#api-reference) — manage agents programmatically
- [ROADMAP](ROADMAP.md) — what's coming next
