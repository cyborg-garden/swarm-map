// pm2 loads this file as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isIP } = require('net')

const bindHost = process.env.HSM_BIND_HOST || (process.platform === 'darwin' ? '127.0.0.1' : '0.0.0.0')
if (isIP(bindHost) === 0 || bindHost.includes('%')) {
  throw new Error(`HSM_BIND_HOST must be a bare IP address, got ${JSON.stringify(bindHost)}`)
}

module.exports = {
  apps: [
    {
      name: 'hermes-swarm-map',
      // Point at Next's real JS entry, not node_modules/.bin/next: under pnpm
      // the .bin entry is a /bin/sh shim, which crashes when pm2 runs it through
      // the node interpreter ("SyntaxError: missing ) after argument list").
      // dist/bin/next has a `#!/usr/bin/env node` shebang and is layout-agnostic.
      script: 'node_modules/next/dist/bin/next',
      // Loopback by default. Everything that talks to HSM is on this host:
      // cloudflared (hsm.<domain>, behind Cloudflare Access), the host-side
      // gates, and agent containers via host.docker.internal (Docker Desktop
      // and OrbStack forward that to the host's loopback). Listening on
      // 0.0.0.0 let anyone on the LAN skip the Access login. For remote use,
      // tunnel: `ssh -L 3000:127.0.0.1:3000 <host>`.
      // Linux keeps 0.0.0.0: there host.docker.internal is the docker bridge
      // IP, which cannot reach a loopback listener.
      // HSM_BIND_HOST overrides; it is read from the shell that runs
      // `pm2 start`, not from .env. pm2 caches args: after changing this, run
      // `pnpm pm2:reapply` (a plain `pm2 restart` keeps the old binding).
      args: `start --hostname ${bindHost}`,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
