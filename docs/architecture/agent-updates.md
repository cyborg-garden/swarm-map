# Agent Updates

A deployed Hermes agent has **two independent update surfaces**. Knowing which
one a change lives in tells you how to ship it.

## 1. Runtime image (baked, immutable)

The Hermes runtime code at `/opt/hermes` is baked into the Docker image. It
changes only when the image is rebuilt.

- **What lives here:** core Hermes code, platform/gateway adapters, system
  tools, security fixes — anything in the `hermes-agent` image.
- **How it updates:** rebuild the image and recreate the container. There is no
  automatic pull — a running agent stays on its built image until you rebuild.
- **Scope:** the rebuild picks up whatever the image source (local build or
  pinned tag) is at that moment.

Restart modes (`POST /api/harnesses/:id/restart` with `{ mode }`):

| mode | what it does | use when |
|---|---|---|
| `quick` | `docker compose restart` — bounce the process | config/env reload, no image change |
| `recreate` | `up -d --force-recreate` — new container, **same image**, reloads env + hot-mounted `/opt/data` | picked up new artifacts/config without an image change |
| `rebuild` | `up -d --build --force-recreate` — rebuild image, then recreate | shipped new runtime code |
| `purge` | `build --no-cache` then recreate | a clean from-scratch image build |

> A `rebuild` updates **code**, not artifacts — it does **not** re-run artifact
> installation. New plugins/skills do not arrive via rebuild; use sync (below).

## 2. Artifacts (hot-mounted, mutable)

Plugins, skills, and hooks live in the agent's `/opt/data` dir, hot-mounted from
the host. They are installed at **create/duplicate** from the manifest
(`infra/artifacts.json`), and synced onto **existing** agents on demand.

- **What lives here:** plugins, skills, hooks, config overrides.
- **How it updates:** `POST /api/harnesses/:id/artifacts/sync`
  (`lib/services/artifacts-sync.ts`).
  - Installs artifacts that are **missing** (additive floor — never clobbers).
  - Updates an existing artifact **only if a content-hash lock
    (`.artifacts-lock.json`) proves it's unmodified** since install; a
    user-edited or untracked artifact is skipped. `force` overrides.
  - Enables newly-installed plugins in `config.yaml`, and recreates the
    container only if something changed. `dryRun` returns the plan with no writes.
- **Scope:** per-agent, immediate.

### The base package (v1)

`infra/artifacts.json` is also the **base package** definition (`version`,
`tier: core | pack`, `imagePlugins`, `research`, `surfaces`, `deadEnvKeys`), with
the SOUL orientation block in `infra/base-package/soul-orientation.md`. Code:
`lib/services/base-package.ts`.

- **On create** (scaffold, duplicate, `/api/setup/deploy`, import): every path
  calls `installBaselineTemplates(dataDir, { surface, packs })`, which installs
  core + chosen packs, writes `plugins.enabled` as a block list, applies the
  surface profile, adds the orientation block and writes `.hsm-base-package`
  (`{version, surface, packs}`). Required research keys (Brave) are assigned
  from the key store via `setAssignment`. Body fields: `surface`
  (`private | team | public`, default `team`), `packs` (e.g. `browser-ops`).
- **Existing agents:** the sync route above *is* the adopt route. It is
  add-only and idempotent: missing core items are installed, missing names are
  added to lists (inline `[]` becomes a block list), the surface profile is
  applied, only the marked SOUL block is replaced, and nothing is removed.
  Extra body fields: `surface`, `packs`, `assignKeys` (default true),
  `includeVision` (assign the OpenRouter vision key).
- **Drift (report only):** `GET /api/harnesses/:id/base-package/drift` lists
  what an agent is missing or violating. It fixes nothing; run sync to adopt.
- **Public surface:** DMs off (`DISCORD_ALLOW_ALL_USERS=false`), terminal,
  code execution, file and Discord-history toolsets off, a pruned skill list,
  and no browser-ops / GitHub / Google.

## Choosing

- New plugin/skill added to the manifest → **sync** the agents that should get it.
- Runtime code / security fix shipped → **rebuild** to pick up the new image.
- Corrupted agent → fix the data dir and `recreate`, or `purge` to reset.

## Known gap: no CD for the runtime image

Artifact rollout is a single API call per agent, but the **runtime-image** half
is still manual (build/pull + rebuild, no version pinning or staged rollout).
Closing that — pinned images + an approval-gated, canary-then-fleet rollout — is
tracked as future work.
