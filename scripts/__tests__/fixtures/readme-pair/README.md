# Swarm Map

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

> **Swarm Map (SM)** — formerly Hermes Swarm Map / HSM.

A commons, public goods project of [Cyborg Garden](https://www.cyborg.garden/). 

**Multiplayer admin and orchestrator platform for heterogeneous agent runtimes.** One dashboard for a fleet of [Hermes](https://github.com/cyborg-garden/hermes-agent-mt) agents, each in its own container. Multi-tenant security, model cascades, and platform connections come from one control plane.

*First of its kind, a point and click GUI for not just managing agent runtimes, but also who can do what and where. Solves the multi-tenant agent problem. View the godhead of complexity without derealizing. Share compute.*

**One runtime ships today.** Hermes is the supported path. The earlier Letta integration was removed: it targeted Letta's self-hosted server, which Letta has retired. See [Runtimes](docs/runtimes.md) for what ships, what was removed, and what is planned. We would rather you read a boring page than discover the gap after deploying.

<img width="1352" height="763" alt="Screenshot 2026-05-26 at 5 01 19 pm" src="https://github.com/user-attachments/assets/4b94f0d1-d9b8-4a81-8b47-b2dae1940741" />
*Calm UX showing a variety of config settings across agent harness runtimes*

---

## Why Swarm Map?

AI agents are most useful when they're always on — running on a server, reachable from your phone, remembering context across conversations. But running *multiple* agents across *multiple* platforms for *multiple* users? That's where it gets hard.

Swarm Map is the control plane. One UI to deploy, configure, and manage a fleet of agents — each with its own personality, memory, platform connections, and budget. Everything a single agent can do, but multiplied and multiplayer.

It also gets harder when your agents don't all run on the same harness, because every harness handles chat access, keys and memory in its own way. Today Swarm Map drives Hermes through one runtime seam (`ContainerRuntimeAdapter`). An agent row stored under a runtime Swarm Map does not know is never treated as Hermes.

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

🧩 **One Runtime Seam** — Hermes (container-per-agent) is the supported runtime. More harnesses are planned behind the same rules; [Runtimes](docs/runtimes.md) has the current state.

---

## Runtimes

Swarm Map drives one agent runtime today.

| | **Hermes** |
|---|---|
| Agent is | a container |
| Deploy from the wizard | yes |
| Start / stop / restart / rebuild | yes |
| Messaging surfaces (Signal / Telegram / Mattermost / Discord) | yes, direct |
| Group approval + audit | yes |
| Budget enforcement | yes |

The old Letta integration (a client for Letta's retired self-hosted server, and a Hermes front that proxied to it) was removed. A stored row tagged with a retired or unknown runtime is listed separately, is never treated as Hermes, and can only be forgotten.

What ships, what was removed, and what is planned: [docs/runtimes.md](docs/runtimes.md).

---

## Quick Start

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed         # first run: writes settings + tier config
pnpm dev          # http://localhost:3000
```

On first launch, the setup wizard detects your Hermes compose directories automatically. Point it at your agent directory and go.

**New here?** Read the [Getting Started guide](docs/getting-started.md) for a full walkthrough.

### Requirements

- **Node.js 18+**
- **Docker** running locally — Docker Desktop or OrbStack, used for container management (Swarm Map drives whichever `docker` CLI is on your PATH)
- **Hermes Agent** instances — Swarm Map deploys the multi-tenant fork [cyborg-garden/hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt), a fork of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

---

## Features

- **Discovery** — auto-detect Hermes agent containers and compose files
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
| `GET` | `/api/harnesses/retired` | Stored rows under a retired or unknown runtime (not managed; `DELETE /api/harnesses/:id` forgets one) |
| `POST` | `/api/harnesses/:id/restart` | Restart (`{ mode: 'quick'\|'rebuild'\|'purge' }`) |
| `POST` | `/api/harnesses/:id/stop` | Stop |
| `POST` | `/api/harnesses/:id/start` | Start |
| `POST` | `/api/harnesses/restart-running` | Bulk quick-restart all running |
| `GET` | `/api/harnesses/:id/logs` | Container logs (`?lines=100`) |
| `GET` | `/api/harnesses/:id/models` | Model cascade: `chain` (primary from `model:` first, then the `fallback_providers` rows), `primaryEntry`, `primaryDuplicatedAsRow0`, raw `fallbackProviders` |
| `PUT` | `/api/harnesses/:id/models` | Update the cascade (`{ chain: [...], expected_chain?: [...] }`, `chain[0]` = primary; `{ cascade: [...] }` still accepted; `{ fallback_providers: [...] }` rewrites the fallback rows only and never touches the primary — 409 on a file with no primary) |
| `POST` | `/api/harnesses/:id/duplicate` | Clone harness config (`{ name }`) |
| `POST` | `/api/harnesses/:id/cascade/save-as` | Snapshot the harness's current chain (primary + fallbacks) into the cascade library (`{ name, overwrite? }`) |
| `GET` | `/api/cascades` | Named cascade library (saved, portable chains: `chain[0]` is the primary) |
| `POST` | `/api/cascades` | Save a cascade (`{ name, chain, sourceHarness?, overwrite? }`; `entries` accepted as an alias; existing name → 409 unless `overwrite`) |
| `GET`/`PUT`/`DELETE` | `/api/cascades/:name` | Read / rename+edit (`{ name?, chain? }`) / delete a cascade |
| `POST` | `/api/cascades/:name/apply` | Port a cascade onto a harness (`{ harnessId, restart? }`); refuses (400, no write, no restart) if the harness lacks a provider's key |
| `POST` | `/api/harnesses/:id/artifacts/sync` | Adopt/update the base package on an existing agent, add-only (`{ dryRun?, force?, surface?, packs?, assignKeys?, includeVision? }`) |
| `GET` | `/api/harnesses/:id/base-package/drift` | Report-only drift against the base package (fixes nothing) |
| `POST` | `/api/setup/deploy` | Deploy new agent (full wizard payload) |
| `POST` | `/api/setup/detect` | Scan for Hermes compose directories |
| `GET` | `/api/keys` | List keys (masked, from agent .env files) |
| `GET` | `/api/tools` | Tool registry (from agent configs) |
| `GET` | `/api/memory-scopes` | Memory scopes per agent |
| `GET` | `/api/audit` | Audit log (`?who=&what=&since=`) |
| `GET/PUT` | `/api/settings` | App settings |

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
- [Runtimes](docs/runtimes.md) — what ships today, what was removed, and what is planned
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
