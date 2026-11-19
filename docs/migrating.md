# Migrating Existing Hermes Agents

Swarm Map can manage Hermes agents you already run.
It can also move them to the multi-tenant fork, [hermes-agent-mt](https://github.com/cyborg-garden/hermes-agent-mt), which keeps a separate memory per group or DM.

**Import never changes your data in place.** It copies the agent's data directory and applies Swarm Map's changes to the copy. Your original stays as a backup. If you don't like the result, point back at the original.

There are three levels, from least to most change. Import (below) does levels 2 and 3 in one step.

## Running Without Docker?

The wizard and Import deploy Docker containers.
If you run Hermes bare-metal (`hermes gateway` or a `pip install`), you have two paths:

1. **Stay bare-metal.** Add the level 2 env vars and plugins by hand. Install the fork with `pip install -e ".[all]"` from the [hermes-agent-mt repo](https://github.com/cyborg-garden/hermes-agent-mt). Memory scoping works the same either way.
2. **Move to Docker.** Import containerizes the agent with hardening. The data directory is mounted as a volume: the same files, now run by Docker.

## Level 1: Fleet Management (No Changes)

To see existing agents on the dashboard without changing them:

1. Install Swarm Map: `git clone ... && pnpm install && pnpm seed && pnpm dev`
2. Open `/setup`. It looks for folders holding Hermes compose files. Select yours.
3. Swarm Map lists the `hermes-*` containers defined in those compose files.

You get: the dashboard, logs, restart and rebuild, the model cascade view and cost tracking.

You don't get: group policy, admin checks, memory scoping or budget limits.

## Level 2: Swarm Map Integration (Plugins)

Add Swarm Map's plugins to an agent without changing its Docker image.

### What gets added

| Component | Purpose |
|-----------|---------|
| `HSM_URL` and `SWARM_MAP_POLICY_URL` env vars | Where the agent reaches Swarm Map for policy checks |
| `HERMES_AGENT_NAME` env var | The agent's name in Swarm Map |
| `swarm_map_policy` plugin | Admin resolution, admin-only approval tools, the public browser guard |
| `person_memory`, `credential_redactor` plugins | The other plugins every new agent gets |
| `lifecycle-notify` hook | Announces startup to the home channel |

The list of what every agent gets is [`infra/artifacts.json`](../infra/artifacts.json).

### Manual steps

Add to the agent's `.env`. Use Swarm Map's port (3000 unless you set `PORT`):

```bash
# Swarm Map integration
HSM_URL=http://host.docker.internal:3000
SWARM_MAP_POLICY_URL=http://host.docker.internal:3000
HERMES_AGENT_NAME=your-agent-name
```

Copy the plugins and hook from this repo into the agent's data directory:

```bash
cp -r infra/templates/plugins/swarm_map_policy ~/.hermes-your-agent/plugins/
cp -r infra/templates/plugins/person_memory ~/.hermes-your-agent/plugins/
cp -r infra/templates/plugins/credential_redactor ~/.hermes-your-agent/plugins/
cp -r infra/templates/hooks/lifecycle-notify ~/.hermes-your-agent/hooks/
```

Then list the plugins under `plugins.enabled` in the agent's `config.yaml` and restart it.
A copied plugin that is not listed there does not load.

**Note:** memory is still global at this level. The upstream image has no per-context memory.

## Level 3: Full Multi-Tenant (Image Switch)

Switch to the fork's image to get a separate memory per group or DM.

> **Image path:** `ghcr.io/cyborg-garden/hermes-agent-mt:latest`.
> The wizard deploys it, `lib/seed.ts` defaults to it, and it is the only path the image is published to.
> If a compose file, script or runbook pins the image under another namespace, change it to this one.

### What changes

| Before | After |
|--------|-------|
| `nousresearch/hermes-agent:latest` | `ghcr.io/cyborg-garden/hermes-agent-mt:latest` |
| Global memory (all conversations share one MEMORY.md) | Per-context memory (each group or DM gets its own) |
| No context ID sanitization | Path traversal protection on context IDs |

### Steps

1. Update your `docker-compose.yml`:
   ```yaml
   services:
     hermes-your-agent:
       image: ghcr.io/cyborg-garden/hermes-agent-mt:latest  # was nousresearch/...
       # everything else stays the same
   ```

2. Pull and restart:
   ```bash
   docker compose pull
   docker compose up -d
   ```

The data directory is a mounted volume, so nothing moves. The fork reads the same `config.yaml`, `.env`, `SOUL.md` and `memories/` directory.

### What happens to existing memories

- **Existing memories stay global.** They remain in `memories/MEMORY.md` and `memories/USER.md`.
- **New memories from group chats** go to `memories/contexts/{chat_id}/MEMORY.md`.
- **Reads merge both.** The agent sees global knowledge plus what belongs to the current context.
- **No migration step.** The merge happens at runtime.

### What happens to existing skills

Nothing. Skills live in the data directory and load at runtime. The fork reads them the same way upstream does.

## Via Import (Recommended)

The fastest path. On the **Harnesses** page:

1. Click **Import**
2. Enter the path to the agent's data directory (for example `~/.hermes/` or `~/.hermes-myagent/`). It must hold a `.env` or a `config.yaml`.
3. Give it a name

Swarm Map then:

- **Copies** the whole data directory to `~/.hermes-{name}/`. An agent named `personal` goes to `~/.hermes/`. The import stops if the destination already exists.
- **Adds** missing vars to the copy's `.env`: `HSM_URL`, `SWARM_MAP_POLICY_URL`, `HERMES_AGENT_NAME`, and `*_REQUIRE_MENTION=true` for Signal, Telegram and Mattermost. It never overwrites a value you set, but it does fill an empty mention setting, because the runtime reads empty as "answer everything". A Discord agent without `DISCORD_THREAD_REQUIRE_MENTION` gets `true`.
- **Installs** the base package: the plugins and hook above, plus the `session-handoff` and `garden-orientation` skills. Your own plugins, skills, persona and memory stay.
- **Writes** a `BOOT.md` startup checklist, if there isn't one
- **Generates** a hardened compose file for the fork's image, in Swarm Map's data folder under `compose/{name}/`
- **Registers** the agent on the dashboard

If anything goes wrong, the original is untouched. Delete `~/.hermes-{name}/` and you're back where you started.

### What to back up first

Import copies for you. For extra safety:

```bash
cp -r ~/.hermes ~/hermes-backup-$(date +%Y%m%d)
```

### What the copy keeps

- `SOUL.md` (the persona)
- `memories/` (all existing memories)
- `skills/` (all your skills)
- `config.yaml` (Swarm Map adds entries; it doesn't replace your model config)
- Plugins and hooks you installed
- `.env` secrets (Swarm Map adds vars; it doesn't change existing ones)

One exception: a GitHub token broker secret (`github-broker.json`) is not copied, because it identifies the source agent. See [the token broker](../scripts/token-broker/README.md).

## Recommended: Opinionated Config

These are the values Swarm Map writes into `config.yaml` for a new agent ([`lib/templates/config-yaml.ts`](../lib/templates/config-yaml.ts)). Consider them for an imported one:

```yaml
compression:
  enabled: true
  threshold: 0.50
  target_ratio: 0.20
  protect_last_n: 20

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 5000
  user_char_limit: 2000

session_reset:
  mode: both
  idle_minutes: 1440
  at_hour: 4  # read as a UTC hour: Hermes containers run in UTC, so use the UTC hour of your local 4am

group_sessions_per_user: false  # one shared session per group; true gives each person their own

agent:
  max_turns: 60

stt:
  enabled: true
  local:
    model: "base"
```

They keep context length and token costs bounded, and they turn on voice transcription.

## FAQ

**Will my agent lose its personality?**
No. `SOUL.md` is copied as it is, and the fork reads it the same way.

**Will my agent forget what it knows?**
No. Existing memories stay where they are. New group memories are written beside them.

**Can I go back to upstream?**
Yes. Switch the image back to `nousresearch/hermes-agent:latest`. The agent ignores the per-context memories (they are not deleted) and uses global memory only.

**Do I need to rebase anything?**
Not with the Docker image. It is an image swap, and the data directory stays the same.

**What if I'm not using Docker?**
Install the fork with `pip install -e ".[all]"` from the [hermes-agent-mt repo](https://github.com/cyborg-garden/hermes-agent-mt). It reads the same `config.yaml`, `SOUL.md` and memories.

**What if I changed the Hermes source code?**
Rebase your changes onto the fork. Most of its patches are adapter changes. See the [hermes-agent-mt repo](https://github.com/cyborg-garden/hermes-agent-mt).

**Will Import change my original files?**
No. It copies the data directory and changes only the copy.
