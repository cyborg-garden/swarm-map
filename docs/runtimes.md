# Runtimes

Swarm Map runs two kinds of agent: Hermes containers and door agents.
This page says what each one is, how far each is proven, and what was removed.

## Hermes: one container per agent

This is the main path, and the one in daily use.

An agent is a Docker container with its own data directory, `.env`, `SOUL.md`, memory files,
plugins and messaging surfaces. You can start it, stop it, restart it, rebuild it, read its logs,
and attach it to Signal, Telegram, Mattermost, Discord or Slack.

Swarm Map writes the agent's config. Hermes reads it and enforces the rules.

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
| Budget | tracked, not enforced |

## Door agents: the harness in a sealed cell

Door agents are newer and lab-grade. Use them where a mistake is cheap.

A small guard process, the door, runs on the host. It holds the chat token, the model key, the
rules, the receipts and the budget. The harness runs in a sealed Docker cell. The cell has no
chat token, a placeholder instead of the model key, and no network route except the door.

Every "who may it hear and answer" rule is decided in one place, `decide()` in `lib/core/`.
The harness is never asked to enforce one. Adding a harness means writing one small shim with
four verbs: start it, send text, read text, veto a tool.

### Harnesses

| Harness | Conformance suite | Dashboard | Notes |
|---|---|---|---|
| Pi | passes every check it runs | yes, the default | |
| Letta Code | passes every check it runs | yes | One memory per agent, so one room or one person per agent |
| Claude Agent SDK | passes every check it runs | no | Test rig only; no launcher yet |

The suite is harness-neutral: the same checks run against each shim, first as processes on one
machine, then in the sealed cell. Not every check runs for every harness: a check needs a capability the
harness has. Pinned versions, and which checks ran or did not, are in `conformance/matrix/`.

### What a door agent does today

- **Discord only.** One agent can sit in several channels, each with its own rules: who is heard,
  whether a mention is needed, which tools are allowed. A channel can be open to anyone, and then
  it loses the shell and file tools.
- **Tools are off until the rules turn one on.** Read files, write files and a shell run inside
  the cell. Reading a web page and web search go through the door, also off by default.
- **Approvals in the room (Pi only).** A tool set to `ask` posts the request in the channel. An admin
  replies approve or deny, or reacts. No answer in time means no.
- **A monthly budget that refuses** model calls once it is spent.
- **Receipts.** Every decision the door makes is logged and shown on the agent's page.
- **Persona and notes.** A persona document, and per-room notes kept by the door that survive a
  restart.

### What is not proven

- The cell's seal is shown on one machine and one Docker setup, and for nothing wider.
- Swarm Map shows a `pm2` command to supervise a door. It does not run the supervisor itself.
- Door agents and Hermes agents do not share settings yet. Each has its own pages.

Read more:
[the design](lab/primitives.md),
[Pi](lab/pi-slice.md), [Letta Code](lab/letta-code.md), [Claude Agent SDK](lab/claude-sdk.md),
[running one in Discord](lab/pi-discord.md),
[in the dashboard](lab/dashboard-slice.md),
[tools](lab/tools-slice.md),
[persona and memory](lab/persona-memory.md).

In code, a door agent has no container adapter. Its row carries `runtime: "pi"` or
`runtime: "letta-code"` (`DOOR_RUNTIMES` in `lib/services/runtime-adapter.ts`), and it is driven
through `DoorRuntimeAdapter` (`lib/services/door-agents.ts`). Hermes code paths leave it alone.

## A runtime Swarm Map does not know is never Hermes

A stored agent row can carry a `runtime` tag. A row with no tag is Hermes, as it always
was. A row whose tag is neither Hermes nor a door runtime is kept and shown, but is read-only.
Only the tag decides: nothing is inferred from an id, a name or what is on disk.

- Such a row is left out of `GET /api/harnesses` and has no detail page.
  `GET /api/harnesses/retired` lists it with the stored tag and a reason, and the fleet
  page shows it under "Rows Swarm Map no longer manages" with one action, "Forget row".
- A request that would change something is answered 409 when the id it carries is the
  stored id of such a row, whether the id is in the URL (`/api/harnesses/<id>/...`) or
  in the body (a key's `assignedTo`, a cascade or model-update `harnessId`). The id is
  matched exactly. The check is made in one place, the shared id step in
  `lib/harness-ref.ts`.
- The three surface policy routes (`/api/harnesses/<id>/surfaces/<platform>/...`) take a
  bare slug as well as an id and resolve it through `SurfaceAdminService`, which treats
  such a row as no agent: reads answer with no admins and no groups, writes with 404.
- `DELETE /api/harnesses/:id` is the exception. It forgets the row and nothing else: no
  container, data directory or volume is touched, even with `deleteFiles=true`.
- Inside the server, `adapterForRuntime` throws `UnsupportedRuntimeError` for such a tag,
  so the schedulers and sweeps never drive the row either.
- `POST /api/setup/deploy` with any `runtime` other than `hermes` returns 400 and creates
  nothing. Door agents are created through `POST /api/harnesses/door`.

Tests: `app/api/harness-id-sweep.test.ts` (walks every route file and sends each write
route the id of such a row), `app/api/harnesses/__tests__/unknown-runtime-routes.test.ts`
(the real services over real files),
`lib/services/__tests__/retired-runtime.test.ts`,
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
Letta Code as a door harness is separate work. It talks to a different program in a different way.

What removal does **not** do:

- It does not stop or delete a Letta server container that is already running. Swarm Map
  only stops talking to it.
- It does not delete the server's Docker volume or its `.env` under the Swarm Map data
  directory. Agent memory held there stays on disk until an operator removes it.
- It does not migrate any agent. Letta publishes no path from the old server to Letta Code.

Guard tests keep the removed code out: `lib/__tests__/retired-letta-guards.test.ts`.

## Related

- [Getting Started](getting-started.md)
- [Image vs Swarm Map boundary](architecture/image-vs-hsm-boundary.md)
- [Roadmap](ROADMAP.md)
