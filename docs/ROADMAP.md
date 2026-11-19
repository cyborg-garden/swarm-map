# Swarm Map roadmap

Swarm Map configures, deploys, watches and controls a fleet of agents for a team.
It began as a Hermes-only tool (older text calls it "HSM") and is becoming harness-agnostic.

- **V1** shipped: secure multi-tenant Hermes agents from a wizard.
- **V2** is operational insight: cost, health and alerts.
- **V3** is the harness-agnostic work: door agents, one agent record, sealed cells.

---

## V1: Secure multi-tenant agent management

**Done when:** any team member can create an agent through the wizard, and it comes up secure by default. Settings persist through restarts. Admin identity is unified.

V1 is complete. Items that were "should ship" moved to V2 on 2026-05-28.

### Done

- [x] Per-agent settings tab: DM policy, group invites, mention gating, command approval
- [x] Per-surface admins (Surfaces tab; an approved user is an admin)
- [x] Memory scope toggle, per channel or global (`HERMES_MEMORY_SCOPE`)
- [x] Settings API (`GET`/`PUT /api/harnesses/[id]/settings`)
- [x] Restart with rebuild when settings are saved, from both the Settings and Surfaces tabs
- [x] Connect and disconnect flows for Signal, Telegram and Mattermost
- [x] Discover existing groups (Signal, Mattermost)
- [x] Pairing store: see and revoke pairings
- [x] Model cascade with fallback providers (`fallback_providers` in `config.yaml`)
- [x] A generated compose file per agent, managed by Swarm Map
- [x] Five-step create wizard: identity, model, surfaces, keys, deploy
- [x] Container monitoring: CPU, memory, health, last seen
- [x] Policy enforcement through the `swarm_map_policy` plugin
- [x] User id resolution in the admin UI (Signal, Telegram and Mattermost resolvers)
- [x] Cascade suggestions from connected providers (model catalog and suggest endpoint)
- [x] Keys page: add, edit, delete and reassign keys, globally and per agent
- [x] Live cost and invocation counts on the agent list (read from each agent's `state.db`)
- [x] Budget tracking: a monthly budget per key, and a policy endpoint that reports spend against it. Agents are not throttled; see hard budget enforcement in V2.
- [x] signal-cli health check (JSON-RPC `POST /api/v1/rpc`, works in both daemon modes)
- [x] Container hardening, first pass: dropped capabilities and resource limits on every generated agent, and a read-only root filesystem on wizard-created agents. The rest is under [V3, sealed by default](#sealed-by-default).
- [x] Policy defaults on wizard deploy: memory scope, Swarm Map URL, agent name
- [x] Platform setup: admin fields, token validation, a SOUL template
- [x] Stop and Start on the agent page, with loading feedback on every action
- [x] **Full `config.yaml` on deploy.** Compression (threshold 0.50, target 0.20, protect the last 20), memory limits (5000 chars, 2000 user), session reset (both modes, 24h idle, 4am reset), speech-to-text (base model), `max_turns` 60. Template: `lib/templates/config-yaml.ts`.
- [x] **Compose fixes.** The volume mounts at `/opt/data`, and `command: gateway` is present.
- [x] **Settings round-trip.** A wildcard `*` is kept. `parseCommaList()` and `buildSettingsEnvValue()` stop silent data loss.
- [x] **Async restart.** `spawn()` in detached mode, with `restart-tracker.ts` (TTL 90 seconds for quick and recreate, 5 minutes for rebuild and purge; 409 on a second restart while one runs).
- [x] **Configurable default image.** `ghcr.io/cyborg-garden/hermes-agent-mt:latest` unless settings say otherwise.

### Moved to V2

- Cross-scope memory control already shipped in the Settings UI (per-channel or global, and admin `scope="global"` writes).
- The admin search hook (read-path enforcement) was deferred. With one admin per deployment, scoping writes was enough.
- Tier defaults, capability gating, per-person memory, audit logs, bulk user management and auto-approve on invite are tracked in V2.

---

### Capability gating

Controls what each agent can do, and who can make it do what.
It touches several systems, so it moved to V2.

**Idea:** every capability (tool, skill, plugin, env key) has a risk level. Habitat tiers set defaults. Admins adjust per agent. Non-admins get a smaller set.

#### 1. Risk levels

| Risk | Examples | Default |
|------|----------|---------|
| **safe** | web search, calculator, memory read | Everyone |
| **moderate** | file read, sandboxed code execution, API calls | Admins in public tiers, everyone in team or individual tiers |
| **dangerous** | shell, file write, credential access, self-improvement | Admins only, every tier |
| **critical** | `propose_improvement`, raw system commands, env changes | Admin plus explicit approval |

A risk level belongs to the capability, not to an agent's config. Swarm Map keeps the registry.

#### 2. Tier defaults

| Tier | safe | moderate | dangerous | critical |
|------|------|----------|-----------|----------|
| `individual` | all | all | all | admin |
| `team` | all | all | admin | admin+approval |
| `org` | all | admin | admin | disabled |
| `orgpublic` | all | restricted | disabled | disabled |
| `public` | curated | disabled | disabled | disabled |

These are starting points for a new agent at that tier. They are not enforced ceilings.

#### 3. Per-agent overrides

A "Capabilities" section on the Settings tab, where an admin can:
- see the agent's profile, as inherited from its tier
- turn single capabilities on or off
- see the difference from the tier ("3 added, 1 removed compared with team defaults")
- set each capability to admin-only or everyone

#### 4. Admin and non-admin

Each capability is either:
- **available to everyone** in an approved group, or
- **admin only.**

A non-admin who calls an admin-only tool gets a plain refusal ("This tool requires admin access").

#### 5. Binding capabilities from elsewhere

Capabilities can come from outside the agent:

- **Tools** from Hermes upstream, custom plugins and MCP servers
- **Skills** from skill directories, shared across agents
- **Plugins**, per agent or shared
- **Env keys**: API keys and service credentials bound to particular agents
- **MCP servers**, connected per agent

Swarm Map needs a capability library. A capability is registered once and then bound to the agents that should have it. That stops credentials spreading and shows which agent can reach what.

#### 6. Enforcement in Hermes

Swarm Map writes the allowed list into the agent's config. Hermes enforces it:
- each tool call is checked against the list before it runs
- admin-only tools check `source.is_admin` first
- a tool not on the list is refused

**Hermes dependency:** a `HERMES_ALLOWED_TOOLS` or `tools.allowed` setting the gateway enforces. Hermes has `enabled_toolsets`, which is coarser than per-tool control.

Door agents already work this way: tools are off until the rules turn one on, the door decides each call, and a tool set to `ask` needs an admin's yes in the room. See [the tools slice](lab/tools-slice.md).

---

## V2: Operational insight

**Done when:** an operator can see what agents are doing, how they perform, and where they need attention.

### Moved from V1

- [ ] **Tier defaults.** A `public` or `orgpublic` agent defaults to allowing all DMs; an `individual` one to approved users only. Suggested, not enforced.
- [ ] **Capability gating and binding.** See [Capability gating](#capability-gating).
- [ ] **Per-person memory.** The agent remembers each person within the right context, and is prompted so it knows who it is talking to and who is being mentioned.
- [ ] **Admin search hook.** Memory reads default to channel scope and need an explicit `--global` to cross channels. The backend (`context_id` scoping) is done; the gateway read path is not.
- [ ] **Audit log for every permission change.** Surface admin, cascade and tuning changes are logged today. Other settings changes are not.
- [ ] **Bulk user management.** Import and export admin lists as CSV or JSON.
- [ ] **Auto-approve on admin invite.** When an admin adds the bot to a group, allow the group. Telegram and Mattermost only; Signal sends no group-join event.

### Done

- [x] **Cost tracking.** Daily cost, tokens, sessions and tool calls per agent and per model, and fleet-wide, read from each agent's `state.db` (`/api/harnesses/:id/analytics`, `/api/fleet/analytics`).

### Planned

- [ ] **Hard budget enforcement for Hermes.** A `pre_message` hook in Hermes that blocks model calls when the budget is spent. This needs a new hook type in the gateway. Nothing calls the budget check today. (Door agents already refuse calls past their monthly cap.)
- [ ] **Budget cascade.** At a set threshold (say 80%), reorder the cascade to prefer cheaper models. Restore it when the new period starts.
- [ ] **Provider-reported spend.** Read spend from LiteLLM or the provider instead of estimating it from token counts.
- [ ] **Budget per agent, not per key.** A key's budget becomes the total across its uses.
- [ ] **Budget alerts** to an admin by Telegram or Slack.
- [ ] **Budget view** with spend over time per agent, trends and projections.
- [ ] **Conversation analytics.** Message volume, response times and tool use per agent.
- [ ] **Agent health beyond container metrics.** How often the cascade falls back, error rates, memory growth, skill use.
- [ ] **Fleet operations.** Bulk settings updates and fleet-wide model rotation. (Bulk restart exists: `POST /api/harnesses/restart-running`.)
- [ ] **Alerts** when a cascade is exhausted, memory nears its limit, errors spike or a container restarts.
- [ ] **Per-user session keys** in multi-tenant groups. A patch to the fork, alongside memory scoping.
- [ ] **Which model is live.** Show the model each agent is using, including per-session `/model` overrides.
- [ ] **Context-scoped skills.** Skills scoped per chat surface, like memory. An admin can promote one to global, so content does not leak at org tier.
- [ ] **Admin-only global skill writes.** Non-admins create context-local skills only.
- [ ] **Editable, enforced habitat tiers**, with per-tier tool defaults set from the UI.
- [ ] **Tool sharing between agents** through the capability library.
- [ ] **Plugin browser.** Install plugins from the UI. Today they are added by hand under `$HERMES_HOME/plugins/`.
- [ ] **Upstream RFC: a `memory:scope` hook.** Proposed to NousResearch so plugins can scope memory without patching core. If accepted, the fork needs no core patches.

---

## V3: Harness-agnostic Swarm Map

**Done when:** an agent on a second harness is created, configured and watched from the same dashboard as a Hermes agent, and every rule the UI shows is enforced by something.

The design is in [`lab/primitives.md`](lab/primitives.md).
Results per harness: [Pi](lab/pi-slice.md), [Pi in Discord](lab/pi-discord.md), [Letta Code](lab/letta-code.md), [Claude Agent SDK](lab/claude-sdk.md).
In the product: [the first door agent in the dashboard](lab/dashboard-slice.md).

### The door

A small guard process runs beside each agent. It owns chat in, chat out, model traffic, tool approvals and keys. The harness runs in a sealed cell and is never asked to enforce a rule.

- [x] Rule catalogue, and one conformance suite every harness must pass
- [x] Pi behind the door
- [x] Letta Code behind the door
- [x] Claude Agent SDK behind the door (test rig only)
- [x] Door agents created, started, stopped and edited from the dashboard (Pi and Letta Code)
- [x] Tools in the cell, off by default, with an admin's yes in the room for `ask`
- [x] Web reading and search through the door, by allowlist or the open web
- [x] Persona, and per-room notes that survive a restart
- [x] One agent in several Discord channels, with per-channel rules
- [ ] Claude Agent SDK in the dashboard
- [ ] Swarm Map runs the door's supervisor itself (today it shows a `pm2` command)
- [ ] Rules sent to each door over an authenticated per-agent channel (today they are written to files on the same host)
- [ ] Chat platforms other than Discord for door agents
- [ ] Hermes stays in native mode, with its rules rendered from the same record and each claim backed by a conformance test

### One agent record

Swarm Map owns a neutral record per agent: who it hears, who it answers, per-surface permissions, admins, keys, memory scope, resources. Each harness adapter renders the record into its own config and declares what it can honour.

- [ ] A typed agent record as the source of truth. Generated files are rendered from it, never patched. (Door agents already work this way.)
- [ ] One compose generator for every create path
- [ ] The harness adapter owns lifecycle, logs, health, usage and key injection
- [ ] Surface and key settings written through the adapter, not as harness-specific variables
- [ ] Each rule shown in one of three states: enforced by the harness, enforced by the door, or not enforced

### Sealed by default

- [ ] Every new agent gets the lab cell's defaults: non-root, read-only filesystem, no added privileges, process and memory limits
- [ ] Outbound network closed by default and opened per agent
- [ ] Keys held outside the agent; the agent sees short-lived or placeholder credentials
- [ ] Each agent has its own identity when it calls the Swarm Map API
- [ ] The dashboard listens on loopback by default, with a documented path to remote access
- [ ] Named operators instead of one shared token, so the audit log records who

### Substrate

Agents ship as OCI images, and that stays. What runs the image becomes a choice.

- [ ] A substrate interface under the Docker service: create, start, stop, exec, logs, stats
- [ ] A VM per agent on macOS
- [ ] WebAssembly is not planned for whole agents, which need a shell and subprocesses. It may suit small shared plugins later.

### Dashboard

- [ ] A "Needs you" view: broken agents, stale builds, pending updates and budget alerts in one place, worst first
- [ ] The harness shown on every agent, with only the tabs and controls that harness supports (door agents already get their own tab set)
- [ ] One place to set who an agent hears and answers
- [ ] Restarts report whether the agent came back, not only that the request was accepted
- [ ] A shorter agent page, with advanced settings out of the way
- [ ] Harness-neutral wording throughout

---

## What Swarm Map needs from the Hermes fork

Swarm Map configures; Hermes enforces. These items need changes in [hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt) first.

| Swarm Map feature | Hermes dependency | Status |
|-------------|-------------------|--------|
| Memory scope toggle | `HERMES_MEMORY_SCOPE` in the gateway | Done |
| Admin identity | `is_platform_admin()` via `swarm_map_policy` | Done |
| Admin search hook | Channel scoping on the memory tool's read path | To do |
| Cross-scope memory | `MEMORY_CROSS_SCOPE_ADMIN` | To do |
| Per-user session keys | Per-user session keys in the gateway | To do |
| Context-scoped skills | `context_id` passed through `skills_tool.py` and `skill_manager_tool.py` | To do |
| Capability gating | Per-tool allow and deny, and admin-only enforcement, in the gateway | To do |
| Capability binding | A config format for bound tools, skills, plugins and env keys | To do |

---

## Hermes trust model and known limits

**Kept apart per chat surface (context):**
- Memory entries, stored in `memories/contexts/{context_id}/` and not visible to other groups
- The system prompt snapshot, which merges global memory (admin-controlled) and the context's own memory (user-controlled)

**Shared across every chat surface of one agent:**
- Skills. One made in any context can be used from all of them. At team tier, skills are a commons.
- Files. The agent reads and writes one home directory, whichever group triggered it.
- Tool definitions.
- The model cascade and the rest of `config.yaml`.

**What this means for operators:**
- An agent in several groups shares its skills between them. A skill made in group A can be used in group B.
- Memory isolation stops conversation context leaking. Skills are named, explicit artifacts, and are shared on purpose.
- At team tier that is useful: skills build up across every conversation. At org or public tier, strict separation needs context-scoped skills (V2).
- Files the agent creates (downloads, outputs) are not scoped per context.

**Admin controls:**
- `scope="global"` memory writes need an admin. Non-admins write only to their own context.
- Skill creation is not gated. Any approved user can create a skill.

Door agents keep notes per room, and one room's notes never reach another. See [persona and memory](lab/persona-memory.md).

---

## Principles

1. **Native mode: Swarm Map configures, the harness enforces.** This is how Hermes agents work: Swarm Map writes env vars and config, and Hermes reads them. **Door mode: the door enforces.** A rule never depends on the harness honouring it (see V3).
2. **No permission matrix.** Flat per-surface admin lists, set through env vars. No cross-product of groups, tiers and tools.
3. **Tiers are labels.** They suggest defaults. They do not bind permissions.
4. **The wizard makes secure agents.** Every agent it creates gets baseline security with no manual config.
5. **Settings survive restarts.** Every toggle must round-trip through `GET`, the UI, `PUT` and a rebuild without losing data.
6. **Two sources of approved users.** Static (`.env`) and dynamic (the pairing store). The admin UI shows both.

---

## Plans

Plans for single features are in `docs/plans/`.

- [`home-channel-group-id.md`](plans/home-channel-group-id.md): resolve a Signal group's display name to its group id. Not built. The change is in hermes-agent-mt, not here.
