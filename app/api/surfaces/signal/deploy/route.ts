import { NextResponse } from 'next/server'
import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getSignalDaemonUrl } from '@/lib/env-helpers'

// The signal-cli daemon is defined ONCE, in infra/signal-cli/docker-compose.yml
// (build -> native signal-cli daemon image, correct JSON-RPC healthcheck, scoped
// autoheal sidecar). This route deploys THAT file instead of duplicating a
// compose string here. A stale duplicate previously drifted to the wrong image
// (bbernhard/signal-cli-rest-api) with a /v1/about healthcheck that 404s in
// daemon mode — keeping a single source of truth prevents that class of bug.
export function renderDeployedCompose(): string {
  const infraDir = path.join(process.cwd(), 'infra', 'signal-cli')
  const src = fs.readFileSync(path.join(infraDir, 'docker-compose.yml'), 'utf8')
  // `build: .` is relative to the infra dir, but the deployed copy lives in
  // ~/.hermes-swarm, so pin the build context to an absolute path.
  return src.replace(
    /^( *)build: \.\s*$/m,
    `$1build:\n$1  context: ${infraDir}\n$1  dockerfile: Dockerfile`,
  )
}

export async function POST() {
  try {
    // Check if already running
    try {
      const ps = execSync('docker ps --filter name=signal-cli-daemon --format "{{.Status}}"', { timeout: 5000 }).toString().trim()
      if (ps.includes('Up')) {
        return NextResponse.json({ status: 'already_running', healthy: true })
      }
    } catch { /* docker not available or container not found */ }

    // Ensure network exists
    try {
      execSync('docker network create hermes-net 2>/dev/null || true', { timeout: 5000 })
    } catch { /* already exists */ }

    // Write compose file (rendered from the single source of truth in infra/)
    const swarmDir = path.join(os.homedir(), '.hermes-swarm')
    fs.mkdirSync(swarmDir, { recursive: true })
    fs.mkdirSync(path.join(swarmDir, 'signal-data'), { recursive: true })
    const composePath = path.join(swarmDir, 'docker-compose.signal.yml')
    fs.writeFileSync(composePath, renderDeployedCompose())

    // The compose runs with cwd=swarmDir and bind-mounts `./host-proxy.conf` as a
    // FILE onto the nginx container. If that file is absent when the container is
    // first created, Docker silently creates it as an empty DIRECTORY and the
    // mount then fails ("not a directory"). Copy the real conf beside the compose
    // (and self-heal a previously auto-created directory) so first-run works.
    const infraDir = path.join(process.cwd(), 'infra', 'signal-cli')
    const proxyConfDst = path.join(swarmDir, 'host-proxy.conf')
    try {
      if (fs.existsSync(proxyConfDst) && fs.statSync(proxyConfDst).isDirectory()) {
        fs.rmSync(proxyConfDst, { recursive: true, force: true })
      }
    } catch { /* best-effort cleanup */ }
    fs.copyFileSync(path.join(infraDir, 'host-proxy.conf'), proxyConfDst)

    // Remove old container if stopped
    try {
      execSync('docker rm signal-cli-daemon 2>/dev/null || true', { timeout: 5000 })
    } catch { /* nothing to remove */ }

    // Start (build the native image on first deploy; cached thereafter)
    execFileSync('docker', ['compose', '-f', composePath, 'up', '-d', '--build'], { timeout: 180000, cwd: swarmDir })

    // Poll for health via JSON-RPC (up to 90 seconds — accounts take time to load)
    const signalUrl = getSignalDaemonUrl()
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const res = await fetch(`${signalUrl}/api/v1/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'listAccounts', id: 'health' }),
          signal: AbortSignal.timeout(3000),
        })
        if (res.ok) {
          return NextResponse.json({ status: 'started', healthy: true })
        }
      } catch { /* not ready yet */ }
    }

    return NextResponse.json({ status: 'started', healthy: false })
  } catch (err) {
    return NextResponse.json({ status: 'failed', error: String(err) }, { status: 500 })
  }
}
