// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import path from 'path'

// ecosystem.config.js reads the platform and HSM_BIND_HOST once, when pm2
// loads it, so each case loads it in a fresh node process.
const CONFIG = path.join(__dirname, 'ecosystem.config.js')

function load(env: Record<string, string | undefined>, platform?: string) {
  const fake = platform ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });` : ''
  const base = { ...process.env }
  delete base.HSM_BIND_HOST
  return spawnSync(process.execPath, ['-e', `${fake}process.stdout.write(require(${JSON.stringify(CONFIG)}).apps[0].args)`], {
    env: { ...base, ...env },
    encoding: 'utf-8',
  })
}

describe('ecosystem.config.js bind address', () => {
  it('listens on loopback on macOS by default', () => {
    expect(load({}, 'darwin').stdout).toBe('start --hostname 127.0.0.1')
  })

  it('keeps all interfaces on Linux, where agents reach the host over the bridge', () => {
    expect(load({}, 'linux').stdout).toBe('start --hostname 0.0.0.0')
  })

  it('HSM_BIND_HOST overrides on either platform', () => {
    expect(load({ HSM_BIND_HOST: '0.0.0.0' }, 'darwin').stdout).toBe('start --hostname 0.0.0.0')
    expect(load({ HSM_BIND_HOST: '::1' }, 'linux').stdout).toBe('start --hostname ::1')
  })

  it('refuses anything but a bare IP, before pm2 starts anything', () => {
    for (const bad of ['localhost', '[::1]', 'fe80::1%en0', '127.0.0.1 --port 1']) {
      const r = load({ HSM_BIND_HOST: bad }, 'darwin')
      expect(r.status, bad).not.toBe(0)
      expect(r.stderr, bad).toContain('HSM_BIND_HOST must be a bare IP address')
    }
  })

  it('pm2:reapply checks the config before it deletes the running app', () => {
    const script = JSON.parse(execFileSync(process.execPath, ['-p', `JSON.stringify(require(${JSON.stringify(path.join(__dirname, 'package.json'))}).scripts['pm2:reapply'])`], { encoding: 'utf-8' }))
    expect(script.indexOf("require('./ecosystem.config.js')")).toBeGreaterThanOrEqual(0)
    expect(script.indexOf("require('./ecosystem.config.js')")).toBeLessThan(script.indexOf('pm2 delete'))
    expect(script).toMatch(/ecosystem\.config\.js'\)" && /)
  })
})
