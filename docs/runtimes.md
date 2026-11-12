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

- `adapterForRuntime` throws `UnsupportedRuntimeError` for a retired or unknown tag.
- Such rows are left out of `GET /api/harnesses` and have no detail page, so no start, stop,
  restart, duplicate, settings or delete-files call can reach them.
- `GET /api/harnesses/retired` lists them with the stored tag and a reason. The fleet page
  shows them under "Rows Swarm Map no longer manages".
- `DELETE /api/harnesses/:id` on such a row forgets the row and nothing else. It does not
  touch a container, a data directory or a volume, even with `deleteFiles=true`.
- `POST /api/setup/deploy` with any `runtime` other than `hermes` returns 400 and creates
  nothing.

Tests: `lib/services/__tests__/retired-runtime.test.ts`,
`lib/services/__tests__/deploy-route.integration.test.ts`.

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
