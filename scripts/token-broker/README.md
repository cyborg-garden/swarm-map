# GitHub token broker

Fleet agents get GitHub access from a small service on the host instead of holding
a key or a PAT. The host keeps the one GitHub App private key in a single 0600 file.
Each agent holds only a secret that can ask for its own token, which lasts an hour.

```
agent's git/gh ──> hermes_cli/github_app_token.py ──POST /v1/token──> broker ──> GitHub
                   secret in github-broker.json     host.docker.internal        App key
```

## Why a local port and not a unix socket

The first design used one bind-mounted unix socket per agent. It doesn't fit here:

- A socket crossing Docker Desktop's VM needs a host socket forwarder that depends
  on mount syntax and Desktop version, and a broker restart leaves a stale inode.
- It needs a new mount on every agent, and new mounts have wedged the fleet before.
- Agents share a VPN network namespace, so a network address can't identify one.

So the broker listens on `127.0.0.1:8799` and each agent proves who it is with a
secret in its own home. No mount or compose change is needed. Containers reach the
host's loopback through `host.docker.internal`, the same route as other host
services, and the VPN firewall already allows it.

## Files

On the host, in `~/.config/hermes/github-app/`:

| File | What it is |
| --- | --- |
| `private-key.pem` | The App key, 0600. Read per mint, so a change needs no restart. |
| `registry.json` | Agent to secret hash, repos and permissions. Read per request. A typo keeps the last good copy in use and turns the check red. See `registry.example.json`. |
| `audit.jsonl` | Every mint, cache hit and denial. Events only, never a value. |
| `env-backups/` | Each agent's old `.env`, for undo. Holds real secrets, so `ghkey purge` it once settled. |

In each agent's home: `github-broker.json` (URL and secret) and an empty
`.hsm-github-broker` marker. HSM won't write a GitHub credential to a marked agent.

## Commands

`ghkey` runs on the laptop. `ghkey install` puts it at `~/bin/ghkey`.

| Command | What it does |
| --- | --- |
| `ghkey` | Change the App key. Click Generate on GitHub first. |
| `ghkey setup <app_id> <installation_id>` | Install or update the broker on the host. |
| `ghkey roll <agent> [--apply] [--accept-loss]` | Move one agent. A dry run without `--apply`. |
| `ghkey undo <agent>` | Put an agent's GitHub lines back and take it off the broker. Other changes to its `.env` since the move stay. |
| `ghkey check` | Show the health result: credentials found, agents left to move, key age. |
| `ghkey purge` | Delete the `.env` backups. |

The same health result is on `GET /api/integrity`, in a banner on the harnesses page,
and in the pm2 error log. It names variables and never prints values. Once this host
has the broker, any agent holding a GitHub credential raises it, marked or not. Agents
still to move keep the banner up until they are moved. A host with no broker stays quiet.

A deploy with a GitHub token is refused once the broker is on the host.

## Rules worth knowing

- `roll` never builds. If an image lacks the broker code it stops and asks for an
  HSM rebuild, because a hand-run build blinds the drift check.
- `roll` checks git and gh as the `hermes` user with `HOME=/opt/data/home`, where
  agents really run them, against a private repo. Any failure restores the agent.
- A broker failure doesn't fall back to App credentials in `.env`, so a broken setup
  stays visible.
- Don't delete the old App key on GitHub while an agent's `.env` still has it, or
  while you might want to undo. `ghkey` warns you.
