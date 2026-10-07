# Swarm Map Policy Plugin

Integrates Hermes with [Swarm Map](https://github.com/cyborg-garden/swarm-map) for multi-tenant group access control.

## Configuration

Set these environment variables in your agent's `.env`:

```
HSM_URL=http://localhost:3002
HERMES_AGENT_NAME=hermes-<agent>
```

## Security Model

- **Group checks:** Fail-closed. If HSM is unreachable, group messages are denied.
- **Tool checks:** Fail-open. If HSM is not configured, all tools are allowed.
- **Public browser guard:** Fail-closed. With `SWARM_MAP_SURFACE=public` (set by
  the base package's public surface) the browser stays on, but
  `browser_navigate` only opens http(s) URLs whose host resolves to public
  addresses, `browser_console` cannot run JavaScript, and `browser_cdp` is
  blocked. Hermes skips its own SSRF check for the camofox backend, so this
  gate is what keeps a public bot off the host and the LAN. It does not see
  redirects or requests a page makes after loading; isolate the public bot's
  camofox on the network for that.

## Hooks Used

- `on_session_start` — validate group access and cache admin status
- `pre_tool_call` — gate tools based on HSM policy (future)
