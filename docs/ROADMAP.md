# Swarm Map — Roadmap

HSM is the management plane for multi-tenant Hermes. It configures, deploys, monitors, and controls agent harnesses. This roadmap works backward from what V1 must ship, then forward to V2.

---

## V1: Secure Multi-Tenant Agent Management

**Ship when:** Any team member can create an agent through the wizard and it comes up secure-by-default. Settings persist through restarts. Admin identity is unified.

### Done

- [x] Per-harness settings tab (DM policy, group invite, mention-gating, command approval)
- [x] Per-surface admin management (Surfaces tab, unified identity: approved = admin)
- [x] Memory scope toggle (channel/global per harness, `HERMES_MEMORY_SCOPE` env var)
- [x] Settings API (GET/PUT `/api/harnesses/[id]/settings`)
- [x] Auto-restart with rebuild on settings save (both Settings tab and Surfaces)
- [x] Signal/Telegram/Mattermost surface connect/disconnect flows
- [x] Discover existing groups (Signal, Mattermost)
- [x] Pairing store visibility + revocation
- [x] Model cascade with fallback providers (`config.yaml` fallback_providers)
- [x] Standalone compose per harness (generated, managed by HSM)
- [x] 5-step create wizard (Identity → Model → Surfaces → Keys → Deploy)
- [x] Container monitoring (CPU, memory, health, last seen)
- [x] Policy enforcement via swarm_map_policy plugin
- [x] UUID resolution in admin UI (Signal/Telegram/Mattermost resolvers + sidecar store)
- [x] Cascade derives from connected providers (model catalog + suggest endpoint + UI)
- [x] Model name discovery (integrated into cascade suggest)
- [x] Keys management UI (add/edit/delete/reassign from main keys page + per-harness)
- [x] Live cost/invocations on harnesses list (queries state.db per poll)
- [x] Budget enforcement (soft) — pre_llm_call hook via policy endpoint, 80%/100% thresholds
- [x] Signal-cli health check (JSON-RPC POST to `/api/v1/rpc`, works in both daemon modes)
- [x] Container hardening defaults (cap_drop, no-new-privileges, read_only)
- [x] Sane policy defaults on wizard deploy (memory scope, HSM URL, agent name)
- [x] Platform setup improvements (admin fields, token validation, SOUL template)
- [x] Stop/Start button on harness detail page + loading feedback on all actions

### Must Ship

- [x] **Wizard sane-config enforcement** — deploy generates full config.yaml: compression (threshold 0.50, target 0.20, protect last 20), memory limits (2200 char, 1375 user), session_reset (both mode, 24h idle, 4am reset), STT (base model), max_turns (60). Template in `lib/templates/config-yaml.ts`.
- [x] **Compose bugs** — volume mount is `/opt/data`, `command: gateway` present in generateStandaloneCompose().
- [x] **Settings round-trip integrity** — wildcard `*` explicitly tracked and preserved. `parseCommaList()` + `buildSettingsEnvValue()` prevent silent data loss.
- [x] **Async restart** — `spawn()` with detached mode + `restart-tracker.ts` (5-min TTL, 409 on concurrent restarts). No spawnSync.
- [x] **Configurable default image** — defaults to `ghcr.io/cyborg-garden/hermes-agent-mt:latest`, configurable via settings.

### Shipped to V2

All "Should Ship" items deferred to V2 (2026-05-28). V1 scope is complete.

- Cross-scope memory control already shipped via Settings UI (per-channel/global toggle, admin `scope="global"`)
- Admin search hook (read-path enforcement) deferred — single-admin reality means write-side scoping is sufficient
- Tier-based defaults, capability gating, per-context people memory, audit logs, bulk user management, auto-approve on invite → all tracked in V2 below

---

### Capability Gating

This is the big one — controls what each agent can do and who can trigger what. It's a "should ship V1, could slip to V2" item because the concept is right but the implementation touches multiple systems.

**Core idea:** Every capability (tool, skill, plugin, env key) has a risk level. Habitat tiers set defaults. Admins customize per-harness. Non-admins get a restricted subset.

#### 1. Risk Classification

Every capability gets a risk level:

| Risk | Examples | Default |
|------|----------|---------|
| **safe** | web search, calculator, memory read | Everyone |
| **moderate** | file read, code execution (sandboxed), API calls | Admin in public tiers, everyone in team/individual |
| **dangerous** | shell access, file write, credential access, self-improvement | Admin only, all tiers |
| **critical** | propose_improvement, raw system commands, env modification | Admin + explicit approval |

Risk levels are properties of the capabilities themselves, not per-harness config. HSM maintains a registry.

#### 2. Tier Defaults

Each habitat tier gets a default capability profile:

| Tier | safe | moderate | dangerous | critical |
|------|------|----------|-----------|----------|
| `individual` | all | all | all | admin |
| `team` | all | all | admin | admin+approval |
| `org` | all | admin | admin | disabled |
| `orgpublic` | all | restricted | disabled | disabled |
| `public` | curated | disabled | disabled | disabled |

These are **defaults** — the starting point when an agent is created at a given tier. Not enforced ceilings.

#### 3. Per-Harness Override

Settings tab gets a "Capabilities" section where admins can:
- See current capability profile (inherited from tier)
- Toggle individual capabilities on/off
- See diff from tier baseline ("3 capabilities added, 1 removed vs team defaults")
- Set admin-only vs everyone for each capability

#### 4. Admin vs Non-Admin Gating

Two-level access per capability:
- **Available to everyone** — any user in an approved group can trigger it
- **Admin only** — only admins can trigger it

Non-admins trying to use an admin-gated tool get a clear rejection ("This tool requires admin access").

#### 5. Capability Binding (Import/Share)

Capabilities aren't just built-in — they can be bound to harnesses from external sources:

- **Tools** — from Hermes upstream, custom plugins, MCP servers
- **Skills** — from skill directories, shared across harnesses
- **Plugins** — installed per-harness or shared
- **Env keys** — API keys, service credentials bound to specific harnesses
- **MCP servers** — external tool providers connected per-harness

HSM needs a "capability library" where capabilities are registered once, then bound to harnesses. When someone adds a new MCP server or API key, they import it to HSM, then assign it to the harnesses that should have it. This prevents credential sprawl and makes it clear which agents have access to what.

#### 6. Hermes Enforcement

HSM writes the allowed capability list to the agent's config. Hermes reads it and enforces:
- Tool calls checked against the allowed list before execution
- Admin-only tools check `source.is_admin` before proceeding
- Unrecognized tools rejected (whitelist, not blacklist)

**Hermes dependency:** Needs a `HERMES_ALLOWED_TOOLS` or `tools.allowed` config that the gateway reads and enforces. Currently Hermes has `enabled_toolsets` but it's coarser-grained than per-tool control.

---

## V2: Operational Intelligence

**Ship when:** HSM is not just config management but gives operators insight into what agents are doing, how they're performing, and where they need attention.

### Promoted from V1

- [ ] **Tier-based defaults** — when tier is `public`/`orgpublic`, default DM policy to allow-all; when `individual`, default to approved-only. Suggested, not enforced.
- [ ] **Capability gating & binding** — per-tool risk classification + admin-only enforcement. See [Capability Gating](#capability-gating) below.
- [ ] **Per-context people memory** — agent remembers things about each person, scoped to the right context. Includes clear prompting so the agent knows who it's talking to and who's being referenced.
- [ ] **Admin search hook** — memory reads default to channel scope, require explicit `--global` for cross-channel. Backend done (context_id scoping), needs gateway read-path enforcement.
- [ ] **Audit log for permission changes** — track who changed what, when. HSM already has audit service scaffolding.
- [ ] **Bulk user management** — import/export admin lists (CSV, JSON).
- [ ] **Auto-approve on admin invite** — when admin adds bot to group, auto-add to allowed groups. Telegram/Mattermost only (Signal lacks group-join events).

### Planned

- [ ] **Hard budget enforcement** — pre_message hook in Hermes to block LLM calls entirely when budget exceeded (requires new hook type in gateway). Currently soft-deny via context injection.
- [ ] **Budget cascade** — when budget hits configurable threshold (e.g., 80%), auto-reorder model cascade to prefer cheaper models. Restore original cascade when new budget period starts.
- [ ] **Per-harness budget (not per-key)** — move budget ownership from keys to harnesses for cleaner enforcement. Key-level budget becomes "total across all uses."
- [ ] **Budget alerts via notification** — Telegram/Slack notification to admin when budget thresholds hit.
- [ ] **Budget dashboard** — visual spend tracking over time per harness, with trend lines and projections.
- [ ] **Cost tracking** — per-harness, per-model token usage and cost. LiteLLM integration or direct provider API parsing. Daily/weekly/monthly views.
- [ ] **Conversation analytics** — message volume, response times, tool usage patterns per harness.
- [ ] **Agent health dashboard** — beyond container metrics. Track: cascade fallback frequency, error rates, memory usage growth, skill invocation patterns.
- [ ] **Multi-harness operations** — bulk restart, bulk settings update, fleet-wide model rotation.
- [ ] **Alerting** — configurable alerts for: cascade fully exhausted, memory approaching limits, unusual error spikes, container restarts.
- [ ] **Session key isolation** — per-user session keys in multi-tenant groups. Core fork patch for multi-tenancy (alongside memory scoping).
- [ ] **Session model override visibility** — HSM can see which model each harness is currently using (including per-session `/model` overrides).
- [ ] **Context-scoped skills** — skills scoped per chat surface (mirrors memory scoping). Admin can promote to global. Prevents content leakage at org tier.
- [ ] **Admin-only global skill writes** — non-admins can only create context-local skills.
- [ ] **Habitat tiers as editable/enforced system** — tiers become configurable from HSM UI with per-tier tool defaults.
- [ ] **Tool sharing between harnesses** — capability library where tools/skills/plugins are registered once and bound to multiple harnesses.
- [ ] **Plugin marketplace** — browse/install plugins from HSM UI. Currently manual (`$HERMES_HOME/plugins/`).
- [ ] **Upstream RFC: memory:scope hook** — propose to NousResearch so plugins can control memory scoping without patching core. If accepted, fork carries zero core patches.

---

## Dependencies on Hermes Fork (hermes-agent-mt)

HSM configures; Hermes enforces. These items need fork/upstream changes before HSM can expose them:

| HSM Feature | Hermes Dependency | Status |
|-------------|-------------------|--------|
| Memory scope toggle | `HERMES_MEMORY_SCOPE` env var in gateway | Done |
| Admin identity | `is_platform_admin()` via swarm_map_policy | Done |
| Admin search hook | Read-path channel scoping in memory tool | Todo |
| Cross-scope memory | `MEMORY_CROSS_SCOPE_ADMIN` env var | Todo |
| Session key isolation | Per-user session keys in gateway | Todo |
| Context-scoped skills | `context_id` threading in skills_tool.py + skill_manager_tool.py | Todo |
| Capability gating | Per-tool allow/deny + admin-only enforcement in gateway | Todo |
| Capability binding | Config format for bound tools/skills/plugins/env keys | Todo |

---

## V1 Trust Model & Known Boundaries

**What is isolated per chat surface (context):**
- Memory entries — stored in `memories/contexts/{context_id}/`, not visible to other groups
- System prompt snapshot merges global + context-specific memory (admin-controlled global, user-controlled context)

**What is shared across all chat surfaces for an agent:**
- Skills — created in any context, visible and usable from all contexts. Skills are a *commons* at team tier.
- File system access — agent reads/writes from a single home directory regardless of which group triggered it
- Tool definitions — platform-wide, not scoped per context
- Model cascade and configuration — single config.yaml per agent

**Implications for operators:**
- An agent deployed to multiple groups will share learned skills between them. Content created as a skill in Group A is accessible from Group B.
- Memory isolation prevents conversational context from leaking, but skills (which are explicit, named artifacts) are intentionally shared.
- For team-tier deployments this is a feature: skills accumulate across all interactions. For org/public tiers requiring strict separation, context-scoped skills (v2) are needed.
- File artifacts created by the agent (downloads, outputs) are not context-scoped in v1.

**Admin controls available:**
- `scope="global"` memory writes require admin — non-admins can only write to their own context
- No admin gating on skill creation in v1 — any approved user can create skills

---

## Architecture Principles

1. **HSM configures, Hermes enforces.** No enforcement logic in HSM. It writes env vars and config; Hermes reads them.
2. **No permission matrix.** Flat per-surface admin lists managed via env vars. No groups × tiers × tools cross-product.
3. **Tiers are labels.** They inform defaults but don't bind permissions programmatically.
4. **Wizard produces secure agents.** Every agent created through HSM gets baseline security without manual config.
5. **Settings survive restarts.** Every toggle must round-trip through GET→UI→PUT→rebuild without data loss.
6. **Two sources of approved users.** Static (`.env`) and dynamic (pairing store). Admin UI shows both.

---

## Implementation Plans (Reference)

Detailed plans for specific features live in `docs/plans/`:

| Plan | Status | Covers |
|------|--------|--------|
| `opinionated-config.md` | RFC — core template not yet implemented | Full config.yaml template, .env generation, compose bugs |
| `cost-tracker-litellm.md` | Plan — deferred to v1.1+ | Cost tracking from state.db, per-model breakdown |
| `home-channel-group-id.md` | Plan — needs hermes-agent-mt work | Signal group display name → group ID resolution |


---

## Archived

- `ROADMAP-surfaces.md` — surfaces/permissions roadmap, folded into this doc (all P0 items done, remaining items tracked above)
