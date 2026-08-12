# Swarm Map Policy Plugin

Integrates Hermes with [Swarm Map](https://github.com/cyborg-garden/swarm-map) for multi-tenant group access control.

## Configuration

Set these environment variables in your agent's `.env`:

```
HSM_URL=http://localhost:3002
HERMES_AGENT_NAME=hermes-personal
```

## Security Model

- **Group checks:** Fail-closed. If HSM is unreachable, group messages are denied.
- **Tool checks:** Fail-open. If HSM is not configured, all tools are allowed.

## Hooks Used

- `on_session_start` — validate group access and cache admin status
- `pre_tool_call` — gate tools based on HSM policy (future)
