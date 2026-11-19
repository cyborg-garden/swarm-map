# Image vs Swarm Map Boundary

A decision framework for contributors. When you build a new feature or fix, this doc tells you where it belongs. There are three places: the **Docker image** (hermes-agent-mt), **Swarm Map's baseline scaffolding** (this repo), or its **own artefact repo** (git-sourced, indexed in [cyborg-garden/artefact-registry](https://github.com/cyborg-garden/artefact-registry)).

Swarm Map was called HSM (Hermes Swarm Map). The name survives in code identifiers such as `HSM_URL` and `.hsm-base-package`.

## The Layers

### Docker Image (hermes-agent-mt)

The immutable runtime. Code lives at `/opt/hermes/`, installed via Dockerfile. Ships to everyone who pulls the image from GHCR.

- Changes require an image rebuild and a container recreate.
- Shared across all deployments: every Swarm Map install and anyone else pulling the image.
- Repository: [cyborg-garden/hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt), a public fork of NousResearch/hermes-agent. Default image: `ghcr.io/cyborg-garden/hermes-agent-mt:latest`.

### Swarm Map Scaffolding (this repo)

Per-deployment config, plugins, hooks, and skills installed into `/opt/data/` when an agent is created. They can be synced onto existing agents with `POST /api/harnesses/:id/artifacts/sync`, which only adds and never clobbers (see [Agent Updates](agent-updates.md)).

- Changes take effect on the next agent create or duplicate, or through the sync endpoint for existing agents.
- Deployment-specific: each Swarm Map install can have different defaults.
- Two creation paths: the setup wizard (`app/api/setup/deploy/route.ts`) and the harness service (`lib/services/harness.ts`). Both write `config.yaml` from `lib/templates/config-yaml.ts` and install the base package from `infra/artifacts.json`.

### Artefact Repo (git-sourced capability)

A self-contained capability (a plugin and a paired skill that do one job) living in **its own repo**, fetched by pinned `git:<org>/<repo>#<tag>[:<subdir>]`, trust-gate-scanned, and installed **opt-in** (per use-case template or per-harness attach). It is *not* baked into the image and *not* a baseline template enabled for every agent.

- Distributed through the commons pipeline. It is never vendored into Swarm Map. Indexed in [cyborg-garden/artefact-registry](https://github.com/cyborg-garden/artefact-registry) (`type` + `ring` + pinned `hsm.template` git-source).
- Its config travels *with it* as declared `requires_env`. It must not add a typed field to Swarm Map's core `Settings` type.
- Examples today: use-case templates (built from `usecase-package-template`), `hermes-browser-login`, `osint-engine`. See [use-case packages](../patterns/use-case-packages.md) and [git-sourced artifacts](../runbooks/git-sourced-artifacts.md).

The difference between this and baseline scaffolding is the axis most people miss. The Decision Framework below covers image vs Swarm Map. The **"baseline vs artefact repo"** refinement follows it.

## Decision Framework

When deciding where a feature belongs, work through these questions in order. The first "yes" wins.

### 1. Is it a security boundary?

Approval system, path security, tirith policy, dangerous-command detection, URL safety.

**→ Image.** Security patterns must be immutable. They can't be optional, can't be overridden by config, and must ship to every deployment. If an operator can disable it by editing a config file, it's not a security boundary.

### 2. Does it depend on the deployment?

Needs `HSM_URL`, `HERMES_HOME_CHANNEL`, deployment-specific API keys, or knowledge of other agents in the fleet.

**→ Swarm Map.** The image doesn't know what deployment it's running in. Anything that needs deployment context belongs in Swarm Map scaffolding (plugins, hooks, env vars).

### 3. Is it core runtime?

Gateway, agent loop, CLI, tool implementations, platform adapters, session management.

**→ Image.** These are the engine. They must be consistent across deployments and tested as a unit.

### 4. Is it a safe default that operators might override?

Mention-gating, session reset timing, memory limits, model choices, compression settings.

**→ Both.** Set the safe default in image code (e.g., `TELEGRAM_REQUIRE_MENTION` defaults to `true` in the adapter). Expose the override in Swarm Map's `.env` or `config.yaml` generation so operators can change it per-agent.

### 5. Is it a behavioral template?

Agent persona, startup checklist, personality, operational instructions.

**→ Swarm Map.** `SOUL.md` and `BOOT.md` are per-agent. The image provides the machinery to read them. Swarm Map provides the content.

### 6. Is it a plugin that integrates with Swarm Map?

Multi-tenant policy, fleet-aware hooks, Swarm Map API consumers.

**→ Swarm Map.** Plugins like `swarm_map_policy` and `boot_md` need Swarm Map to function. They're installed as baseline templates, not baked into the image.

## Refine: a Swarm Map answer splits again into baseline or its own artefact repo

The framework above answers image vs Swarm Map. "→ Swarm Map" hides a second decision, and getting it wrong is the most common mistake. The standing decision: new capabilities go through the artefact pipeline and stay out of Swarm Map core. Once something is *not* image, ask:

### A. Is it a security boundary? (secret custody, enforcement an operator can't disable)

**→ Swarm Map core.** The broker, the trust gate, secret custody. It earns a place in the control plane (and its *unskippable* enforcement half may live in the image, per Decision #1). This is the one core primitive.

### B. Otherwise, is it a self-contained capability? (a plugin or skill that does a job)

**→ its own artefact repo**, through the commons pipeline: own repo + paired skill + `plugin.yaml` with `declared_capabilities`, pinned `git:<org>/<repo>#<tag>`, install-time trust gate, indexed in the [artefact-registry](https://github.com/cyborg-garden/artefact-registry). **Not** a `local:` baseline plugin, **not** `enabled: true` for every agent.

**The coupling smell (the diagnostic):** if shipping a capability forces a typed field onto the core `Settings` type or a branch in the settings/`.env` route, it's in the wrong layer. An artefact's config travels with it as declared `requires_env`, set through the generic attach mechanism. It never gets a per-feature code path in the security-sensitive route.

> `captcha_cascade` is still a `local:` plugin (in the `browser-ops` pack) but is classified `vanilla → "own repo"`. That is mid-migration debt. Don't copy it; new self-contained capabilities start as artefacts.

## Fork Maintenance Heuristic

cyborg-garden/hermes-agent-mt is a fork of NousResearch/hermes-agent. Every feature that goes into the fork but not upstream raises maintenance cost: merge conflicts on the upstream sync, divergent code paths, and features that break when upstream refactors.

**The test:** would this be useful to any Hermes user, or only to Swarm Map deployments?

- **Useful to everyone** → upstream it (PR to NousResearch/hermes-agent) or cherry-pick to the public fork
- **Swarm Map-specific** → keep it in Swarm Map scaffolding where possible (plugins, hooks, config). If it *must* be in the image (e.g., security fix), accept the fork cost
- **Experimental** → keep it in a private fork until validated, then decide

**Current fork divergence:**
- Public fork removes ~25 upstream tools (platform-specific integrations Swarm Map does not use)
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

### What Swarm Map Scaffolds

| Category | Items | Notes |
|----------|-------|-------|
| **Plugins (core)** | `swarm_map_policy` (multi-tenant access control), `person_memory` (per-sender adaptation), `credential_redactor` (scrubs secrets from inbound messages), `boot_md` (startup checklist, installed but off by default) | Listed in `infra/artifacts.json` |
| **Plugins (packs)** | `captcha_cascade` (`browser-ops` pack) | Opt-in, never on a public surface |
| **Hooks** | `lifecycle-notify` (startup notification to home channel) | Depends on HERMES_HOME_CHANNEL |
| **Skills (core)** | `session-handoff`, `garden-orientation` | Pack skills: `engineering-*`, `property-testing`, `captcha-escalation`, `garden-board` |
| **Config files** | `.env`, `config.yaml`, `SOUL.md`, `BOOT.md`, `docker-compose.yml` | Per-agent, generated at creation |
| **Security defaults** | `*_REQUIRE_MENTION=true` for each chat platform | Env vars that switch on image-level gates |
| **Docker hardening** | `cap_drop: ALL` plus a short `cap_add` list, 2G memory / 2 CPU / pid limits | Compose-level. No `read_only` root: s6 writes executables to `/run` |

### The Boundary in Practice

```
┌─────────────────────────────────────────────────────┐
│ Docker Image (hermes-agent-mt)                      │
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
│ Swarm Map Scaffolding                               │
│                                                     │
│  /opt/data/  (mounted volume)                       │
│  ├── .env                 ← deployment secrets       │
│  ├── config.yaml          ← model, compression, etc  │
│  ├── SOUL.md              ← agent personality         │
│  ├── BOOT.md              ← startup checklist         │
│  ├── plugins/             ← swarm_map_policy, ...   │
│  ├── hooks/               ← lifecycle-notify          │
│  ├── skills/              ← session-handoff, ...    │
│  └── memories/            ← persistent memory store   │
│                                                     │
│  Env overrides:                                     │
│  • TELEGRAM_REQUIRE_MENTION=false (if you want it)  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Examples

**"I fixed a bug in the approval system where denial messages don't include pattern info"**
→ Image. It's a security boundary fix. Cherry-pick to the public fork.

**"I want agents to send a startup message to their home channel"**
→ Swarm Map. Needs `HERMES_HOME_CHANNEL` (deployment context). Ship as a hook in `infra/templates/hooks/`.

**"I want to add admin-only gating to the /approve command"**
→ Image. The code that checks `admin_only` goes in `gateway/run.py`, and the default `admin_only: true` goes in `DEFAULT_CONFIG`. Swarm Map used to also write `HERMES_APPROVAL_ADMIN_ONLY=true` to `.env`; base package v1 dropped it because no runtime code reads it.

**"I built a plugin that queries Swarm Map for group membership"**
→ Swarm Map. It's a plugin that depends on `HSM_URL`. Install via `infra/templates/plugins/`.

**"Agents should default to mention-gating in group chats"**
→ Both. Safe default in adapter code (`true` when env var unset). Swarm Map exposes the toggle in `.env` and the UI.

**"I want agents to auto-solve CAPTCHAs during browser automation"**
→ Swarm Map. The browser tool already returns `bot_detection_warning` (image). CAPTCHA solving depends on deployment-specific services (Camofox URL, CapSolver API key). Ship it as a plugin (`captcha_cascade`) that registers a `captcha_solve` tool, and a skill that teaches the agent when to call it. No fork changes are needed: the image provides the detection, the plugin provides the resolution. (Under Refinement B, a capability like this would now start in its own artefact repo.)

**"I want to install a third-party / git-sourced artifact safely"**
→ Both: a two-layer trust gate. Swarm Map does the **early pre-install screen**: it fetches the artifact at a pinned tag and scans its content for prompt-injection / promptware *before* copying it into the agent, refusing to install on a finding (`lib/services/artifacts-manifest.ts` `installArtifacts` + `artifact-gate.ts`). The **image** does the **authoritative runtime enforcement** that can't be skipped: a plugin's declared tool capabilities are enforced at dispatch, and plugin-provided skill bodies are injection-scanned at load (`tools/threat_patterns.py`). Per Decision #1 the enforcement is a security boundary, so it lives in the image. Swarm Map's scan is a faster early gate and does not replace it. The TypeScript scanner (`lib/services/threat-patterns.ts`) is a port of the image's pattern library: **keep them in sync** when patterns change. See `../specs/2026-06-03-artifact-commons-design.md` (Phase 2 trust gate).

**"I built a plugin that does OSINT lookups / academic-citation checks / a domain skill. Where does it live?"**
→ Its **own artefact repo** (Refinement B). It's a self-contained capability with no secret-custody role, so it gets its own repo + paired skill + pinned `git:` source, is indexed in the [artefact-registry](https://github.com/cyborg-garden/artefact-registry), and installs opt-in via a use-case template or per-harness attach. Baking it into `infra/templates/` (enabled for everyone) would be the wrong layer. Examples: `osint-engine`, a use-case template package, `hermes-browser-login`.
