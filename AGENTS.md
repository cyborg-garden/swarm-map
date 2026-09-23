<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# Agent Guide — Swarm Map

## What It Is

Swarm Map (SM) — formerly Hermes Swarm Map — is an open-source admin GUI + REST API for orchestrating Hermes agent harnesses. Discover, create, configure, start/stop/restart, and audit Hermes agents running in Docker — including API keys, tool registries, model fallback chains, and memory scopes.

**The REST API is first-class.** Everything the GUI does, the API does. This means any AI agent (Claude Code, Hermes, custom scripts) can programmatically orchestrate the fleet — deploy new agents, restart harnesses, read logs, manage model cascades. See the API reference in README.md.

## Architecture

> **Where does this feature belong — in the Docker image or in HSM?** See [Image vs HSM Boundary](docs/architecture/image-vs-hsm-boundary.md) for the decision framework.

> **Touching templates, artifacts, or anything agents receive at create/update time?** Read these FIRST — there is prior design work and a hard constraint:
> - [Artifact Commons + Manifest Loader](docs/specs/2026-06-03-artifact-commons-design.md) — artifacts speak the manifest (`infra/artifacts.json`), never a hardcoded list
> - [Opinionated Config](docs/plans/opinionated-config.md) — what HSM scaffolds into `/opt/data` and why
> - [Agent Updates](docs/architecture/agent-updates.md) — the two update surfaces (baked image vs hot-mounted artifacts) and the rebuild/recreate/sync verbs
> - **The no-clobber rule:** an agent's data dir is user-owned once created. Baseline templates install at create/duplicate; existing agents are updated via `POST /api/harnesses/:id/artifacts/sync` (`lib/services/artifacts-sync.ts`). That endpoint — and anything like it — must never overwrite user-added or user-modified artifacts: it installs only what's missing, and updates an existing artifact only when a content-hash lock (`.artifacts-lock.json`) proves it's unmodified. Honor that model; don't regress it to a blind copy.

**Next.js fullstack monorepo.** API routes in `app/api/` shell out to Docker via the service layer. No separate backend process — Next.js IS the backend.

**Data at `~/.hermes-swarm-map/`** (configurable via `DATA_DIR`). Holds configs, encryption key, audit logs, and standalone compose files for new agents. Not in the repo.

**Agents discovered from Docker.** Scans running containers and compose files for Hermes markers. Existing compose files (e.g. `hermes-agent-mt/docker-compose.yml`) are read-only — never modified.

**New agents get standalone compose.** Created via wizard or API, each gets `~/.hermes-swarm-map/compose/{name}/docker-compose.yml`. This is the only compose file Swarm Map writes.

**Designed for headless operation.** Runs on a Mac Mini or Linux server, accessible over the network via `--hostname 0.0.0.0`. The smart dev script (`bin/dev.sh`) auto-detects free ports and kills zombie processes.

## Key Patterns

### Hermes Detection

A compose service is identified as a Hermes agent by matching **2+ markers**:
- `command: gateway` in service definition
- Volume mount to `/opt/data`
- `x-hermes` YAML anchors
- `HERMES_REPO_URL` environment variable
- `nousresearch/hermes-agent` image reference

This works for both Docker Hub images and locally-built agents.

### Swarm Map Port Convention

The Swarm Map UI runs on **port 3002** in production (pinned — `bin/dev.sh` refuses to auto-increment when `NODE_ENV=production`). In dev mode, it defaults to 3000 and auto-increments if occupied. The port is set via the `PORT` env var.

When agents are created, `SWARM_MAP_POLICY_URL=http://host.docker.internal:${PORT}` is injected into their `.env` so they can query their own harness config via the HSM API.

### Agent Port Allocation

Never hardcode agent ports. The deploy service queries Docker directly (`docker ps --format '{{.Ports}}'`) for all used ports, then picks the next available in the Hermes range (base 8642, step 10).

### Image Fallback

New agents try `nousresearch/hermes-agent:latest` from Docker Hub first. If pull fails (auth, network), falls back to a locally-built image (prefers one with `personal` in the name as the most generic base). Handled in the deploy route.

### Key Encryption

AES-256-GCM at rest. Machine-local key at `~/.hermes-swarm-map/.key` (0600 permissions, auto-generated on first use). Never expose raw key values in API responses or logs.

**Discovery keys** (from agent `.env` files) are read live on each API call — never stored by Swarm Map. **Manually-added keys** (via POST /api/keys) are encrypted before storage.

### Model Cascade

Each harness has an ordered chain, modelled the way hermes-agent consumes it:

- **Primary** = the `model:` section of the agent's `config.yaml` (`model.provider`, `model.default`, optional `model.base_url`). The runtime tries it first and returns to it each turn.
- **Fallbacks** = the `fallback_providers:` rows, in order. When the primary fails the runtime walks them one by one, skipping any row equal to the current `(provider, model)`.
- `model.fallback` is **not read** by the runtime; Swarm Map rewrites it only when a file already has the key, and never adds it.

Whether a file repeats its primary as `fallback_providers[0]` is a **per-file convention, not a drift** (the HSM editor used to write the duplicate; `hermes fallback` and hand edits do not — both shapes exist on the fleet). `readCascade()` reports it as `primaryDuplicatedAsRow0`; the writer preserves it (the duplicate row is kept in sync with `model.default` across rotations) and never invents or removes it. A no-op save is byte-identical on either shape.

The editor shows the **chain** (`GET /api/harnesses/:id/models` → `chain`): row 1 is the primary by construction and can be tracked like any other entry. Save with `PUT /api/harnesses/:id/models` `{ chain: [...], expected_chain: [...] }`; the pre-chain `{ fallback_providers: [...] }` body (row 0 = primary) and the string form `{ cascade: ["model-1", "model-2", ...] }` still work. Every write goes through `applyCascadeToHarness` (`lib/services/cascade-writer.ts`), which validates provider credentials before touching the file.

### Agent Data Directories

Each agent gets `~/.hermes-{name}/` containing:
- `.env` — environment variables (platform tokens, API keys)
- `config.yaml` — model cascade, provider config
- `SOUL.md` — agent persona/instructions
- `memories/` — agent memory files
- `skills/` — installed tools/skills (discovered by Swarm Map)

### Surfaces / Integrations

Platform connections (Mattermost, Telegram, Signal) are managed per-harness in the Surfaces tab of the harness detail page. Each platform has a setup dialog. Connection state is discovered from agent `.env` files (presence of `MATTERMOST_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SIGNAL_ACCOUNT`).

## Project Structure

```
swarm-map/
├── app/
│   ├── (dashboard)/          # Main app pages
│   │   ├── harnesses/        # Fleet list + per-harness detail (tabbed)
│   │   ├── keys/             # API key management (discovered + manual)
│   │   ├── tools/            # Tool registry (discovered from agent configs)
│   │   ├── memory/           # Memory scope browser
│   │   ├── audit/            # Append-only audit log
│   │   └── settings/         # App settings
│   ├── (setup)/              # Onboarding / wizard
│   │   └── setup/
│   │       ├── page.tsx      # Welcome screen (first-launch auto-detection)
│   │       └── wizard/       # 5-step agent creation wizard
│   ├── api/                  # REST API routes
│   │   ├── harnesses/        # CRUD + lifecycle + logs + models + duplicate
│   │   ├── keys/             # Key management
│   │   ├── tools/            # Tool registry
│   │   ├── setup/            # Deploy, detect, complete
│   │   └── ...               # audit, settings, memory-scopes, models, people
│   └── layout.tsx            # Root layout (fonts, theme)
├── lib/
│   ├── services/             # Core service layer (see below)
│   │   └── __tests__/        # Vitest tests
│   ├── hooks/                # React hooks (useApi)
│   ├── types.ts              # Shared TypeScript types
│   ├── constants.ts          # Tier colors, risk levels, sidebar items
│   └── seed.ts               # Dev seed data script
├── components/
│   ├── shared/               # TierBadge, StatusDot, RiskBar, SplitButton, etc.
│   ├── shell/                # Sidebar, Topbar
│   ├── wizard/               # StepIndicator
│   ├── surfaces/             # Platform setup dialogs
│   └── ui/                   # shadcn primitives
├── bin/
│   └── dev.sh                # Smart dev launcher (port detection, zombie cleanup)
└── handoff/                  # ARCHIVED — original design docs (see handoff/ARCHIVED.md)
```

## Service Layer

All business logic in `lib/services/`. API routes are thin wrappers.

| Service | File | Responsibility |
|---|---|---|
| `HarnessService` | `harness.ts` | Discovery from Docker, create/import/duplicate, lifecycle (start/stop/restart), overlay management |
| `DockerService` | `docker.ts` | CLI wrapper: compose ps, stats, restart, pull, health check |
| `KeysService` | `keys.ts` | Discover keys from .env files, encrypt manual keys, mask values |
| `ToolsService` | `tools.ts` | Discover tools from agent config.yaml + skills/ dirs |
| `MemoryService` | `memory.ts` | Read memory scope sizes from agent data dirs |
| `AuditService` | `audit.ts` | Append-only JSONL log, filtered queries |
| `ConfigService` | `config.ts` | App settings, model/people/surfaces config |
| `Encryption` | `encryption.ts` | AES-256-GCM encrypt/decrypt, key file management |
| `Storage` | `storage.ts` | JSON/JSONL file I/O for `~/.hermes-swarm-map/` |

## Agentic Use (Claude Code, Hermes, etc.)

The API is designed for programmatic access. An AI agent can:

```bash
# Check fleet status
curl http://host:3002/api/harnesses

# Quick-restart an agent
curl -X POST http://host:3002/api/harnesses/h_personal/restart \
  -H "Content-Type: application/json" -d '{"mode":"quick"}'

# Deploy a new agent
curl -X POST http://host:3002/api/setup/deploy \
  -H "Content-Type: application/json" \
  -d '{"name":"researcher","provider":"anthropic","primaryModel":"claude-sonnet-4-6","llmKey":"sk-ant-..."}'

# Read logs
curl http://host:3002/api/harnesses/h_personal/logs?lines=50

# Update model cascade
curl -X PUT http://host:3002/api/harnesses/h_personal/models \
  -H "Content-Type: application/json" \
  -d '{"cascade":["claude-sonnet-4-6","claude-haiku-4-5","qwen3:8b"]}'
```

No auth required (v1 is localhost-bound). Future versions will add API tokens for remote access.

## Running Locally

```bash
pnpm install
pnpm seed        # first run only — writes settings + tier overlays
pnpm dev         # starts at http://localhost:3000 (or next free port)
```

## Running on Remote (Mac Mini)

```bash
pnpm build
npx next start --port 3002 --hostname 0.0.0.0
```

Access from any machine on the LAN at `http://<hostname>:3002`.

## Testing

```bash
pnpm vitest run   # 176 tests across 21 files
```

All 176 tests must pass before committing. Tests mock Docker and filesystem — no real containers needed.

## What NOT To Do

- **Never modify shared compose files** — `hermes-agent-mt/docker-compose.yml` and similar are read-only. Swarm Map only writes to `~/.hermes-swarm-map/compose/{name}/`.
- **Never expose raw key values** — API responses return masked values only. `Encryption` handles all at-rest secrets.
- **Never hardcode ports** — always use the port scanning logic. Hardcoded ports cause conflicts.
- **Never write directly to `~/.hermes-{name}/`** — go through the service layer. Direct writes bypass encryption and audit.
- **Never skip tests** — run `pnpm vitest run` before every commit.
