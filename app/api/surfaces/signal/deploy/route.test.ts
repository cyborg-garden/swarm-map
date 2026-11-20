/**
 * Regression tests for the signal-cli daemon deploy.
 *
 * The daemon is defined once in infra/signal-cli/docker-compose.yml and deployed
 * via renderDeployedCompose(). Background: signal-cli runs in JSON-RPC daemon
 * mode (no REST /v1/about endpoint — it 404s). A stale duplicate compose string
 * in this route had drifted to the wrong image (bbernhard) with a /v1/about
 * healthcheck, so the daemon was permanently "unhealthy" and had no autoheal.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { composeFileArgs, renderDeployedCompose } from './route'

describe('signal-cli deploy compose (rendered from infra source of truth)', () => {
  const compose = renderDeployedCompose()

  it('does not use the bbernhard REST image', () => {
    expect(compose).not.toContain('bbernhard')
  })

  it('does not probe the non-existent REST /v1/about endpoint', () => {
    expect(compose).not.toContain('localhost:8080/v1/about')
  })

  it('healthchecks via the JSON-RPC endpoint with listAccounts', () => {
    expect(compose).toContain('/api/v1/rpc')
    expect(compose).toContain('listAccounts')
  })

  it('embeds a valid JSON-RPC healthcheck payload', () => {
    const match = compose.match(/-d '(\{.*?\})'/)
    expect(match).not.toBeNull()
    const payload = JSON.parse((match as RegExpMatchArray)[1].replace(/\\"/g, '"'))
    expect(payload.method).toBe('listAccounts')
    expect(payload.jsonrpc).toBe('2.0')
  })

  it('pins the build context to an absolute path (no relative build: .)', () => {
    expect(compose).toMatch(/context: \/.*infra\/signal-cli/)
    expect(compose).not.toMatch(/^\s*build: \.\s*$/m)
  })

  it('ships the host-proxy conf as a FILE that the compose bind-mounts (first-run guard)', () => {
    // The compose mounts ./host-proxy.conf onto the nginx container as a file.
    // The deploy route copies this source into ~/.hermes-swarm before `up` so
    // Docker can't auto-create the missing path as a directory (mount failure).
    // Guard the source of truth exists and is a file, and the mount is present.
    const confPath = path.join(process.cwd(), 'infra', 'signal-cli', 'host-proxy.conf')
    expect(fs.existsSync(confPath)).toBe(true)
    expect(fs.statSync(confPath).isFile()).toBe(true)
    expect(compose).toContain('./host-proxy.conf:/etc/nginx/conf.d/default.conf')
  })

  it('deploys an autoheal sidecar scoped to the daemon only', () => {
    expect(compose).toContain('signal-cli-autoheal')
    expect(compose).toContain('willfarrell/autoheal')
    // Scoped via label so it never restarts agent harness containers.
    expect(compose).toContain('AUTOHEAL_CONTAINER_LABEL=autoheal')
    expect(compose).toContain('autoheal=true')
  })
})

describe('signal-cli deploy compose files', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-deploy-'))
    const infra = path.join(root, 'infra')
    const swarm = path.join(root, 'swarm')
    fs.mkdirSync(infra)
    fs.mkdirSync(swarm)
    return { root, infra, swarm, compose: path.join(swarm, 'docker-compose.signal.yml') }
  }

  it('mounts only the default profile in the shared base file', () => {
    const compose = renderDeployedCompose()
    expect(compose).toContain('${HOME}/.hermes:${HOME}/.hermes:ro')
    expect(compose).not.toMatch(/\.hermes-(?!swarm\/)[a-z]/)
  })

  it('uses the base file alone when there is no local override, and drops a stale copy', () => {
    const { root, infra, swarm, compose } = setup()
    const stale = path.join(swarm, 'docker-compose.signal.override.yml')
    fs.writeFileSync(stale, 'services: {}\n')
    expect(composeFileArgs(infra, swarm, compose)).toEqual(['-f', compose])
    expect(fs.existsSync(stale)).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('adds the local override as a second -f, copied beside the deployed compose', () => {
    const { root, infra, swarm, compose } = setup()
    fs.writeFileSync(path.join(infra, 'docker-compose.override.yml'), 'services: {}\n')
    const dst = path.join(swarm, 'docker-compose.signal.override.yml')
    expect(composeFileArgs(infra, swarm, compose)).toEqual(['-f', compose, '-f', dst])
    expect(fs.readFileSync(dst, 'utf8')).toBe('services: {}\n')
    fs.rmSync(root, { recursive: true, force: true })
  })
})
