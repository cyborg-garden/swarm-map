# Runtimes

Swarm Map drives one agent runtime today: **Hermes**. This page says what ships, what was
removed, and what is planned, so nobody has to find the line after deploying.

## What ships today: Hermes

**Hermes: one container per agent.** An agent is a Docker container with its own data
directory, `.env`, `SOUL.md`, memory files, plugins and messaging surfaces. You can start
it, stop it, restart it, rebuild it, read its logs, and attach it to Signal, Telegram,
Mattermost or Discord.

`ContainerRuntimeAdapter` (`lib/services/runtime-adapter.ts`) is the seam for container
runtimes. Hermes is its only member.

| Capability | Hermes |
|---|---|
| Deploy from the wizard | yes |
| Start / stop / restart / rebuild / purge | yes |
| Container logs, CPU, memory, health | yes |
| Messaging surfaces | yes, direct |
| Group approval policy, audit log | yes |
| Model cascade with fallback providers | yes |
| Bundled Ollama | yes |

## A runtime Swarm Map does not know is never Hermes

Every stored agent row carries a `runtime` tag. A row with no tag is Hermes (rows written
before the tag existed). Any other tag must have a registered adapter. There is no fallback.

One exception to "no tag is Hermes": the old Letta integration never stored a tag. The only
rows it could leave behind have the ids it minted (`h_letta_agent-<uuid>`, `h_letta_server`)
and no field except `surfaceAdmins`. A row with one of those ids, no tag and no other field
counts as retired.

A Hermes agent named `letta-server` gets the id `h_letta_server` too. Three things keep it
out of that rule. The row Swarm Map stores for it carries Hermes fields (name, compose file,
port). Every row written from now on is tagged `runtime: 'hermes'`, and an explicit tag
always wins. And for the bare `{ id, surfaceAdmins }` row an older build wrote for a Hermes
agent it had only discovered, the disk decides: a Hermes agent has a home at
`~/.hermes-letta-server`, and the old server never had one. If that directory exists, the
row is the Hermes agent's. The agent ids (`h_letta_agent-<uuid>`) keep a hyphen that no
Hermes name derives, so they are retired whatever is on disk.

- `adapterForRuntime` throws `UnsupportedRuntimeError` for a retired or unknown tag.
- The row owns its id while it is stored. If a live container maps to the same id (a
  `hermes-foo` container beside a retired `h_foo` row), it is not shown or driven until the
  row is forgotten. It then appears as a plain Hermes agent with none of the row's settings.
- Such rows are left out of `GET /api/harnesses` and have no detail page.
- Every route under `/api/harnesses/:id/` answers 409 for such a row before it does
  anything, reads included. That covers the routes that never look the agent up and go
  straight from the id to `~/.hermes-<name>`: surface connect and disconnect, policy,
  pairing, admins, group invites, settings. The shared check is `refuseUnmanagedRow`
  (`lib/services/unmanaged-row-guard.ts`). A bare agent slug is refused the same way as the
  stored id. `GET /api/harnesses/:id` itself answers 404.
- Four reads are the exception, because a running agent calls them about itself by its own
  slug: `GET .../policy`, `GET .../surfaces/:platform/admins`, `.../admins/:userId` and
  `.../groups/:groupId`. They answer from that agent's own `.env`, never from the row's
  stored fields, and write nothing.
- An id or agent name becomes a Hermes home in one function, `agentHome()`
  (`lib/services/agent-home.ts`), which throws for such a row. Key assignment, key
  discovery, tool and memory discovery, the surface list, usage, the integrity log scan and
  the username resolvers all go through it, so a retired id in a request body or in
  `keys.json` is skipped: nothing is read from or written to the directory it maps to, and
  it is not recorded as assigned.
- A new agent cannot take a name such a row still holds. Deploy, create and import refuse
  with 409 (or an error) before their first write. Forget the row first.
- `GET /api/harnesses/retired` lists them with the stored tag and a reason. The fleet page
  shows them under "Rows Swarm Map no longer manages".
- `DELETE /api/harnesses/:id` on such a row forgets the row and nothing else. It does not
  touch a container, a data directory or a volume, even with `deleteFiles=true`.
- `POST /api/setup/deploy` with any `runtime` other than `hermes` returns 400 and creates
  nothing.

Tests: `lib/services/__tests__/retired-runtime.test.ts`,
`app/api/harnesses/__tests__/retired-row-routes.test.ts` (calls every per-agent route,
reads and writes, found by walking the directory),
`lib/services/__tests__/surface-admins.test.ts`,
`lib/services/__tests__/keys-discovery.test.ts`,
`lib/services/__tests__/unmanaged-row-readers.test.ts`,
`lib/services/__tests__/deploy-route.integration.test.ts`, and
`lib/__tests__/agent-home-guards.test.ts`, which reads the source and fails when a second
copy of the id-to-directory mapping appears.

## What was removed: the old Letta integration

Two things are gone.

1. **The client for Letta's self-hosted server.** Swarm Map used to list and message agents
   on a Letta server it brought up from a pinned Docker image. Letta has retired that
   server in favour of Letta Code, so the image gets no fixes and its REST API has no
   successor. The client, its five API routes, the fleet page, the agent detail view and
   the server's compose file were deleted.
2. **The Hermes-to-Letta bridge.** A wizard choice deployed a Hermes container as a chat
   front for an agent on that server. Swarm Map no longer writes the bridge's environment
   variables and no longer offers the choice.

The runtime tags `letta` and `letta-server` are now retired tags (see the section above).

What removal does **not** do:

- It does not stop or delete a Letta server container that is already running. Swarm Map
  only stops talking to it.
- It does not delete the server's Docker volume or its `.env` under the Swarm Map data
  directory. Agent memory held there stays on disk until an operator removes it.
- It does not migrate any agent. Letta publishes no path from the old server to Letta Code.

Guard tests keep the removed code out: `lib/__tests__/retired-letta-guards.test.ts`.

## What is planned

Nothing in this section ships yet.

The plan is to stop teaching every harness Swarm Map's chat rules, and instead put one small
trusted process (a "sidecar") beside each agent. The sidecar owns chat in, chat out, model
traffic and tool verdicts. The harness runs in a cell with no chat token and no real key.
A new harness then needs one small shim, not a re-implementation of every rule.

- Spec: [Harness-agnostic primitives](specs/2026-11-13-harness-agnostic-primitives.md)
- Letta Code plan: [Letta Code migration](plans/2026-11-13-letta-code-migration.md)

Order: Pi first, then Letta Code, each driven the same way. Hermes stays as it is.

One known limit is stated up front: Letta Code keeps memory per agent and always on, so it
cannot keep memory apart per room. The plan measures that and shows it. It does not hide it.

## Related

- [Getting Started](getting-started.md)
- [Image vs HSM Boundary](architecture/image-vs-hsm-boundary.md)
- [Roadmap](ROADMAP.md)
