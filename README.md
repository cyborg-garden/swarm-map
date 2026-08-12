# Swarm Map

> **Swarm Map (SM)** — formerly Hermes Swarm Map / HSM.

A commons, public goods project of [NimbleCo](https://www.nimbleco.ai/). 

**Multiplayer admin and orchestrator platform for heterogeneous agent runtimes.** One dashboard for two shapes of agent: [Hermes](https://github.com/cyborg-garden/hermes-agent-mt) agents, where each agent is its own container, and [Letta](https://github.com/letta-ai/letta) agents, where memory-first agents live as rows on one shared server. Multi-tenant security, model cascades, and platform connections come from the same control plane either way.

*First of its kind, a point and click GUI for not just managing agent runtimes, but also who can do what and where. Solves the multi-tenant agent problem. View the godhead of complexity without derealizing. Share compute.*

**Runtime support is not symmetrical yet.** Hermes is the mature path; Letta support is read-only plus send-a-message. See [Runtimes](docs/runtimes.md) for the exact shipped/not-shipped line — we would rather you read a boring matrix than discover the gap after deploying.

<img width="1352" height="763" alt="Screenshot 2026-05-26 at 5 01 19 pm" src="https://github.com/user-attachments/assets/4b94f0d1-d9b8-4a81-8b47-b2dae1940741" />
*Calm UX showing a variety of config settings across agent harness runtimes*

---

## Why Swarm Map?

AI agents are most useful when they're always on — running on a server, reachable from your phone, remembering context across conversations. But running *multiple* agents across *multiple* platforms for *multiple* users? That's where it gets hard.

Swarm Map is the control plane. One UI to deploy, configure, and manage a fleet of agents — each with its own personality, memory, platform connections, and budget. Everything a single agent can do, but multiplied and multiplayer.

It also gets harder when your agents aren't all the same *shape*. A Hermes agent is a container you can start, stop, rebuild, and attach messaging surfaces to. A Letta agent is a row in a shared server's database with a memory-first architecture — no container of its own, nothing to `docker restart`. Swarm Map models both behind one runtime seam (`ContainerRuntimeAdapter` for container runtimes, a separate REST provider for Letta) instead of pretending everything is a container.

## What People Build With It

**The indie hacker** runs 3 agents: a customer support bot on Telegram, a research assistant on Signal, and a coding helper via API. Each has its own model cascade (Claude for complex tasks, Gemini Flash for quick ones), its own budget cap, and its own personality. SM manages all three from one dashboard.

**The small team** gives each team member their own AI assistant on Mattermost. Memory is scoped per-channel — what the engineering channel discusses stays there. The team lead manages API keys, monitors costs, and approves new group connections from SM.

**The AI researcher** runs 8 specialized agents across Signal and Telegram for different research domains. SM handles group approval policies, model fallback chains, and cost tracking across the fleet. New agents deploy in minutes via the wizard.

## What You Get

🧙 **Setup Wizard** — Deploy a new agent in 5 clicks. Opinionated defaults for compression, memory, security, and voice transcription so it works out of the box.

🔀 **Model Cascade** — Ordered fallback chains across providers. Start with Claude, fall back to Gemini, fall back to local Ollama. Per-agent.

🔐 **Multi-Tenant Security** — Per-context memory isolation, group approval policies, admin-only commands, encrypted API keys. Each conversation thread is a walled garden.

📊 **Fleet Dashboard** — See all your agents at a glance. Health, costs, session counts, model usage. Stop, restart, or rebuild any container from the UI.

🔌 **Platform Connections** — Connect agents to Signal, Telegram, Mattermost, or expose them via API. Manage surfaces from the UI.

💰 **Budget Enforcement** — Set monthly spend limits per API key. Agents self-throttle when budget is exceeded.

🧩 **Two Runtimes, One Seam** — Hermes (container-per-agent) and Letta (memory-first agents as rows on one shared server) in the same fleet view. Feature parity is partial and documented in [Runtimes](docs/runtimes.md); the six bullets above describe the Hermes path.

---

## Runtimes

Swarm Map manages two agent runtimes. They are **not** at parity, and the docs say so on purpose.

| | **Hermes** | **Letta** |
|---|---|---|
| Agent is | a container | a row on a shared server |
| Deploy from the wizard | yes | yes (brings the shared server up, creates the agent) |
| Start / stop / restart / rebuild | yes | n/a — no container to control (the *server* is a container and does have these) |
| Read agent state | yes | yes — fleet list, core-memory blocks, model handle |
| Send a message from the UI | yes | yes |
| Edit memory, reconfigure, delete agent | yes | **not shipped** — the Letta REST surface in Swarm Map is read-only plus send-message |
| Messaging surfaces (Signal / Telegram / Mattermost / Discord) | yes, direct | only via a Hermes front that proxies a group conversation to the agent |
| Git-backed memory files (memfs) | n/a | **not enabled** — we never request `git_enabled`, so agents take the server default (`false`) |
| Group approval + audit | yes | inherited when reached through a Hermes front |
| Budget enforcement | yes | **does not cover proxied Letta turns** — see below |

**Budget caveat, stated plainly.** Group approval and the audit trail inherit cleanly through a Hermes front, because they gate the turn before it runs. Budget does **not** inherit — on any path. Swarm Map's monthly-spend check sums `input_tokens` / `output_tokens` from each agent's `state.db` `sessions` table, and the Letta bridge never writes those columns: it records only `last_prompt_tokens` (context size). So proxied Letta spend is not counted and a soft cap is never approached. Do not deploy a Letta agent behind a Hermes front expecting the front's budget cap to bound it.

Full detail, including the route inventory that backs these claims: [docs/runtimes.md](docs/runtimes.md).

---

## Quick Start

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed         # first run: writes settings + tier config
pnpm dev          # http://localhost:3000
```

On first launch, the setup wizard detects your Hermes compose directories automatically. Point it at your agent directory and go. Choosing the Letta runtime in the wizard instead brings up the shared Letta server and creates the agent on it.

**New here?** Read the [Getting Started guide](docs/getting-started.md) for a full walkthrough.

### Requirements

- **Node.js 18+**
- **Docker** running locally (used for container management)
- For the Hermes runtime: **Hermes Agent** instances — Swarm Map deploys the multi-tenant fork [cyborg-garden/hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt), a fork of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- For the Letta runtime: a **Letta server** — the wizard brings one up for you via `docker/letta-compose.yml`

---

## Features

- **Discovery** — auto-detect Hermes agent containers and compose files
- **Letta fleet view** — list agents on a configured Letta server, read their core memory, send a message (read-only otherwise)
- **Per-agent configuration** — edit env vars, SOUL.md personas, surface connections
- **Model cascade** — ordered fallback chains across providers (Anthropic, OpenAI, Bedrock, etc.)
- **Surface management** — connect agents to Telegram, Signal, Mattermost
- **Restart / rebuild / purge** — container lifecycle via UI or API
- **Policy enforcement** — group access control, DM approval gating, admin resolution
- **Agent creation wizard** — scaffold and deploy new agents from the UI
- **API key management** — AES-256-GCM encrypted at rest
- **Audit log** — track who changed what and when

<img width="911" height="742" alt="Screenshot 2026-05-27 at 3 27 31 pm" src="https://github.com/user-attachments/assets/68a7f594-4e17-419a-8cb6-180b94cac40a" />

<img width="680" height="686" alt="Agent creation wizard" src="https://github.com/user-attachments/assets/62ff24dc-d266-4c18-9542-038ac1b09eaa" />

---

## Running on a Remote Server

Build once, run in production mode:

```bash
pnpm build
npx next start --port 3000 --hostname 0.0.0.0
```

Access from any machine on the network at `http://<hostname>:3000`. Run behind nginx or Tailscale for HTTPS or external access.

Set `ALLOWED_DEV_ORIGINS` in `.env` for dev mode on remote machines (see Configuration).

---

## Architecture

<img width="1023" height="724" alt="Screenshot 2026-05-27 at 2 50 56 pm" src="https://github.com/user-attachments/assets/a2ad3118-81a2-433a-ae02-289546e7e02d" />

- **Next.js 16** (App Router) + **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Lucide Icons**
- **Docker CLI** (via shell) for container management
- **Vitest** for testing
- **AES-256-GCM** key encryption at rest
- File-based agent config at `~/.hermes-swarm-map/`

---


## Security Model

SM assumes a **reasonably trusted team** — all users with access to the dashboard can manage all agents, keys, and configuration. There is no per-user role separation or access scoping within a deployment.

**What's protected:**
- API keys are encrypted at rest (AES-256-GCM) with a machine-local key
- Audit log tracks who changed what
- Per-agent memory scoping isolates conversation contexts
- Group approval policies gate which platforms agents can join

**What's not scoped:**
- Dashboard access is all-or-nothing — anyone who can reach the UI can manage the fleet
- Skills, tools, and agent configurations are shared across all operators
- The underlying Hermes agent harnesses remain vulnerable to prompt injection from malicious external content (messages, ingested documents), the same as any LLM-based system

**In practice:** run SM on a private network or behind authentication (Tailscale, nginx basic auth, etc.) and limit access to people you trust with your API keys and agent configurations.
---

## API Reference

Any AI agent (Claude Code, Hermes, etc.) can orchestrate your fleet via the REST API — no GUI needed.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/harnesses` | List all harnesses with live Docker state |
| `GET` | `/api/harnesses/:id` | Single harness detail |
| `POST` | `/api/harnesses/:id/restart` | Restart (`{ mode: 'quick'\|'rebuild'\|'purge' }`) |
| `POST` | `/api/harnesses/:id/stop` | Stop |
| `POST` | `/api/harnesses/:id/start` | Start |
| `POST` | `/api/harnesses/restart-running` | Bulk quick-restart all running |
| `GET` | `/api/harnesses/:id/logs` | Container logs (`?lines=100`) |
| `GET` | `/api/harnesses/:id/models` | Model cascade config |
| `PUT` | `/api/harnesses/:id/models` | Update cascade (`{ cascade: [...] }`) |
| `POST` | `/api/harnesses/:id/duplicate` | Clone harness config (`{ name }`) |
| `POST` | `/api/harnesses/:id/artifacts/sync` | Install missing manifest artifacts onto an existing agent, no-clobber (`{ dryRun?, force? }`) |
| `POST` | `/api/setup/deploy` | Deploy new agent (full wizard payload) |
| `POST` | `/api/setup/detect` | Scan for Hermes compose directories |
| `GET` | `/api/keys` | List keys (masked, from agent .env files) |
| `GET` | `/api/tools` | Tool registry (from agent configs) |
| `GET` | `/api/memory-scopes` | Memory scopes per agent |
| `GET` | `/api/audit` | Audit log (`?who=&what=&since=`) |
| `GET/PUT` | `/api/settings` | App settings |

Letta runtime — **read-only plus send-message.** This is the complete surface; there is no `PATCH`, `PUT`, or `DELETE` for Letta agents:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/letta/harnesses` | Letta server + its hosted agents, as harness rows |
| `GET` | `/api/letta/agents` | List agents on the Letta server |
| `GET` | `/api/letta/agents/:id/blocks` | Core-memory blocks (read-only) |
| `GET` | `/api/letta/agents/:id/files` | Context-file view, when the server exposes one |
| `POST` | `/api/letta/agents/:id/messages` | Send a message, get the turn back |

Creating a Letta agent goes through `POST /api/setup/deploy` with the Letta runtime selected. Editing memory, reconfiguring, and deleting Letta agents are not shipped.

```bash
# Examples
curl http://localhost:3000/api/harnesses
curl -X POST http://localhost:3000/api/harnesses/h_myagent/restart \
  -H "Content-Type: application/json" -d '{"mode":"quick"}'
curl http://localhost:3000/api/harnesses/h_myagent/logs?lines=50
```

---

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Default | Description |
|---|---|---|
| `HERMES_DIR` | — | Path to your existing Hermes docker-compose files |
| `DATA_DIR` | `~/.hermes-swarm-map` | Config, keys, audit logs, standalone compose files |
| `PORT` | `3000` | Port for the Swarm Map UI |
| `ALLOWED_DEV_ORIGINS` | — | Comma-separated hostnames for remote dev access |

Settings are stored at `~/.hermes-swarm-map/settings.json`. API keys are encrypted at rest with a machine-local key at `~/.hermes-swarm-map/.key`.

---

## Documentation

- [Getting Started](docs/getting-started.md) — deploy your first agent in 5 minutes
- [Runtimes](docs/runtimes.md) — Hermes vs Letta: what's shipped, what isn't, and the evidence
- [Migrating Existing Agents](docs/migrating.md) — upgrade path for existing Hermes users
- [Platform Setup](docs/platforms.md) — Signal, Telegram, Mattermost, Google Workspace guides
- [Image vs HSM Boundary](docs/architecture/image-vs-hsm-boundary.md) — what belongs in the Docker image vs HSM scaffolding
- [Roadmap](docs/ROADMAP.md) — what's shipped and what's next
- [Contributing](CONTRIBUTING.md) — development setup and PR process
- [Architecture](AGENTS.md) — service layer, patterns, and agentic development guide

---

## License

Swarm Map — Copyright (C) 2025-2026 Juniper Bevensee and contributors. See [NOTICE](NOTICE).

Licensed under [AGPL v3](LICENSE). You can use, modify, and deploy this software freely. If you modify it and expose it over a network (e.g., as a hosted service), you must make your modified source code available under the same license. Self-hosting for your own agents requires no source disclosure.
