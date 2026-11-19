# Swarm Map

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Swarm Map is a self-hosted dashboard for running a fleet of chat agents for a team.
You deploy agents, give them keys and models, connect them to chat rooms, and decide who each one listens to.
It is for people who run more than one agent for more than one person, and want the rules in one place.

It was called Hermes Swarm Map (HSM). Some file names and environment variables still use the old name.
It is a commons project of [Cyborg Garden](https://www.cyborg.garden/), licensed AGPL v3.

<img width="1352" height="763" alt="The Swarm Map dashboard showing agents and their settings" src="https://github.com/user-attachments/assets/4b94f0d1-d9b8-4a81-8b47-b2dae1940741" />

## Two kinds of agent

**Hermes containers.** The main path, in daily use.
Each agent is a Docker container running [hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt), a multi-tenant fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Swarm Map writes its config and Hermes enforces it.
Surfaces: Signal, Telegram, Mattermost, Discord and Slack.

**Door agents.** Newer, and lab-grade.
A guard process (the "door") runs outside the agent.
It holds the chat token, the model key, the rules, the receipts and the budget.
The agent runs in a sealed Docker cell with no token, no real key and no network route except the door.
The agent is never asked to enforce a rule, so a harness that ignores one changes nothing.

- **Harnesses.** Pi (the default), Letta Code and the Claude Agent SDK run the same harness-neutral conformance suite and pass every check they run. Some checks do not run for every harness; see `conformance/matrix/`. The dashboard creates Pi and Letta Code agents. The Claude Agent SDK runs from the test rig only.
- **Discord rooms.** One agent can sit in several channels. Each channel can have its own rules: who is heard, whether a mention is needed, which tools are allowed.
- **Approvals in the room (Pi only).** A tool set to `ask` posts the request in the channel. An admin replies approve or deny, or reacts. No answer in time means no.
- **Budget that stops.** A monthly cap per agent. When it is spent, model calls are refused.
- **What is not proven.** The cell's seal is tested on one machine and one Docker setup. Door agents run in Discord only. Swarm Map shows a `pm2` command to supervise a door; it does not supervise it itself yet.

Details: [Runtimes](docs/runtimes.md) and [the first door agent in the dashboard](docs/lab/dashboard-slice.md).

## Quick start

You need Node.js 20.9 or newer (22.18 or newer for door agents), pnpm, and Docker (Docker Desktop or OrbStack). Swarm Map uses whichever `docker` CLI is on your `PATH`.

```bash
git clone https://github.com/cyborg-garden/swarm-map.git
cd swarm-map
pnpm install
pnpm seed         # first run: writes settings and tier config
pnpm dev          # http://localhost:3000, or the next free port
```

On first start Swarm Map generates an operator token and writes it to `.env.local`.
Sign in at `/login` with that token.
The setup wizard then finds your Hermes compose directories, or deploys a new agent in five steps.

The [Getting Started guide](docs/getting-started.md) walks through a first agent.

## What it does

- **Setup wizard.** Five steps: identity, model, platforms, keys, deploy. New agents get default settings for compression, memory, session reset and voice transcription.
- **Model cascade.** An ordered list of models per agent. If one provider fails, the next is tried. Cascades can be saved and applied to other agents.
- **Who an agent hears.** Group approval, DM allowlists, per-surface admins, mention gating.
- **Memory scope.** Per-channel or global, per agent.
- **Fleet view.** Health, CPU, memory, cost and session counts. Start, stop, restart, rebuild or purge a container.
- **Keys.** Stored encrypted at rest (AES-256-GCM) with a key kept on the machine.
- **Budgets.** A monthly budget per key, shown against spend. Hermes agents are not throttled when it runs out. Door agents are.
- **Audit log.** Who changed what, and when.
- **Base package.** Plugins, skills and hooks installed into each agent, with a drift report and an add-only sync.

<img width="911" height="742" alt="An agent's detail page" src="https://github.com/user-attachments/assets/68a7f594-4e17-419a-8cb6-180b94cac40a" />

<img width="680" height="686" alt="Agent creation wizard" src="https://github.com/user-attachments/assets/62ff24dc-d266-4c18-9542-038ac1b09eaa" />

## Security model

Swarm Map assumes a small team that trusts each other.

- **One operator token.** Every write, and most reads, need a session from that token. If the token is unset, those requests are refused. There are no per-user roles: anyone signed in can manage every agent and key.
- **Agents reach a few routes without signing in.** They ask yes/no questions (is this person an admin, is this group allowed) and ask for approval when added to a group. Those answers carry no secrets.
- **Keys are encrypted at rest.** The audit log records changes.
- **Hermes agents enforce their own rules.** Like any LLM agent, they can be steered by text in messages or documents they read.
- **Door agents do not hold their secrets.** A prompt injection can still change what the agent says. It cannot make the agent post where the door does not allow, or use a tool the rules turn off.

Run Swarm Map on a private network, or behind a VPN or reverse proxy with HTTPS.

## Running on a server

```bash
pnpm build
npx next start --port 3000 --hostname 0.0.0.0
```

Then open `http://<host>:3000`.
For dev mode on a remote machine, list its hostname in `ALLOWED_DEV_ORIGINS`.

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | What it sets |
|---|---|---|
| `HERMES_DIR` | none | Directory of existing Hermes docker-compose files |
| `DATA_DIR` | `~/.hermes-swarm-map` | Settings, keys, audit log, generated compose files, door agents |
| `PORT` | `3000` | Port for the dashboard. `pnpm dev` moves to the next free port if it is taken. `.env.example` sets `3002`, the production convention |
| `HSM_OPERATOR_TOKEN` | generated into `.env.local` | The sign-in token. Server-side only |
| `ALLOWED_DEV_ORIGINS` | none | Comma-separated hostnames allowed to reach the dev server |
| `DISCORD_GUILD_IDS` | none | Your Discord server ids, so they are refused as bot role ids |
| `SWARM_MAP_NODE` | the Node Swarm Map runs on | Full path of the Node binary a door agent's start script uses |

The encryption key for stored API keys is at `<DATA_DIR>/.key`.

## API reference

Everything in the dashboard is also a REST call, so another agent can drive the fleet.
Calls need the `hsm_session` cookie from `POST /api/auth/login` with `{ "token": "..." }`.

| Method | Path | Does |
|--------|------|------|
| `GET` | `/api/harnesses` | List agents with live Docker or door state |
| `GET` | `/api/harnesses/:id` | One agent |
| `GET` | `/api/harnesses/retired` | Stored rows under a retired or unknown runtime. `DELETE /api/harnesses/:id` forgets one |
| `POST` | `/api/harnesses/:id/restart` | Restart (`{ mode: 'quick'\|'recreate'\|'rebuild'\|'purge' }`) |
| `POST` | `/api/harnesses/:id/stop` | Stop |
| `POST` | `/api/harnesses/:id/start` | Start |
| `POST` | `/api/harnesses/restart-running` | Quick-restart every running agent |
| `GET` | `/api/harnesses/:id/logs` | Logs (`?lines=100`) |
| `GET` | `/api/harnesses/:id/models` | Model cascade: `chain` (primary first, then the `fallback_providers` rows), `primaryEntry`, `primaryDuplicatedAsRow0`, raw `fallbackProviders` |
| `PUT` | `/api/harnesses/:id/models` | Update the cascade (`{ chain: [...], expected_chain?: [...] }`, `chain[0]` is the primary). `{ cascade: [...] }` is still accepted. `{ fallback_providers: [...] }` rewrites the fallback rows only and answers 409 on a file with no primary |
| `POST` | `/api/harnesses/:id/duplicate` | Copy an agent's config (`{ name }`) |
| `POST` | `/api/harnesses/:id/cascade/save-as` | Save the agent's chain to the cascade library (`{ name, overwrite? }`) |
| `GET` | `/api/cascades` | The cascade library |
| `POST` | `/api/cascades` | Save a cascade (`{ name, chain, sourceHarness?, overwrite? }`). An existing name answers 409 unless `overwrite` |
| `GET`/`PUT`/`DELETE` | `/api/cascades/:name` | Read, rename or edit (`{ name?, chain? }`), delete |
| `POST` | `/api/cascades/:name/apply` | Apply a cascade to an agent (`{ harnessId, restart? }`). Refuses with 400, and writes nothing, if the agent lacks a provider's key |
| `POST` | `/api/harnesses/:id/artifacts/sync` | Install or update the base package, add-only (`{ dryRun?, force?, surface?, packs?, assignKeys?, includeVision? }`) |
| `GET` | `/api/harnesses/:id/base-package/drift` | Report drift from the base package. Changes nothing |
| `POST` | `/api/harnesses/door` | Create a draft door agent (`{ name, runtime?, description? }`, `runtime` is `pi` or `letta-code`, default `pi`) |
| `GET` | `/api/harnesses/:id/door` | A door agent's rules, status, usage and supervisor command |
| `PUT` | `/api/harnesses/:id/door/rules` | Save a door agent's rules and apply them |
| `GET` | `/api/harnesses/:id/door/receipts` | A door agent's decision log, newest first |
| `POST` | `/api/setup/deploy` | Deploy a new Hermes agent (the full wizard payload) |
| `GET` | `/api/setup/detect` | Look for Hermes compose directories |
| `GET` | `/api/keys` | Keys, masked |
| `GET` | `/api/tools` | Tool registry |
| `GET` | `/api/memory-scopes` | Memory scope per agent |
| `GET` | `/api/audit` | Audit log (`?who=&what=&since=`) |
| `GET`/`PUT` | `/api/settings` | App settings |

```bash
curl -c jar -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" -d '{"token":"<operator token>"}'
curl -b jar http://localhost:3000/api/harnesses
curl -b jar -X POST http://localhost:3000/api/harnesses/h_myagent/restart \
  -H "Content-Type: application/json" -d '{"mode":"quick"}'
```

## Built with

Next.js 16 (App Router) and TypeScript, Tailwind CSS v4 with shadcn/ui, the Docker CLI, and Vitest.

<img width="1023" height="724" alt="Architecture diagram" src="https://github.com/user-attachments/assets/a2ad3118-81a2-433a-ae02-289546e7e02d" />

## Documentation

- [Getting Started](docs/getting-started.md): deploy a first agent
- [Runtimes](docs/runtimes.md): Hermes, door agents, and what was removed
- [Migrating Existing Agents](docs/migrating.md): bring existing Hermes agents under Swarm Map
- [Platform Setup](docs/platforms.md): Signal, Telegram, Mattermost, Discord, Slack, Google Workspace
- [Surface Permissions](docs/surface-permissions.md): who an agent hears on each platform
- [Image vs Swarm Map boundary](docs/architecture/image-vs-hsm-boundary.md): what belongs in the Docker image and what Swarm Map installs
- [Door agents in the lab](docs/lab/primitives.md): the design, and the [Pi](docs/lab/pi-slice.md), [Letta Code](docs/lab/letta-code.md) and [Claude Agent SDK](docs/lab/claude-sdk.md) results
- [Sanitization gate](docs/sanitization-gate.md): the check that keeps deployment details out of this repo
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Agent guide](AGENTS.md): the service layer and conventions, for coding agents and people

## License

Swarm Map — Copyright (C) 2025-2026 Juniper Bevensee and contributors. See [NOTICE](NOTICE).

Licensed under [AGPL v3](LICENSE). You can use, modify, and deploy this software freely. If you modify it and expose it over a network (e.g., as a hosted service), you must make your modified source code available under the same license. Self-hosting for your own agents requires no source disclosure.
