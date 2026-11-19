# Agent Updates

A deployed Hermes agent has **two independent update surfaces**. Knowing which
one a change lives in tells you how to ship it.

## 1. Runtime image (baked, immutable)

The Hermes runtime code at `/opt/hermes` is baked into the Docker image. It
changes only when the image is rebuilt or a newer image is pulled.

- **What lives here:** core Hermes code, platform and gateway adapters, system
  tools, security fixes. That is anything in the `hermes-agent-mt` image
  (default `ghcr.io/cyborg-garden/hermes-agent-mt:latest`).
- **How it updates:** rebuild the image and recreate the container. Nothing on
  the host pulls or rebuilds on its own. A running agent stays on its built
  image until someone rebuilds it.
- **Scope:** for a local build, `rebuild` and `purge` first fetch the build
  source and fast-forward it to its upstream branch. They refuse to build over
  uncommitted changes, a detached HEAD, or diverged history. The resolved
  commit is stamped into the image as `HERMES_GIT_SHA`.

Restart modes (`POST /api/harnesses/:id/restart` with `{ mode }`):

| mode | what it does | use when |
|---|---|---|
| `quick` | `docker compose restart`: bounces the process. Does **not** reload `.env`. | a `config.yaml` change, no env or image change |
| `recreate` | stop, then `up -d --force-recreate`: new container, **same image**. Reloads `.env` and the hot-mounted `/opt/data`. | rotated keys, new artifacts or config, no image change |
| `rebuild` | `compose build` (cached), then stop and recreate | shipped new runtime code |
| `purge` | `compose build --no-cache`, then stop and recreate | a clean from-scratch image build |

Every recreating mode stops the container before `up`, so the one-shot
state-init service never copies SQLite files under a live writer.

> A `rebuild` updates **code**, not artifacts. It does **not** re-run artifact
> installation. New plugins and skills do not arrive via rebuild; use sync (below).

## 2. Artifacts (hot-mounted, mutable)

Plugins, skills, and hooks live in the agent's `/opt/data` dir, hot-mounted from
the host. They are installed at **create/duplicate** from the manifest
(`infra/artifacts.json`), and synced onto **existing** agents on demand.

- **What lives here:** plugins, skills, hooks, config overrides.
- **How it updates:** `POST /api/harnesses/:id/artifacts/sync`
  (`lib/services/artifacts-sync.ts`).
  - Installs artifacts that are **missing** (additive floor: it never clobbers).
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
  and no browser-ops / engineering / GitHub / Google.
- **Browser (v1.1):** plain browsing is base research for every agent, public
  included: create and sync add `CAMOFOX_URL` when an agent has none (an
  existing URL is kept; no `CAMOFOX_USER_ID`, so sessions use ephemeral
  profiles). `browser-ops` is now only captcha solving + browser login. On a
  public surface `SWARM_MAP_SURFACE=public` turns on the swarm-map-policy
  browser guard: navigation only to public http(s) hosts, no page JavaScript,
  no CDP. Hermes skips its own SSRF check for camofox, so this guard is the
  barrier; it does not cover redirects or a page's own requests.
- **Engineering pack:** opt-in `engineering` adds three skills (`engineering-process`,
  `engineering-multiplayer`, `property-testing`). Process only: no plugin, tool, key or access. Refused
  on a public surface.

## Choosing

- New plugin/skill added to the manifest → **sync** the agents that should get it.
- Runtime code / security fix shipped → **rebuild** to pick up the new image.
- Corrupted agent → fix the data dir and `recreate`, or `purge` to reset.

## Known gap: no CD for the runtime image

Artifact rollout is a single API call per agent.
The **runtime-image** half is still manual: build or pull, then rebuild each agent.
There is no version pinning or staged rollout yet.

`GET /api/fleet/drift` reports which agents run older code than their build
source (`lib/services/drift.ts`). It is read-only and never rebuilds.
Pinned images and an approval-gated, canary-then-fleet rollout are future work.
