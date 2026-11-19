# Swarm Map Policy Plugin

Connects a Hermes agent to [Swarm Map](https://github.com/cyborg-garden/swarm-map) for admin checks and group access control on multi-tenant agents.

## Configuration

Swarm Map writes these to the agent's `.env` when it creates or imports the agent:

```
HSM_URL=http://host.docker.internal:3000
HERMES_AGENT_NAME=<agent-name>
```

`HSM_URL` points at Swarm Map's port (3000 unless Swarm Map runs with `PORT` set).
`HERMES_AGENT_NAME` is the agent's name in Swarm Map, without the `h_` prefix of its id.

`SWARM_MAP_SURFACE` is set to `public` by the base package's public surface. It turns on the public browser guard.

## What it does

- **Admin resolution.** On every incoming message (`pre_gateway_dispatch`) it asks Swarm Map whether the sender is an admin on that platform, through `GET /api/harnesses/<agent>/surfaces/<platform>/admins/<userId>`. It keeps the answer with the message's session context.
- **Admin-only tools.** `pre_tool_call` blocks the `approval` and `pr_approval` tools unless the sender is an admin.
- **Public browser guard.** With `SWARM_MAP_SURFACE=public` the browser stays on, but `browser_navigate` only opens http(s) URLs whose host resolves to public addresses, `browser_console` cannot run JavaScript, and `browser_cdp` is blocked. Hermes skips its own SSRF check for the Camofox backend, so this guard is what keeps a public bot off the host and the LAN. It does not see redirects or requests a page makes after loading. For those, isolate the public bot's Camofox on the network.
- **Group check.** `is_group_allowed()` asks Swarm Map whether a group is on the agent's allowlist, through `GET /api/harnesses/<agent>/surfaces/<platform>/groups/<groupId>`. No hook in this plugin calls it.

## Security Model

- **Admin checks:** fail closed. If Swarm Map is unreachable or not configured, the sender is not an admin.
- **Group checks:** fail closed. If Swarm Map is unreachable or not configured, the group is denied.
- **Public browser guard:** fail closed. A host that does not resolve is blocked. The guard registers even when `requests` is missing, so it never drops out silently.
- **Per-tool policy:** not built yet. `is_tool_allowed()` allows every tool.

## Hooks Used

- `pre_gateway_dispatch`: cache platform, chat, user and admin status for the session
- `pre_tool_call`: the public browser guard and admin-only tools
- `on_session_start`: logs the session start
