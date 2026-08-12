import { describe, it, expect } from 'vitest'
import { generateStandaloneCompose, DEFAULT_CAMOFOX_IMAGE } from './harness-compose'

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

    it('the VNC and control ports are bind-restricted — only the agent gateway stays broadly reachable', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir, { vpnEnabled: true })
      // Two host_ip restrictions: the human-only VNC port (6080) AND the
      // unauthenticated camofox control port (9377). The agent gateway (8642)
      // remains on the default bind so HSM can reach it.
      const matches = result.match(/host_ip:/g) || []
      expect(matches).toHaveLength(2)
    })

    it('does not introduce host_ip in non-VPN compose', () => {
      const result = generateStandaloneCompose(agentName, port, dataDir)
      expect(result).not.toContain('host_ip')
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
