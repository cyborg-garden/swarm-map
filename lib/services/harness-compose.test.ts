import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applySharedVpnToCompose, removeSharedVpnFromCompose, readServicePublishedPort } from './shared-vpn'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateStandaloneCompose, validateExtraEnv, DEFAULT_CAMOFOX_IMAGE, AGENT_PIDS_LIMIT, AGENT_API_BIND_HOST, resolveApiBindHost } from './harness-compose'

describe('generateStandaloneCompose', () => {
  const agentName = 'test-agent'
  const port = 8642
  const dataDir = '/opt/hermes/test-agent'

  describe('non-VPN (default)', () => {
    it('generates compose with hermes service and ports', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain(`hermes-${agentName}:`)
      expect(result).toContain(`published: ${port}`)
      expect(result).toContain('target: 8642')
      expect(result).toContain(`container_name: hermes-${agentName}`)
    })

    it('does not include wireguard or camofox', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).not.toContain('wireguard')
      expect(result).not.toContain('camofox')
      expect(result).not.toContain('NET_ADMIN')
      expect(result).not.toContain('network_mode')
    })

    it('uses default image when no options provided', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain('image: ghcr.io/cyborg-garden/hermes-agent-mt:latest')
    })

    it('uses custom image from imageOrBuild', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        imageOrBuild: { image: 'my-registry/hermes:v2' },
      })
      expect(result).toContain('image: my-registry/hermes:v2')
    })

    it('uses build context from imageOrBuild', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        imageOrBuild: { build: '/path/to/source' },
      })
      expect(result).toContain('build:')
      expect(result).toContain('context: /path/to/source')
      expect(result).toContain('dockerfile: Dockerfile')
    })

    it('falls back to defaultImage when imageOrBuild not set', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        defaultImage: 'ghcr.io/cyborg-garden/hermes-agent-mt:v1.0',
      })
      expect(result).toContain('image: ghcr.io/cyborg-garden/hermes-agent-mt:v1.0')
    })

    it('includes security hardening', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain('cap_drop:')
      expect(result).toContain('- ALL')
      expect(result).toContain('- CHOWN')
      expect(result).toContain('- SETGID')
      expect(result).toContain('- SETUID')
      expect(result).toContain('memory: 2G')
      // s6-overlay needs exec perms on /run — no read_only, no-new-privileges, or noexec tmpfs
      expect(result).not.toContain('read_only')
      expect(result).not.toContain('no-new-privileges')
    })

    it('includes network name', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain(`name: hermes-${agentName}`)
    })
  })

  describe('VPN enabled', () => {
    const vpnOpts = { vpnEnabled: true }

    it('includes wireguard service with NET_ADMIN and SYS_MODULE', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain('wireguard:')
      expect(result).toContain('lscr.io/linuxserver/wireguard:latest')
      expect(result).toContain('NET_ADMIN')
      expect(result).toContain('SYS_MODULE')
    })

    it('includes src_valid_mark sysctl', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain('net.ipv4.conf.all.src_valid_mark=1')
    })

    it('includes camofox service with network_mode', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain('camofox:')
      expect(result).toContain('network_mode: "service:wireguard"')
      expect(result).toContain('depends_on:')
    })

    it('includes VNC environment variables on camofox', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain('ENABLE_VNC=true')
      expect(result).toContain('VNC_BIND=0.0.0.0')
      expect(result).toContain('VNC_RESOLUTION=1280x720')
      expect(result).toContain('BROWSER_IDLE_TIMEOUT_MS=3600000')
      expect(result).toContain('CAMOFOX_PORT=9377')
    })

    it('maps correct port offsets on wireguard', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      // Agent port
      expect(result).toContain(`published: ${port}`)
      expect(result).toContain('target: 8642')
      // Camofox port (port + 1000)
      expect(result).toContain(`published: ${port + 1000}`)
      expect(result).toContain('target: 9377')
      // VNC port (port + 2000)
      expect(result).toContain(`published: ${port + 2000}`)
      expect(result).toContain('target: 6080')
    })

    it('hermes service has no ports section in VPN mode', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      // The hermes service block should not have its own ports
      const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
      // ports only appear in the wireguard block, not in hermes
      expect(hermesBlock).not.toContain('ports:')
    })

    it('hermes service uses network_mode service:wireguard', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      // Both camofox and hermes should use network_mode
      const matches = result.match(/network_mode: "service:wireguard"/g)
      expect(matches).toHaveLength(2)
    })

    it('uses custom camofox image when provided', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        camofoxImage: 'my-registry/camofox:custom',
      })
      expect(result).toContain('image: my-registry/camofox:custom')
    })

    it('uses default camofox image when not provided', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain(`image: ${DEFAULT_CAMOFOX_IMAGE}`)
    })

    it('default camofox image is a real, digest-pinned reference (regression: #192)', () => {
      // The old default (ghcr.io/nimblecoai/camofox:latest) never existed on
      // GHCR under any namespace — every VPN compose was unpullable. Guard the
      // semantics, not just the string:
      // 1. never the ghost namespace again
      expect(DEFAULT_CAMOFOX_IMAGE).not.toContain('nimblecoai/camofox')
      // 2. digest-pinned so the reference cannot drift or be silently retagged
      expect(DEFAULT_CAMOFOX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/)
      // 3. not a bare :latest tag
      expect(DEFAULT_CAMOFOX_IMAGE).not.toMatch(/:latest(@|$)/)
    })

    it('preserves security hardening on hermes service', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain('cap_drop:')
      expect(result).toContain('- ALL')
      expect(result).toContain('- SETGID')
      expect(result).toContain('- SETUID')
    })

    it('mounts wg-config volume on wireguard', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain(`${dataDir}/wg-config:/config`)
    })

    it('mounts .camofox volume on camofox', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, vpnOpts)
      expect(result).toContain(`${dataDir}/.camofox:/data`)
    })
  })

  describe('VPN VNC bind security', () => {
    it('binds the VNC port to loopback (127.0.0.1) by default', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      // The human-only VNC port must not be exposed on all interfaces (LAN/tailnet).
      // Long-form publish with host_ip restricts the host bind.
      expect(result).toContain('host_ip: 127.0.0.1')
      // Still mapped to the VNC target/port — just bound to loopback
      expect(result).toContain(`published: ${port + 2000}`)
      expect(result).toContain('target: 6080')
    })

    it('binds the VNC port to a configured vncBindHost (e.g. tailnet IP)', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        vncBindHost: '100.64.0.5',
      })
      // The VNC publish (target 6080) carries the override host. The control
      // port stays on its own default (loopback) — so assert against the VNC
      // block specifically rather than a blanket absence of 127.0.0.1.
      expect(result).toMatch(/- host_ip: 100\.64\.0\.5\n {8}published: 10642\n {8}target: 6080/)
    })

    it('every published port is bind-restricted: VNC, control and the agent API', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      // Three host_ip restrictions: the human-only VNC port (6080), the
      // unauthenticated camofox control port (9377) and the agent API (8642).
      const matches = result.match(/host_ip:/g) || []
      expect(matches).toHaveLength(3)
      expect(result.match(/published:/g)).toHaveLength(3)
    })
  })

  describe('agent API port bind', () => {
    // The dashboard reaches the agent API from the host itself
    // (http://localhost:<port>/health), so a loopback publish is enough.
    it('is loopback', () => {
      expect(AGENT_API_BIND_HOST).toBe('127.0.0.1')
    })

    it('non-VPN: publishes the API port on loopback only', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toMatch(new RegExp(`^ {6}- host_ip: "127\\.0\\.0\\.1"\\n {8}published: ${port}\\n {8}target: 8642$`, 'm'))
      expect(result.match(/published:/g)).toHaveLength(1)
    })

    it('VPN: publishes the API port on loopback only', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      expect(result).toMatch(new RegExp(`^ {6}- host_ip: "127\\.0\\.0\\.1"\\n {8}published: ${port}\\n {8}target: 8642$`, 'm'))
    })

    it('VPN: the VNC and control bind hosts do not move the API port', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        vncBindHost: '100.64.0.5',
        controlBindHost: '100.64.0.7',
      })
      expect(result).toMatch(new RegExp(`- host_ip: "127\\.0\\.0\\.1"\\n {8}published: ${port}\\n {8}target: 8642`))
    })

    for (const [label, opts] of [['non-VPN', {}], ['VPN', { vpnEnabled: true }], ['shared VPN', { sharedVpn: 'private' }]] as const) {
      it(`${label}: an explicit apiBindHost is the address the API port is published on`, () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, { ...opts, apiBindHost: '100.64.0.9' })
        expect(result).toMatch(new RegExp(`host_ip: "100\\.64\\.0\\.9"\\n.*published: ${port}\\n.*target: 8642`))
        expect(result).not.toMatch(new RegExp(`host_ip: "127\\.0\\.0\\.1"\\n.*published: ${port}\\n`))
      })
    }

    it('an empty apiBindHost falls back to loopback, never to every interface', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { apiBindHost: '' })
      expect(result).toMatch(new RegExp(`- host_ip: "127\\.0\\.0\\.1"\\n {8}published: ${port}\\n`))
    })

    it('resolveApiBindHost passes an IP address through and turns anything else into loopback', () => {
      for (const ok of ['127.0.0.1', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', '100.64.0.1', '::', '1::', 'fe80::', '2001:db8::']) {
        expect(resolveApiBindHost(ok)).toBe(ok)
      }
      for (const bad of [undefined, '', ' ', '[::1]', 'a: b', '{a: b}', 'localhost', '127.0.0.1, target: 22', '127.0.0.1\n        published: 22']) {
        expect(resolveApiBindHost(bad), JSON.stringify(bad)).toBe('127.0.0.1')
      }
    })

    for (const [label, opts] of [['non-VPN', {}], ['VPN', { vpnEnabled: true }], ['shared VPN', { sharedVpn: 'private' }]] as const) {
      it(`${label}: a stored value that is not an IP address is never written; loopback is`, () => {
        for (const bad of ['[::1]', 'a: b', 'localhost', '127.0.0.1, target: 22']) {
          const result = generateStandaloneCompose(agentName, port, dataDir, { ...opts, apiBindHost: bad })
          expect(result).not.toContain(`host_ip: "${bad}`)
          expect(result).not.toContain(`host_ip: ${bad}`)
          expect(result).toMatch(new RegExp(`host_ip: "127\\.0\\.0\\.1"\\n.*published: ${port}\\n`))
        }
      })
    }

    it('an IPv6 apiBindHost is written as given', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { apiBindHost: 'fd7a:115c:a1e0::1' })
      expect(result).toContain(`      - host_ip: "fd7a:115c:a1e0::1"\n        published: ${port}\n`)
    })

    // Unquoted, an address ending in a colon is read by YAML as a mapping key
    // ("mapping values are not allowed in this context"), so the value is
    // always written as a quoted string.
    for (const [label, opts] of [['non-VPN', {}], ['VPN', { vpnEnabled: true }], ['shared VPN', { sharedVpn: 'private' }]] as const) {
      it(`${label}: an IPv6 address ending in a colon is written quoted`, () => {
        for (const addr of ['::', '1::', 'fe80::', '2001:db8::']) {
          const result = generateStandaloneCompose(agentName, port, dataDir, { ...opts, apiBindHost: addr })
          expect(result, addr).toMatch(new RegExp(`- host_ip: "${addr}"\\n.*published: ${port}\\n`))
        }
      })

      it(`${label}: the default is written quoted too`, () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toMatch(new RegExp(`- host_ip: "127\\.0\\.0\\.1"\\n.*published: ${port}\\n`))
      })
    }

    it('an address with a zone id is not an address here: loopback is written', () => {
      expect(resolveApiBindHost('fe80::1%en0')).toBe('127.0.0.1')
      const result = generateStandaloneCompose(agentName, port, dataDir, { apiBindHost: 'fe80::1%en0' })
      expect(result).not.toContain('%en0')
      expect(result).toContain(`      - host_ip: "127.0.0.1"\n        published: ${port}\n`)
    })

    it('the shared-VPN stash and restore keep the quoted line byte for byte', () => {
      for (const addr of [undefined, '::', '2001:db8::', '100.64.0.9']) {
        const plain = generateStandaloneCompose(agentName, port, dataDir, { apiBindHost: addr })
        const on = generateStandaloneCompose(agentName, port, dataDir, { apiBindHost: addr, sharedVpn: 'private' })
        expect(on).toBe(applySharedVpnToCompose(plain, agentName, port, 'private'))
        expect(removeSharedVpnFromCompose(on, agentName)).toBe(plain)
        expect(readServicePublishedPort(on, agentName)).toBe(port)
        expect(readServicePublishedPort(plain, agentName)).toBe(port)
      }
    })

    it('VPN: apiBindHost does not move the VNC or control port', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true, apiBindHost: '100.64.0.9' })
      expect(result).toMatch(/- host_ip: 127\.0\.0\.1\n {8}published: 9642\n {8}target: 9377/)
      expect(result).toMatch(/- host_ip: 127\.0\.0\.1\n {8}published: 10642\n {8}target: 6080/)
    })

    it('the first published: line is still the API port', () => {
      // Port allocation and the settings route read the first /published:\s*(\d+)/.
      for (const opts of [{}, { vpnEnabled: true }]) {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result.match(/published:\s*(\d+)/)?.[1]).toBe(String(port))
      }
    })
  })

  describe('VPN camofox control-port bind security', () => {
    it('binds the camofox control port (9377) to loopback (127.0.0.1) by default', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      // The camofox control port is unauthenticated remote browser control — it
      // must not be exposed on all interfaces. The agent reaches it in-namespace,
      // so a loopback host-publish is sufficient for host-local tooling.
      const controlBlock = result.match(/- host_ip: [^\n]+\n {8}published: 9642\n {8}target: 9377/)
      expect(controlBlock).not.toBeNull()
      expect(result).toContain(`published: ${port + 1000}`)
      expect(result).toContain('target: 9377')
    })

    it('binds the control port to a configured controlBindHost (e.g. tailnet IP)', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        controlBindHost: '100.64.0.7',
      })
      // The control publish should carry the override host on its 9377 target.
      const controlBlock = result.match(/- host_ip: 100\.64\.0\.7\n {8}published: 9642\n {8}target: 9377/)
      expect(controlBlock).not.toBeNull()
    })

    it('control and VNC bind hosts are independent', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        controlBindHost: '100.64.0.7',
        vncBindHost: '100.64.0.5',
      })
      // control port 9377 → controlBindHost; VNC port 6080 → vncBindHost
      expect(result).toMatch(/- host_ip: 100\.64\.0\.7\n {8}published: 9642\n {8}target: 9377/)
      expect(result).toMatch(/- host_ip: 100\.64\.0\.5\n {8}published: 10642\n {8}target: 6080/)
    })
  })

  describe('state-volume layout (named volume + state-init service, #204 PR2)', () => {
    const vol = `hermes-state-${agentName}`

    // A caller that passes nothing gets the layout: the generator cannot see
    // the Docker engine, and the layout is the side that cannot tear a
    // database. Call sites pass resolveUseStateVolume's answer.
    it.each([
      ['no options', undefined],
      ['non-VPN', {}],
      ['VPN', { vpnEnabled: true }],
      ['bundled ollama', { bundledOllama: true }],
      // Only an explicit false turns it off: null (a cleared setting passed
      // straight through) is ON too.
      ['non-VPN, null', { useStateVolume: null }],
      ['VPN, null', { vpnEnabled: true, useStateVolume: null }],
    ])('%s with useStateVolume left out: the layout is ON', (_label, opts) => {
      const result = generateStandaloneCompose(agentName, port, dataDir, opts)
      expect(result).toContain(`  state-init-${agentName}:`)
      expect(result).toContain(`- ${vol}:/state`)
      expect(result).toMatch(new RegExp(`state-init-${agentName}:\\s*\\n\\s*condition: service_completed_successfully`))
      expect(result).toMatch(/^volumes:\s*$/m)
    })

    it('non-VPN off (useStateVolume: false): no state-init service, no named-volume mount, no depends_on, no volumes trailer', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { useStateVolume: false })
      expect(result).not.toContain('state-init-')
      expect(result).not.toContain(`${vol}:/state`)
      expect(result).not.toContain('depends_on:')
      expect(result).not.toMatch(/^volumes:\s*$/m)
    })

    it('VPN off (useStateVolume: false): no state-init service or state volume, but the wireguard gate remains', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true, useStateVolume: false })
      expect(result).not.toContain('state-init-')
      expect(result).not.toContain(`${vol}:/state`)
      expect(result).not.toMatch(/^volumes:\s*$/m)
      const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
      expect(hermesBlock).toMatch(/^\s*depends_on:\s*$/m)
      expect(hermesBlock).toMatch(/wireguard:\s*\n\s*condition: service_started/)
      expect(hermesBlock).not.toContain('state-init-')
    })

    it('non-VPN on (useStateVolume: true): init service, volume mount, gate, and trailer', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { useStateVolume: true })
      expect(result).toContain(`  state-init-${agentName}:`)
      expect(result).toContain(`- ${vol}:/state`)
      expect(result).toMatch(new RegExp(`state-init-${agentName}:\\s*\\n\\s*condition: service_completed_successfully`))
      expect(result).toMatch(/^volumes:\s*$/m)
    })

    it('VPN on (useStateVolume: true): init service, volume, and gate coexist with wireguard', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true, useStateVolume: true })
      expect(result).toContain(`  state-init-${agentName}:`)
      expect(result).toContain(`- ${vol}:/state`)
      expect(result).toContain('volumes:')
      const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
      expect(hermesBlock).toMatch(new RegExp(`state-init-${agentName}:\\s*\\n\\s*condition: service_completed_successfully`))
      expect(hermesBlock).toMatch(/wireguard:\s*\n\s*condition: service_started/)
    })

    it('bundled ollama without the state volume keeps a depends_on: gate on the sidecar only', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { bundledOllama: true, useStateVolume: false })
      expect(result).not.toContain('state-init-')
      expect(result).not.toContain(`${vol}:/state`)
      const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
      expect(hermesBlock).toMatch(new RegExp(`ollama-${agentName}:\\s*\\n\\s*condition: service_healthy`))
      expect(hermesBlock).not.toContain('state-init-')
      expect(result).not.toMatch(/^volumes:\s*$/m)
    })
  })

  describe('agent HOME (credential/state probes must hit the mounted data dir, not /root)', () => {
    // The gateway runs as a non-root `hermes` user. If HOME is unset it falls
    // back to /root (mode 700, root-owned), so home-relative credential probes
    // (~/.claude/.credentials.json, ~/.local/state/hermes/…) raise EACCES and
    // surface as "Provider authentication failed". Pinning HOME to the mounted,
    // accessible data dir keeps every agent — built or imported — working
    // regardless of whether the image happens to define ENV HOME.
    it('sets HOME and HERMES_HOME to /opt/data in non-VPN compose', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain('HOME=/opt/data')
      expect(result).toContain('HERMES_HOME=/opt/data')
    })

    it('sets HOME and HERMES_HOME to /opt/data in VPN compose', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      expect(result).toContain('HOME=/opt/data')
      expect(result).toContain('HERMES_HOME=/opt/data')
    })
  })

  describe('bundled ollama sidecar', () => {
    describe('flag OFF (default — host-GPU ollama via host.docker.internal stays the default)', () => {
      it('non-VPN: no ollama service and no .ollama volume', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir)
        expect(result).not.toContain(`ollama-${agentName}`)
        expect(result).not.toContain('ollama/ollama')
        expect(result).not.toContain('.ollama')
        expect(result).not.toContain('qwen2.5:0.5b')
      })

      it('VPN: no ollama service and no .ollama volume', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
        expect(result).not.toContain(`ollama-${agentName}`)
        expect(result).not.toContain('ollama/ollama')
        expect(result).not.toContain('.ollama')
        expect(result).not.toContain('qwen2.5:0.5b')
      })
    })

    describe('flag ON (non-VPN)', () => {
      const opts = { bundledOllama: true }

      it('adds an ollama-{name} sidecar with the default image', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain(`ollama-${agentName}:`)
        expect(result).toContain(`container_name: ollama-${agentName}`)
        expect(result).toContain('image: ollama/ollama')
        expect(result).toContain('restart: unless-stopped')
      })

      it('uses a custom ollama image when provided', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, {
          bundledOllama: true,
          ollamaImage: 'my-registry/ollama:custom',
        })
        expect(result).toContain('image: my-registry/ollama:custom')
        expect(result).not.toContain('image: ollama/ollama')
      })

      it('mounts a model-cache volume under the agent data dir', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain(`${dataDir}/.ollama:/root/.ollama`)
      })

      it('pulls and serves qwen2.5:0.5b on boot', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain('qwen2.5:0.5b')
        expect(result).toContain('ollama serve')
        expect(result).toContain('ollama pull qwen2.5:0.5b')
      })

      it('has a healthcheck hitting the ollama API', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain('healthcheck:')
        expect(result).toContain('http://localhost:11434/api/tags')
      })

      it('hermes depends_on the ollama sidecar being healthy', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
        expect(hermesBlock).toContain(`ollama-${agentName}:`)
        expect(hermesBlock).toContain('condition: service_healthy')
      })

      it('stays CPU-only — no GPU device reservations', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).not.toContain('devices:')
        expect(result).not.toContain('driver: nvidia')
        expect(result).not.toContain('capabilities: [gpu]')
      })
    })

    describe('flag ON (VPN)', () => {
      const opts = { vpnEnabled: true, bundledOllama: true }

      it('adds an ollama-{name} sidecar on the wireguard service network', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain(`ollama-${agentName}:`)
        expect(result).toContain('image: ollama/ollama')
        // sidecars in VPN mode share the wireguard network namespace
        const matches = result.match(/network_mode: "service:wireguard"/g)
        // wireguard hosts: camofox, hermes, AND ollama → 3
        expect(matches).toHaveLength(3)
      })

      it('pulls and serves qwen2.5:0.5b on boot in VPN mode', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain('qwen2.5:0.5b')
        expect(result).toContain('ollama serve')
      })

      it('mounts the model-cache volume in VPN mode', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(result).toContain(`${dataDir}/.ollama:/root/.ollama`)
      })

      it('hermes depends_on ollama being healthy in VPN mode', () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        const hermesBlock = result.split(`hermes-${agentName}:`).pop()!
        expect(hermesBlock).toContain(`ollama-${agentName}:`)
        expect(hermesBlock).toContain('condition: service_healthy')
      })
    })
  })

  describe('resource limits (memory/cpu) — configurable per harness', () => {
    it('non-VPN: defaults to 2G / 2.0 when no resources provided', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).toContain('memory: 2G')
      expect(result).toContain("cpus: '2.0'")
    })

    it('VPN: defaults to 2G / 2.0 when no resources provided', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      expect(result).toContain('memory: 2G')
      expect(result).toContain("cpus: '2.0'")
    })

    it('non-VPN: renders provided memory and cpus limits', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { memory: '6G', cpus: '4.0' })
      expect(result).toContain('memory: 6G')
      expect(result).toContain("cpus: '4.0'")
      expect(result).not.toContain('memory: 2G')
      expect(result).not.toContain("cpus: '2.0'")
    })

    it('VPN: renders provided memory and cpus limits', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, {
        vpnEnabled: true,
        memory: '6G',
        cpus: '4.0',
      })
      expect(result).toContain('memory: 6G')
      expect(result).toContain("cpus: '4.0'")
      expect(result).not.toContain('memory: 2G')
      expect(result).not.toContain("cpus: '2.0'")
    })

    it('renders only the provided field, defaulting the other', () => {
      const memOnly = generateStandaloneCompose(agentName, port, dataDir, { memory: '8G' })
      expect(memOnly).toContain('memory: 8G')
      expect(memOnly).toContain("cpus: '2.0'")

      const cpuOnly = generateStandaloneCompose(agentName, port, dataDir, { cpus: '3.0' })
      expect(cpuOnly).toContain('memory: 2G')
      expect(cpuOnly).toContain("cpus: '3.0'")
    })
  })

  describe('process-count limit', () => {
    // The agent service's own block: from its key to the next 2-space key or
    // top-level key.
    const agentBlock = (compose: string): string => {
      const lines = compose.split('\n')
      const start = lines.indexOf(`  hermes-${agentName}:`)
      expect(start).toBeGreaterThan(-1)
      let end = start + 1
      while (end < lines.length && (lines[end].trim() === '' || /^ {3,}/.test(lines[end]))) end++
      return lines.slice(start, end).join('\n')
    }

    it('is a generous whole number, well above the sealed lab cell', () => {
      expect(Number.isInteger(AGENT_PIDS_LIMIT)).toBe(true)
      expect(AGENT_PIDS_LIMIT).toBeGreaterThanOrEqual(1024)
      expect(AGENT_PIDS_LIMIT).toBeLessThanOrEqual(4096)
    })

    for (const [label, opts] of [['non-VPN', {}], ['VPN', { vpnEnabled: true }]] as const) {
      it(`${label}: the agent service carries the limit once, under deploy.resources.limits`, () => {
        const result = generateStandaloneCompose(agentName, port, dataDir, opts)
        expect(agentBlock(result)).toMatch(
          new RegExp(`^ {4}deploy:\\n {6}resources:\\n {8}limits:\\n(?: {10}.*\\n)*? {10}pids: ${AGENT_PIDS_LIMIT}$`, 'm'),
        )
        expect(result.match(/^\s+pids:/gm)).toHaveLength(1)
        // `docker compose` rejects a service that has a deploy.resources.limits
        // block and a service-level pids_limit beside it, so that form is
        // never emitted.
        expect(result).not.toContain('pids_limit')
      })
    }

    it('does not change with the memory and cpu settings', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { memory: '6G', cpus: '4.0' })
      expect(result).toContain(`          pids: ${AGENT_PIDS_LIMIT}\n`)
    })
  })

  describe('regression: non-VPN output matches original format', () => {
    it('contains all expected sections in order', () => {
      const result = generateStandaloneCompose('myagent', 8652, '/data/myagent')
      const lines = result.split('\n')
      // Header comment
      expect(lines[0]).toBe('# Generated by hermes-swarm-map — agent: myagent')
      // Services section
      expect(result).toContain('services:')
      expect(result).toContain('hermes-myagent:')
      // s6-overlay drops privs internally — no user: directive
      expect(result).not.toContain('user:')
      expect(result).toContain('restart: unless-stopped')
      expect(result).toContain('host.docker.internal:host-gateway')
      expect(result).toContain('/data/myagent/.env')
      expect(result).toContain('published: 8652')
      expect(result).toContain('/data/myagent:/opt/data')
      expect(result).toContain('command: gateway')
      expect(result).toContain('networks:')
      expect(result).toContain('name: hermes-myagent')
    })
  })
})

describe('extraEnv on an agent on the GitHub broker', () => {
  const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('')
  let marked: string
  let plain: string
  beforeEach(() => {
    marked = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-marked-'))
    fs.writeFileSync(path.join(marked, '.hsm-github-broker'), '')
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-plain-'))
  })
  afterEach(() => {
    fs.rmSync(marked, { recursive: true, force: true })
    fs.rmSync(plain, { recursive: true, force: true })
  })

  it.each(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_APP_PRIVATE_KEY_B64'])('refuses %s, whatever it holds', (name) => {
    expect(validateExtraEnv({ [name]: 'x' }, marked)).toMatch(/GitHub token broker/)
    expect(() => generateStandaloneCompose('wren', 3000, marked, { extraEnv: { [name]: 'x' } })).toThrow(/GitHub token broker/)
  })

  it('refuses a GitHub token under any name, and does not print it', () => {
    const problem = validateExtraEnv({ MY_THING: fakeToken }, marked)
    expect(problem).toMatch(/MY_THING/)
    expect(problem).not.toContain(fakeToken)
  })

  it('counts an agent with only the secret file as on the broker', () => {
    fs.writeFileSync(path.join(plain, 'github-broker.json'), '{}')
    expect(validateExtraEnv({ GH_TOKEN: 'x' }, plain)).toMatch(/GitHub token broker/)
  })

  it('leaves other variables and agents not on the broker alone', () => {
    expect(validateExtraEnv({ HERON_INTAKE_DIR: '/opt/x' }, marked)).toBeNull()
    expect(validateExtraEnv({ GH_TOKEN: 'x' }, plain)).toBeNull()
    expect(validateExtraEnv({ GH_TOKEN: 'x' })).toBeNull()
  })
})
