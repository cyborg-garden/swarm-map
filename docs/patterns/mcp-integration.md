# Adding an MCP Integration to Swarm Map

The repeatable pattern for wiring a new MCP server into the Swarm Map deploy pipeline. Follow these steps and agents get the server's tools on deploy.

## Overview

Swarm Map configures MCP servers in four steps:
1. **Setup wizard:** the user turns the integration on with a checkbox.
2. **Deploy route:** writes the server's secrets to the agent `.env` and adds the server to `mcpServers`.
3. **Config template:** `generateDefaultConfig()` in `lib/templates/config-yaml.ts` emits the `mcp_servers:` YAML section.
4. **Agent startup:** Hermes reads `config.yaml` and launches the MCP server as a subprocess with its env vars.

## Step-by-Step

### 1. Add wizard state (`app/(setup)/setup/wizard/page.tsx`)

Add a boolean to `WizardState`:
```typescript
  myMcpEnabled: boolean
```

Existing flags to copy: `githubMcpEnabled`, `notionEnabled`, `googleEnabled`.

Add to `INITIAL_STATE`:
```typescript
  myMcpEnabled: false,
```

Add checkbox UI in the Platforms step (follow the Google and GitHub pattern):
```tsx
<div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
  <label className="flex items-center gap-3 cursor-pointer">
    <input type="checkbox" checked={state.myMcpEnabled}
      onChange={(e) => update({ myMcpEnabled: e.target.checked })}
      className="accent-[var(--accent)]" />
    <div>
      <div className="font-medium text-sm">My MCP</div>
      <div className="text-xs text-muted-foreground">Description</div>
    </div>
  </label>
</div>
```

Pass to deploy POST: `myMcpEnabled: state.myMcpEnabled,`

Add to summary section.

### 2. Handle in deploy route (`app/api/setup/deploy/route.ts`)

Parse the flag:
```typescript
const myMcpEnabled = body.myMcpEnabled === true
```

Add to the `mcpServers` object:
```typescript
if (myMcpEnabled) {
  mcpServers.myMcp = {
    command: 'npx',
    args: ['-y', '@my-org/server-my-mcp'],
    env: { MY_API_KEY: '${MY_API_KEY}' },
  }
}
```

If the MCP needs Docker volumes or port mappings (google-mcp needs them for OAuth), add them in the compose generator (`lib/services/harness-compose.ts`).

If the MCP only needs an env var (like GitHub), write it to the agent `.env` in `generateEnvContent()` (`lib/services/agent-deploy-templates.ts`).

### 3. Env var mapping

MCP servers often expect env var names different from what Swarm Map stores. Map them:

| Swarm Map name | MCP expected env var | MCP server |
|---|---|---|
| `GITHUB_TOKEN` | `GITHUB_PERSONAL_ACCESS_TOKEN` | server-github |
| `NOTION_API_KEY` | `NOTION_TOKEN` | notion-mcp-server |
| (Google OAuth tokens) | (volume-mounted) | google-mcp |

Map in one of two places. GitHub writes `GITHUB_PERSONAL_ACCESS_TOKEN` as a literal line in the agent `.env`. Notion maps in the server's `env` block in `config.yaml` (`NOTION_TOKEN: '${NOTION_API_KEY}'`).

Do **not** map in the compose `environment:` block. That block resolves `${VAR}` from the empty host process env and takes precedence over `env_file`, so it would blank the value.

### 4. Test

Add test cases to `lib/templates/config-yaml.test.ts` verifying:
- Config includes `mcp_servers.myMcp` when enabled.
- Config excludes it when disabled.
- Env var references use `${VAR}` syntax, never literal tokens.

### Reference implementations

- **GitHub** (env var only): command, args and one env passthrough.
- **Notion** (env var only): same shape as GitHub.
- **Google** (volumes, ports, OAuth): needs Docker volume mounts, a port mapping for the OAuth callback, and host directory resolution.
