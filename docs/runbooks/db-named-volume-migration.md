# DB named-volume migration (#204 PR2)

Moves a harness's SQLite files (`state.db`, `response_store.db`, `kanban.db`, with
`-wal`/`-shm` siblings) off the VirtioFS bind mount, which can tear SQLite writes.
They move onto a named Docker volume (`hermes-state-<name>`, native ext4 inside the
VM). Symlinks stay at the old `/opt/data` paths, so the agent needs no changes.

## When a new compose file gets this layout

Swarm Map decides per agent each time it generates a compose file (new agent,
duplicate, import, deploy, or a regeneration after a VPN or resource-limit
change). The rule is in `lib/services/state-volume.ts`:

1. **An agent whose databases are already on the volume keeps the layout.** Its
   data dir holds symlinks into `/state`; a compose file without the `/state`
   mount would leave them pointing at nothing. The same applies when the data
   dir cannot be read, and on a regeneration when the compose file being
   replaced already mounts the volume and the data dir holds no regular
   `state.db` (a `state-init` run that was interrupted). This holds whatever
   the setting below says. To take such an agent off the volume, do the
   Rollback below first. An agent whose data dir holds a regular `state.db`
   and no symlinks is not on the volume, whatever its old compose file mounts.
2. Otherwise **`useStateVolume` in settings** decides, when it is set:
   `PUT /api/settings` with `{"useStateVolume": true}` or `false`. Send `null` to
   go back to automatic.
3. Otherwise it is **automatic**, from the Docker engine (`docker info`):
   - **on** when the engine runs in a VM, so the bind mount crosses a
     file-sharing layer: any engine on macOS or Windows, and Docker Desktop,
     OrbStack, Rancher Desktop or WSL seen from a Linux process;
   - **on** when the engine cannot be identified: it does not answer, the
     `docker` CLI points at another machine, Swarm Map itself runs in a
     container, or the docker context name or socket path contains `colima`,
     `lima`, `rancher` or `podman` as a whole word (`lima-default`,
     `rancher-desktop`, `~/.colima/default/docker.sock`; not `lima01`). The
     machine's hostname is not looked at. `{"useStateVolume": false}` overrides
     this rule like any other automatic result;
   - **off** on native Linux, where a bind mount is an ordinary local directory
     and the layout is unnecessary (#273).

   Docker installed inside WSL and a Podman `docker` shim on native Linux both
   count as "cannot be identified", so they get the layout. If the host is known
   to need none, turn it off with `{"useStateVolume": false}`.

An agent with plain database files that is regenerated with the layout on is
migrated by `state-init` at its next start, the same way the route below does it.

## Migrate one harness

```
POST /api/harnesses/<id>/migrate-db        # operator-authed; one at a time by design
```

The route:

1. Edits the existing compose file in place. It never regenerates it (see Guards).
2. Validates it with `docker compose config`.
3. Stops the agent and recreates it. Compose runs the one-shot `state-init-<name>`
   service to completion **before** the agent starts, so files move while no writer exists.
4. Polls to verify: init exited 0, host `state.db` is now a symlink, agent running.

The response lists every step.

**Canary discipline:** migrate one low-stakes harness and watch it for a few days.
The `/api/integrity` sweep and the write-failure badge from #205 are the watchers. Then roll
the next. There is deliberately no fleet-wide endpoint.

## What changes for host-side readers

The host path `~/.hermes-<name>/state.db` becomes a **dangling symlink** (its target
exists only in-container). Cost/usage/memory reads and the integrity sweep detect
this (`lstat`) and switch:

- **usage/cost/memory** read `state.db.snapshot`. It is exported every ~5 min
  (`DB_SNAPSHOT_INTERVAL_MS`) via `docker exec` and Python's `sqlite3` backup API,
  with an atomic tmp+rename. Until the first export lands, they report **unknown, not 0**.
  Numbers are up to one interval stale; do not treat them as live.
- **integrity checks** run `quick_check` via `docker exec python3` inside the
  container, where SQLite's locking actually holds, instead of on the host path.
  (Side benefit: big-DB checks no longer block the dashboard's event loop.)
- **logs** stay on the bind mount; nothing about log reading changes.

## Guards you may hit

- **409 "cannot transform compose":** the compose file's shape defeated the
  in-place transformer (hand-edited structure, missing anchors). By design it
  refuses rather than regenerating: regeneration from the standalone template
  silently strips deploy-born hardening (`read_only`, tmpfs, google-MCP), VPN
  sidecars, and hand edits. Fix the file by hand or migrate that harness manually.
- **409 on settings PUT (deploy-born):** VPN and resource changes regenerate the
  compose from the standalone template, which would strip deploy-born extras; the
  settings route now refuses those on deploy-born composes before writing anything.

## `hermes import` un-migrates (self-healing)

An in-container `hermes import` restore replaces the symlink with a regular file.
The harness then silently runs on the bind mount again until its next recreate. This is
survivable by design: the init service treats a **regular file as authoritative**
(it is the newer data) and re-migrates it to the volume on every recreate. If you
know an import happened, `POST /api/harnesses/<id>/migrate-db` again (idempotent,
stops the writer first) or recreate through Swarm Map.

**Writer quiescing:** every Swarm Map recreate, rebuild or purge runs `compose stop
<service>` before `up -d --force-recreate`. Do NOT remove that stop, and never
recreate a wired compose by hand without stopping the agent first: `up` runs the
state-init copy while the OLD container is still writing. A torn copy of a live
WAL database then becomes the only copy. That is the #204 corruption class this
migration exists to eliminate.

**Implicit first migration:** when the layout is on for an agent (see "When a new
compose file gets this layout"), both compose generators emit the migration wiring.
So ANY recreate of an unmigrated harness after a regeneration (a settings save that
changes VPN or resources, an image pin, a plugin sync) performs its first migration.
The stop above makes that safe, but it happens outside the canary endpoint. Prefer migrating
deliberately via `POST /migrate-db` before touching settings on a harness you're
staging.

**SQLite precondition (verify once per pinned image):** the symlink pattern
relies on in-image SQLite deriving `-wal`/`-shm` from the RESOLVED path
(SQLite >= 3.20, 2017). Before first production migration on a new image pin:
`docker exec hermes-<name> python3 -c "import sqlite3; print(sqlite3.sqlite_version)"`.
If a non-empty `-wal` ever appears next to a symlinked db, state-init now
refuses to delete it and exits 1 (agent stays down) instead of silently
discarding committed transactions. That is your signal this assumption broke.

## Rollback (de-migrate one harness)

> **Bind path warning:** `/opt/data` below must be the harness's ACTUAL data
> dir, the same one its compose mounts (authoritative mapping:
> `agentDataDirForName`). For every named agent that is `~/.hermes-<name>`,
> but for the **personal** harness it is **`~/.hermes`** (NOT
> `~/.hermes-personal`. Docker would silently auto-create that empty dir, the
> copy-back would land nowhere useful, and step 4's `volume rm` would then
> delete the only real copy). Verify with
> `docker inspect hermes-<name> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'`
> before running step 2.

1. Stop the agent: `docker stop hermes-<name>`.
2. Copy files back from the volume to the bind mount, replacing the symlinks:
   ```
   docker run --rm -v hermes-state-<name>:/state -v <DATA_DIR>:/opt/data \
     <agent-image> sh -c 'for db in state.db response_store.db kanban.db; do
       [ -L /opt/data/$db ] && rm -f /opt/data/$db
       [ -f /state/$db ] || continue
       for suf in "" -wal -shm; do rm -f /opt/data/$db$suf; done
       for suf in "" -wal -shm; do [ -f /state/$db$suf ] && cp -p /state/$db$suf /opt/data/$db$suf; done
     done'
   ```
3. Remove the migration wiring from the compose file (the `state-init-<name>`
   service, its `depends_on` entry, the `- hermes-state-<name>:/state` mount, and
   the top-level `volumes:` block). If the layout would be automatic-on for this
   host (see "When a new compose file gets this layout"), also set
   `useStateVolume` to `false`, or the next regeneration of this agent's compose
   file migrates it again.
4. `docker compose up -d --force-recreate`, then delete the volume once satisfied:
   `docker volume rm hermes-state-<name>`.

**Never `docker compose down -v`** on a migrated harness. It deletes the named
volume, which holds the live databases.

## Volume lifecycle on delete

Harness delete with "delete files" also removes `hermes-state-<name>` (after
`compose down` releases it), so a deleted agent's DBs cannot resurrect into a
future same-name agent. The pinned `name:` would otherwise reattach the old
volume. The personal harness's volume is exempt (same guard as `~/.hermes`).
Deletes performed before this behavior existed may have left orphans: audit with
`docker volume ls --format '{{.Name}}' | grep '^hermes-state-'` and remove any
whose harness no longer exists.
