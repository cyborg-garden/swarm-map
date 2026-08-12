# Image vs HSM Boundary

Decision framework for contributors: when you build a new feature or fix, this doc tells you where it belongs — the **Docker image** (hermes-agent), **HSM's baseline scaffolding** (hermes-swarm-map), or its **own artefact repo** (git-sourced, indexed in [cyborg-garden/artefact-registry](https://github.com/cyborg-garden/artefact-registry)).

## The Layers

### Docker Image (hermes-agent)

The immutable runtime. Code lives at `/opt/hermes/`, installed via Dockerfile. Ships to everyone who pulls from GHCR or Docker Hub.

- Changes require image rebuild + container restart
- Shared across all deployments — NimbleCo, upstream users, anyone pulling the image
- Repository: [NimbleCoAI/hermes-agent](https://github.com/NimbleCoAI/hermes-agent) (public fork of NousResearch/hermes-agent)

### HSM Scaffolding (hermes-swarm-map)

Per-deployment config, plugins, hooks, and skills installed into `/opt/data/` at agent creation time, and syncable onto already-created agents via `POST /api/harnesses/:id/artifacts/sync` (additive + no-clobber — see [Agent Updates](agent-updates.md)).

- Changes take effect on next agent create/duplicate, or via the artifacts-sync endpoint for existing agents
- Deployment-specific — each HSM instance can have different defaults
- Two creation paths: setup wizard (`app/api/setup/deploy/route.ts`) and harness service (`lib/services/harness.ts`)
- See also: [Opinionated Config Plan](../plans/opinionated-config.md) for implementation details of what HSM scaffolds

### Artefact Repo (git-sourced capability)

A self-contained capability — a plugin + paired skill that does one job — living in **its own repo**, fetched by pinned `git:<org>/<repo>#<tag>[:<subdir>]`, trust-gate-scanned, and installed **opt-in** (per use-case template or per-harness attach). It is *not* baked into the image and *not* a baseline template enabled for every agent.

- Distributed via the commons pipeline, not vendored into HSM. Indexed in [cyborg-garden/artefact-registry](https://github.com/cyborg-garden/artefact-registry) (`type` + `ring` + pinned `hsm.template` git-source).
- Its config travels *with it* as declared `requires_env` — it must not add a typed field to HSM's core `Settings` type.
- Examples today: `Matilde` (use-case template), `hermes-browser-login`, `osint-engine`. See [use-case packages](../patterns/use-case-packages.md) and [git-sourced artifacts](../runbooks/git-sourced-artifacts.md).

The distinction between *this* and "HSM baseline scaffolding" is the third axis most people miss — the Decision Framework below covers image-vs-HSM; the **"baseline vs artefact repo"** refinement follows it.

## Decision Framework

When deciding where a feature belongs, work through these questions in order. The first "yes" wins.

### 1. Is it a security boundary?

Approval system, path security, tirith policy, dangerous-command detection, URL safety.

**→ Image.** Security patterns must be immutable. They can't be optional, can't be overridden by config, and must ship to every deployment. If an operator can disable it by editing a config file, it's not a security boundary.

### 2. Does it depend on the deployment?

Needs `HSM_URL`, `HERMES_HOME_CHANNEL`, deployment-specific API keys, or knowledge of other agents in the fleet.

**→ HSM.** The image doesn't know what deployment it's running in. Anything that needs deployment context belongs in HSM scaffolding (plugins, hooks, env vars).

### 3. Is it core runtime?

Gateway, agent loop, CLI, tool implementations, platform adapters, session management.

**→ Image.** These are the engine. They must be consistent across deployments and tested as a unit.

### 4. Is it a safe default that operators might override?

Mention-gating, session reset timing, memory limits, model choices, compression settings.

**→ Both.** Set the safe default in image code (e.g., `TELEGRAM_REQUIRE_MENTION` defaults to `true` in the adapter). Expose the override in HSM's `.env` or `config.yaml` generation so operators can change it per-agent.

### 5. Is it a behavioral template?

Agent persona, startup checklist, personality, operational instructions.

**→ HSM.** `SOUL.md` and `BOOT.md` are per-agent. The image provides the machinery to read them; HSM provides the content.

### 6. Is it a plugin that integrates with HSM?

Multi-tenant policy, fleet-aware hooks, HSM API consumers.

**→ HSM.** Plugins like `swarm_map_policy` and `boot_md` need HSM to function. They're installed as baseline templates, not baked into the image.

## Refine: an "HSM" answer splits again — baseline vs its own artefact repo

The framework above answers image-vs-HSM. But "→ HSM" hides a second decision, and getting it wrong is the most common mistake (see [decision: capabilities go through the artefact pipeline](https://github.com/NimbleCoAI/nimbleco-memory) `knowledge/decisions/2026-06-22-artefact-vs-hsm-core-boundary.md`). Once something is *not* image, ask:

### A. Is it a security boundary? (secret custody, enforcement an operator can't disable)

**→ HSM core.** The broker, the trust gate, secret custody. It earns a place in the control plane (and its *unskippable* enforcement half may live in the image, per Decision #1). This is the one core primitive.

### B. Else — is it a self-contained capability? (a plugin/skill that does a job)

**→ its own artefact repo**, through the commons pipeline: own repo + paired skill + `plugin.yaml` with `declared_capabilities`, pinned `git:<org>/<repo>#<tag>`, install-time trust gate, indexed in the [artefact-registry](https://github.com/cyborg-garden/artefact-registry). **Not** a `local:` baseline plugin, **not** `enabled: true` for every agent.

**The coupling smell (the diagnostic):** if shipping a capability forces a typed field onto the core `Settings` type or a branch in the settings/`.env` route, it's in the wrong layer. An artefact's config travels with it as declared `requires_env`, set through the generic attach mechanism — never a per-feature code path in the security-sensitive route.

> `captcha_cascade` is a `local:` baseline today but is classified `vanilla → "own repo"` — mid-migration debt, not the target. Don't copy it; new self-contained capabilities start as artefacts.

## Fork Maintenance Heuristic

NimbleCoAI/hermes-agent is a fork of NousResearch/hermes-agent. Every feature that goes into the fork but not upstream increases maintenance cost — merge conflicts on the weekly upstream sync, divergent code paths, features that break when upstream refactors.

**The test:** Would this be useful to any Hermes user, or only NimbleCo deployments?

- **Useful to everyone** → upstream it (PR to NousResearch/hermes-agent) or cherry-pick to the public fork
- **NimbleCo-specific** → keep it in HSM scaffolding where possible (plugins, hooks, config). If it *must* be in the image (e.g., security fix), accept the fork cost
- **Experimental** → keep it in the private fork (hermes-swarm) until validated, then decide

**Current fork divergence:**
- Public fork removes ~25 upstream tools (platform-specific integrations not needed for NimbleCo)
- Public fork adds security fixes (admin-only approval gating, denial message improvements)
- Weekly upstream sync CI runs Mondays 6am UTC (`upstream-sync.yml`), auto-PRs clean rebases, opens issues on conflicts

## Current Inventory

### What's in the Image

| Category | Examples | Notes |
|----------|----------|-------|
| **Core runtime** | `hermes_cli/`, `agent/`, `gateway/`, `cron/`, `plugins/` | The engine |
| **Tools** | `approval.py`, `browser_tool.py`, `mcp_tool.py`, `terminal_tool.py`, ~80 total | Baked in, available to all agents |
| **Security** | `approval.py`, `tirith_security.py`, `path_security.py`, `url_safety.py` | Immutable security boundaries |
| **Built-in skills** | `skills/` (~90 across 25 categories) | Reference implementations, bundled |
| **System deps** | Python 3.13, Node.js, ripgrep, ffmpeg, Playwright | Runtime prerequisites |
| **Platform adapters** | Signal, Telegram, Mattermost, Slack, Discord, Matrix, DingTalk | Gateway adapters for each platform |
| **Safe defaults in code** | `REQUIRE_MENTION` defaults to `true`, `admin_only` defaults to `true` | Override via env vars |

### What HSM Scaffolds

| Category | Items | Notes |
|----------|-------|-------|
| **Plugins** | `swarm_map_policy` (multi-tenant access control), `boot_md` (startup checklist) | Depend on HSM_URL |
| **Hooks** | `lifecycle-notify` (startup notification to home channel) | Depends on HERMES_HOME_CHANNEL |
| **Skills** | `ocr-and-documents` (PDF/image text extraction) | Uses pymupdf from image |
| **Config files** | `.env`, `config.yaml`, `SOUL.md`, `BOOT.md`, `docker-compose.yml` | Per-agent, generated at creation |
| **Security defaults** | `HERMES_DM_POLICY=approved-only`, `HERMES_APPROVAL_ADMIN_ONLY=true`, `*_REQUIRE_MENTION=true` | Env vars that activate image-level features |
| **Docker hardening** | `read_only: true`, `cap_drop: ALL`, user 10000:10000, 2GB/2CPU limits | Compose-level security |

### The Boundary in Practice

```
┌─────────────────────────────────────────────────────┐
│ Docker Image (hermes-agent)                         │
│                                                     │
│  /opt/hermes/                                       │
│  ├── tools/approval.py    ← security boundary       │
│  ├── gateway/             ← platform adapters        │
│  ├── agent/               ← agent loop               │
│  └── skills/              ← bundled reference skills  │
│                                                     │
│  Code defaults:                                     │
│  • REQUIRE_MENTION = true (if env var not set)      │
│  • admin_only = true (in DEFAULT_CONFIG)            │
│                                                     │
├─────────────────────────────────────────────────────┤
│ HSM Scaffolding (hermes-swarm-map)                  │
│                                                     │
│  /opt/data/  (mounted volume)                       │
│  ├── .env                 ← deployment secrets       │
│  ├── config.yaml          ← model, compression, etc  │
│  ├── SOUL.md              ← agent personality         │
│  ├── BOOT.md              ← startup checklist         │
│  ├── plugins/             ← swarm_map_policy, boot_md │
│  ├── hooks/               ← lifecycle-notify          │
│  ├── skills/              ← ocr-and-documents         │
│  └── memories/            ← persistent memory store   │
│                                                     │
│  Env overrides:                                     │
│  • TELEGRAM_REQUIRE_MENTION=false (if you want it)  │
│  • HERMES_APPROVAL_ADMIN_ONLY=false (backwards compat)│
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Examples

**"I fixed a bug in the approval system where denial messages don't include pattern info"**
→ Image. It's a security boundary fix. Cherry-pick to the public fork.

**"I want agents to send a startup message to their home channel"**
→ HSM. Needs `HERMES_HOME_CHANNEL` (deployment context). Ship as a hook in `infra/templates/hooks/`.

**"I want to add admin-only gating to the /approve command"**
→ Image (the check) + HSM (the config). The code that checks `admin_only` goes in `gateway/run.py` (image). The default `admin_only: true` goes in `DEFAULT_CONFIG` (image). HSM sets `HERMES_APPROVAL_ADMIN_ONLY=true` in `.env` as belt-and-suspenders.

**"I built a plugin that queries HSM for group membership"**
→ HSM. It's a plugin that depends on `HSM_URL`. Install via `infra/templates/plugins/`.

**"Agents should default to mention-gating in group chats"**
→ Both. Safe default in adapter code (`true` when env var unset). HSM exposes the toggle in `.env` and the UI.

**"I want agents to auto-solve CAPTCHAs during browser automation"**
→ HSM. The browser tool already returns `bot_detection_warning` (image). CAPTCHA solving depends on deployment-specific services (Camofox URL, CapSolver API key). Ship as a plugin (`captcha_cascade`) that registers a `captcha_solve` tool. The agent's skill teaches it when to call the tool. No fork changes needed — the image provides the detection, the plugin provides the resolution.

**"I want to install a third-party / git-sourced artifact safely"**
→ Both — a two-layer trust gate. HSM does the **early pre-install screen**: it fetches the artifact at a pinned tag and scans its content for prompt-injection / promptware *before* copying it into the agent, refusing to install on a finding (`lib/services/artifacts-manifest.ts` `installArtifacts` + `artifact-gate.ts`). The **image** does the **authoritative runtime enforcement** that can't be skipped: a plugin's declared tool capabilities are enforced at dispatch, and plugin-provided skill bodies are injection-scanned at load (`tools/threat_patterns.py`). Per Decision #1 the enforcement is a security boundary → image; HSM's scan is a faster early gate, not a substitute. The HSM-side TS scanner is a port of the image's pattern library — **keep them in sync** when patterns change. See `../specs/2026-06-03-artifact-commons-design.md` (Phase 2 trust gate).

**"I built a plugin that does OSINT lookups / academic-citation checks / a domain skill — where does it live?"**
→ Its **own artefact repo** (Refinement B), not an HSM baseline. It's a self-contained capability with no secret-custody role, so it gets its own repo + paired skill + pinned `git:` source, is indexed in the [artefact-registry](https://github.com/cyborg-garden/artefact-registry), and installs opt-in via a use-case template or per-harness attach. Baking it into `infra/templates/` (enabled for everyone) would be the wrong layer. Examples: `osint-engine`, `Matilde`, `hermes-browser-login`.
