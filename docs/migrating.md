# Migrating Existing Hermes Agents

Already running Hermes agents? HSM can manage them — and optionally upgrade them to full multi-tenant with per-context memory isolation.

**Your existing data is never modified in place.** The import wizard creates a copy of your agent's data directory with the HSM patches applied. Your original stays untouched as a backup. If you don't like the result, just point back at your original.

## Running Without Docker?

HSM's wizard deploys Docker containers, but if you're running Hermes bare-metal (via `hermes gateway` or `pip install`), you can still use HSM for fleet management. HSM discovers agents by scanning data directories — Docker is optional for monitoring. For the full multi-tenant upgrade, you have two paths:

1. **Stay bare-metal:** Apply the Tier 2 changes manually (env vars + plugins). Install the MT fork via `pip install -e ".[all]"` from the [hermes-agent-mt repo](https://github.com/cyborg-garden/hermes-agent-mt). Memory scoping works the same way regardless of deployment method.
2. **Move to Docker:** The wizard containerizes your agent with security hardening. Your data directory is mounted as a volume — same files, just managed by Docker now.

## Tier 1: Fleet Management (No Changes)

If you just want to manage existing agents from the HSM dashboard:

1. Install HSM: `git clone ... && npm install && npm run seed && npm run dev`
2. Go to Settings and set your **Hermes Directory** to the parent folder containing your compose files
3. HSM auto-discovers running Hermes containers

You get: dashboard, logs, restart/rebuild, model cascade view, cost tracking.

You don't get: group policy enforcement, memory scoping, budget limits.

## Tier 2: HSM Integration (Plugin Install)

Add HSM-aware plugins to your existing agents without changing the Docker image.

### What gets added

| Component | Purpose |
|-----------|---------|
| `HSM_URL` env var | Agent phones home to HSM for group policy checks |
| `HERMES_AGENT_NAME` env var | Identifies this agent in HSM |
| `swarm_map_policy` plugin | Group approval, admin resolution, tool gating |
| `boot_md` plugin | Startup checklist execution |
| `lifecycle-notify` hook | Announces startup to home channel |

### Manual steps

Add to your agent's `.env`:
```bash
# HSM integration
HSM_URL=http://host.docker.internal:3000
SWARM_MAP_POLICY_URL=http://host.docker.internal:3000
HERMES_AGENT_NAME=your-agent-name
HERMES_MEMORY_SCOPE=channel

# Security defaults (if not already set)
HERMES_DM_POLICY=approved-only
HERMES_APPROVAL_ADMIN_ONLY=true
```

Copy the baseline plugins from HSM into your agent's data directory:
```bash
# From the hermes-swarm-map repo
cp -r infra/templates/plugins/swarm_map_policy ~/.hermes-your-agent/plugins/
cp -r infra/templates/plugins/boot_md ~/.hermes-your-agent/plugins/
cp -r infra/templates/hooks/lifecycle-notify ~/.hermes-your-agent/hooks/
```

Restart your agent. It will now check with HSM before responding in new groups.

**Note:** Memory is still global at this tier. The upstream image doesn't support per-context isolation.

## Tier 3: Full Multi-Tenant (Image Switch)

Switch to the MT fork image for per-context memory isolation — the core feature.

> **Canonical image path:** `ghcr.io/cyborg-garden/hermes-agent-mt:latest`. Use this one.
> It is what the wizard deploys, what `lib/seed.ts` defaults to, and the only path we
> publish to. If you have a compose file, script, or runbook pinning the image under any
> other namespace, repoint it here.

### What changes

| Before | After |
|--------|-------|
| `nousresearch/hermes-agent:latest` | `ghcr.io/cyborg-garden/hermes-agent-mt:latest` |
| Global memory (all conversations share one MEMORY.md) | Per-context memory (each group/DM gets its own) |
| No context ID sanitization | Path traversal protection on context IDs |

### Steps

1. Update your `docker-compose.yml`:
   ```yaml
   services:
     hermes-your-agent:
       image: ghcr.io/cyborg-garden/hermes-agent-mt:latest  # was nousresearch/...
       # everything else stays the same
   ```

2. Rebuild:
   ```bash
   docker compose pull
   docker compose up -d
   ```

That's it. Your data directory is mounted as a volume — nothing moves, nothing changes. The MT fork reads the same `config.yaml`, `.env`, `SOUL.md`, and `memories/` directory.

### What happens to existing memories

- **Existing memories stay global** — they remain in `memories/MEMORY.md` and `memories/USER.md`
- **New memories from group chats** go to `memories/contexts/{chat_id}/MEMORY.md`
- **Reads merge both** — the agent sees global knowledge + context-specific knowledge
- **No migration needed** — the merge happens automatically at runtime

### What happens to existing skills

Nothing. Skills are stored in the data directory and loaded at runtime. The MT fork reads them the same way upstream does.

## Via HSM Import (Recommended)

The fastest path. From the HSM dashboard:

1. Click **Import** on the harnesses page
2. Enter the path to your agent's data directory (e.g., `~/.hermes/` or `~/.hermes-myagent/`)
3. Give it a name

HSM handles the rest automatically:

- **Copies** your entire data directory to `~/.hermes-{name}/` — your original is never modified
- **Appends** HSM env vars to the copy's `.env` (only adds what's missing, never overwrites)
- **Installs** baseline plugins (swarm_map_policy, boot_md) and the OCR skill
- **Writes** BOOT.md startup checklist (if not already present)
- **Generates** a hardened Docker compose file with the MT fork image
- **Registers** the agent in the dashboard

If anything goes wrong, your original directory is untouched. Delete `~/.hermes-{name}/` and you're back to where you started.

### What to back up first

The import copies for you, but if you want extra safety:

```bash
cp -r ~/.hermes ~/hermes-backup-$(date +%Y%m%d)
```

### What's preserved in the copy

Everything:
- `SOUL.md` (your personality)
- `memories/` (all existing memories)
- `skills/` (all your skills)
- `config.yaml` (your model config — HSM adds sections, doesn't overwrite)
- Custom plugins and hooks you've installed
- `.env` secrets (HSM appends new vars, doesn't touch existing ones)

### What's added

- `HSM_URL` and `HERMES_AGENT_NAME` in `.env`
- `swarm_map_policy` plugin (group policy enforcement)
- `boot_md` plugin (startup checklist)
- `lifecycle-notify` hook (startup notification)
- `BOOT.md` (startup checklist content)
- `ocr-and-documents` skill (PDF/image text extraction)

## Recommended: Opinionated Config

While migrating, consider adding our production-tested defaults to your `config.yaml`:

```yaml
compression:
  enabled: true
  threshold: 0.50
  target_ratio: 0.20
  protect_last_n: 20

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200

session_reset:
  mode: both
  idle_minutes: 1440
  at_hour: 4

group_sessions_per_user: true

agent:
  max_turns: 60

stt:
  enabled: true
  local:
    model: "base"
```

These prevent common production issues: runaway context length, unbounded token costs, and missing voice transcription.

## FAQ

**Will my agent lose its personality?**
No. Your SOUL.md is untouched. The MT fork reads it the same way.

**Will my agent forget what it knows?**
No. Existing memories stay in place. New group memories are written alongside them, not replacing them.

**Can I go back to upstream?**
Yes. Switch the image back to `nousresearch/hermes-agent:latest`. Context-scoped memories will be ignored (but not deleted) — the agent reverts to global-only.

**Do I need to rebase anything?**
No. If you're using the Docker image, it's a simple image swap. Your data directory is the same. No code merges needed.

**What if I'm not using Docker?**
Install the MT fork via pip: `pip install -e ".[all]"` from the [hermes-agent-mt repo](https://github.com/cyborg-garden/hermes-agent-mt). Your data directory works the same way — the fork reads the same config.yaml, SOUL.md, and memories. HSM can still manage your agent for monitoring and config, even without Docker.

**What if I customized the Hermes source code?**
If you built from source with custom modifications, you'd need to rebase your changes onto the MT fork. The MT fork has 27 patches — mostly adapter improvements. Conflicts are typically minimal. See the [rebase journal](https://github.com/cyborg-garden/hermes-agent-mt) for guidance.

**Will the import wizard modify my original files?**
No. It copies your data directory to a new location and applies changes to the copy. Your original is never touched.
