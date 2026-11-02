// @vitest-environment node
/**
 * PUT /api/harnesses/:id/settings — the shared VPN toggle, end to end on real
 * files in a tmp dir (real compose generators, real transforms). Only the
 * process-level side effects (docker bring-up, container recreate) are mocks.
 *
 * Why a separate file: route.test.ts stubs fs wholesale and the compose
 * generator, so it cannot see the bytes this feature is about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const holder = vi.hoisted(() => ({
  harness: undefined as Record<string, unknown> | undefined,
  dataDir: '',
}))

vi.mock('@/lib/services', () => ({
  services: {
    harness: {
      restart: vi.fn(),
      get: vi.fn(() => holder.harness),
      updateConfig: vi.fn(),
    },
    config: { getSettings: vi.fn(() => ({ dataDir: holder.dataDir })) },
    surfaceAdmins: { syncFromAllowlist: vi.fn() },
    docker: { upNoRecreate: vi.fn(), validateCompose: vi.fn() },
  },
}))
vi.mock('@/lib/resolvers', () => ({
  resolveIdentifier: vi.fn(async () => null),
  expandSignalAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandTelegramAllowlist: vi.fn(async (_id: string, users: string[]) => users),
  expandDiscordAllowlist: vi.fn(async (_id: string, users: string[]) => users),
}))

import { GET, PUT } from './route'
import { expandSignalAllowlist } from '@/lib/resolvers'
import { services } from '@/lib/services'
import { generateAgentCompose } from '@/lib/services/agent-deploy-templates'
import { generateStandaloneCompose } from '@/lib/services/harness-compose'
import {
  applySharedVpnToCompose,
  composeSharedVpnState,
  SHARED_VPN_PROJECT,
} from '@/lib/services/shared-vpn'

const NAME = 'vera'
const ID = 'h_vera'
const PORT = 8722

function params() {
  return { params: Promise.resolve({ id: ID }) }
}
function put(body: unknown): Request {
  return new Request(`http://localhost/api/harnesses/${ID}/settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

// What both UI clients PUT back: the whole document. The policy fields match
// what the .env below already says, so only the field under test differs.
const BASE = {
  dmPolicy: 'approved-only',
  groupInvitePolicy: 'approved-only',
  mentionGating: true,
  commandApprovalAdminOnly: true,
  memoryScope: 'channel',
  vpnEnabled: false,
}

describe('Settings PUT — shared VPN', () => {
  let tmp: string
  let agentDir: string
  let composeFile: string
  let swarmDir: string
  let vpnEnv: string

  function writeAgent(compose: string, env = `API_SERVER_PORT=${PORT}\nVPN_ENABLED=false\n`) {
    fs.writeFileSync(composeFile, compose)
    fs.writeFileSync(path.join(agentDir, '.env'), env)
  }
  const readCompose = () => fs.readFileSync(composeFile, 'utf-8')
  const readEnv = () => fs.readFileSync(path.join(agentDir, '.env'), 'utf-8')

  beforeEach(() => {
    vi.clearAllMocks()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-shared-vpn-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tmp)
    agentDir = path.join(tmp, `.hermes-${NAME}`)
    swarmDir = path.join(tmp, '.hermes-swarm-map')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.mkdirSync(path.join(swarmDir, 'compose', NAME), { recursive: true })
    fs.mkdirSync(path.join(swarmDir, 'vpn'), { recursive: true })
    vpnEnv = path.join(swarmDir, 'vpn', 'gluetun.env')
    fs.writeFileSync(vpnEnv, 'VPN_SERVICE_PROVIDER=mullvad\n', { mode: 0o600 })
    composeFile = path.join(swarmDir, 'compose', NAME, 'docker-compose.yml')
    holder.dataDir = swarmDir
    holder.harness = { id: ID, name: NAME, runtime: 'hermes', composeFile }
    writeAgent(generateAgentCompose(NAME, PORT, agentDir, { build: '/src/hermes-agent-mt' }))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('turning it on joins the shared namespace, keeps hardening, starts gluetun, recreates the agent', async () => {
    const before = readCompose()
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(200)
    const after = readCompose()
    expect(after).toBe(applySharedVpnToCompose(before, NAME, PORT))
    expect(after).toContain('    read_only: true')
    // The gluetun compose is written and brought up WITHOUT recreating an
    // existing gluetun (recreating it would cut every joined agent off).
    const vpnCompose = path.join(swarmDir, 'vpn', 'docker-compose.yml')
    expect(fs.existsSync(vpnCompose)).toBe(true)
    expect(fs.readFileSync(vpnCompose, 'utf-8')).toContain(`- ${vpnEnv}`)
    expect(services.docker.upNoRecreate).toHaveBeenCalledWith(vpnCompose, SHARED_VPN_PROJECT)
    expect(services.harness.restart).toHaveBeenCalledWith(ID, 'recreate')
    const data = await res.json()
    expect(data.restarted).toBe(true)
  })

  it('the secret env file is never read or rewritten', async () => {
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    await PUT(put({ ...BASE, sharedVpn: true }), params())
    const touched = (spy: typeof readSpy | typeof writeSpy) =>
      spy.mock.calls.some((c) => String(c[0]) === vpnEnv)
    expect(touched(readSpy)).toBe(false)
    expect(touched(writeSpy)).toBe(false)
  })

  it('GET reports it, and the settings version changes so a stale whole-document PUT cannot revert it', async () => {
    // Warm-up save so the .env already holds every policy line: from here on
    // the toggle is the ONLY thing that changes, so a version change can only
    // come from the shared-VPN fingerprint, not from the .env mtime.
    await PUT(put({ ...BASE, sharedVpn: false }), params())
    const v0 = (await (await GET(new Request('http://x'), params())).json()).version
    const envBefore = readEnv()
    await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(readEnv()).toBe(envBefore)
    const got = await (await GET(new Request('http://x'), params())).json()
    expect(got.sharedVpn).toBe(true)
    expect(got.version).not.toBe(v0)
    // A client holding the pre-toggle snapshot is refused rather than silently
    // turning the VPN back off.
    const stale = await PUT(put({ ...BASE, sharedVpn: false, version: v0 }), params())
    expect(stale.status).toBe(409)
    expect(composeSharedVpnState(readCompose(), NAME)).toBe('on')
  })

  it('turning it off restores the original compose byte-for-byte', async () => {
    const original = readCompose()
    await PUT(put({ ...BASE, sharedVpn: true }), params())
    vi.clearAllMocks()
    const res = await PUT(put({ ...BASE, sharedVpn: false }), params())
    expect(res.status).toBe(200)
    expect(readCompose()).toBe(original)
    expect(services.harness.restart).toHaveBeenCalledWith(ID, 'recreate')
    // Off never touches gluetun: other agents may still be on it.
    expect(services.docker.upNoRecreate).not.toHaveBeenCalled()
  })

  it('an unrelated whole-document save with sharedVpn unchanged does not rewrite the compose or recreate', async () => {
    await PUT(put({ ...BASE, sharedVpn: true }), params())
    const on = readCompose()
    vi.clearAllMocks()
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(200)
    expect(readCompose()).toBe(on)
    expect(services.harness.restart).not.toHaveBeenCalled()
    expect(services.docker.upNoRecreate).not.toHaveBeenCalled()
  })

  it('refuses (409, nothing written, nothing started) when the gluetun env file is missing', async () => {
    fs.rmSync(vpnEnv)
    const compose = readCompose()
    const env = readEnv()
    const res = await PUT(put({ ...BASE, sharedVpn: true, mentionGating: false }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/gluetun\.env/)
    expect(readCompose()).toBe(compose)
    expect(readEnv()).toBe(env)
    expect(services.docker.upNoRecreate).not.toHaveBeenCalled()
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('a gluetun start failure returns a fixed 502 that never echoes docker output', async () => {
    vi.mocked(services.docker.upNoRecreate).mockImplementationOnce(() => {
      throw new Error('line 3: unexpected character "SECRETKEYMATERIAL" in variable name')
    })
    const compose = readCompose()
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('SECRETKEYMATERIAL')
    expect(readCompose()).toBe(compose)
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('refuses (nothing written) when docker compose rejects the transformed file, without echoing it', async () => {
    vi.mocked(services.docker.validateCompose).mockImplementationOnce(() => { throw new Error('GITHUB_TOKEN=ghx') })
    const compose = readCompose()
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain('ghx')
    expect(readCompose()).toBe(compose)
    expect(services.docker.upNoRecreate).not.toHaveBeenCalled()
  })

  it('an in-flight stale PUT cannot undo a toggle that landed while it awaited the resolvers', async () => {
    await PUT(put({ ...BASE, sharedVpn: false, surfaces: {} }), params()) // warm-up: .env stable
    const v0 = (await (await GET(new Request('http://x'), params())).json()).version
    // B (stale, sharedVpn:false) is mid-await when A turns the VPN on.
    vi.mocked(expandSignalAllowlist).mockImplementationOnce(async (_id: string, users: string[]) => {
      const a = await PUT(put({ ...BASE, sharedVpn: true }), params())
      expect(a.status).toBe(200)
      return users
    })
    const b = await PUT(put({
      ...BASE, sharedVpn: false, version: v0,
      surfaces: { signal: { allowedUsers: ['+15550000000'], adminUsers: [], allowedGroups: [], allowAll: false, allowAllGroups: false } },
    }), params())
    if (b.status === 200) {
      // Only acceptable if B never touched the compose.
      expect(composeSharedVpnState(readCompose(), NAME)).toBe('on')
    } else {
      expect(b.status).toBe(409)
      expect(composeSharedVpnState(readCompose(), NAME)).toBe('on')
    }
  })

  it('refuses an .env API_SERVER_PORT that disagrees with the agent\'s port', async () => {
    writeAgent(readCompose(), 'API_SERVER_PORT=8642\nVPN_ENABLED=false\n')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/API_SERVER_PORT=8642/)
  })

  it('refuses a fixed-port platform (webhook) enabled in config.yaml', async () => {
    fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'platforms:\n  webhook:\n    enabled: true\n')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/webhook/)
  })

  it('never overwrites an existing gluetun compose (operator edits survive)', async () => {
    const vpnCompose = path.join(swarmDir, 'vpn', 'docker-compose.yml')
    fs.writeFileSync(vpnCompose, '# operator edited\n')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(200)
    expect(fs.readFileSync(vpnCompose, 'utf-8')).toBe('# operator edited\n')
  })

  it('refuses an `export`-prefixed .env port that hermes would honor over the pin', async () => {
    writeAgent(readCompose(), 'export API_SERVER_PORT=8642\nVPN_ENABLED=false\n')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
  })

  it('refuses an agent with profiles (each runs its own unchecked gateway)', async () => {
    fs.mkdirSync(path.join(agentDir, 'profiles', 'side'), { recursive: true })
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/profiles/)
  })

  it('refuses a compose that loads other env files', async () => {
    writeAgent(readCompose().replace(`      - ${agentDir}/.env\n`, `      - ${agentDir}/.env\n      - /etc/shared.env\n`))
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/shared\.env/)
  })

  it('refuses a legacy gateway.json (its platforms cannot be checked)', async () => {
    fs.writeFileSync(path.join(agentDir, 'gateway.json'), '{}')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/gateway\.json/)
  })

  it('refuses while the per-agent wireguard VPN is on', async () => {
    writeAgent(readCompose(), `API_SERVER_PORT=${PORT}\nVPN_ENABLED=true\n`)
    const res = await PUT(put({ ...BASE, vpnEnabled: true, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect(composeSharedVpnState(readCompose(), NAME)).toBe('off')
  })

  it('refuses turning the wireguard VPN on while the shared VPN is on', async () => {
    await PUT(put({ ...BASE, sharedVpn: true }), params())
    const on = readCompose()
    const res = await PUT(put({ ...BASE, sharedVpn: true, vpnEnabled: true }), params())
    expect(res.status).toBe(409)
    expect(readCompose()).toBe(on)
    expect(readEnv()).toMatch(/^VPN_ENABLED=false$/m)
  })

  it('refuses when config.yaml pins an API port every VPN\'d agent would share', async () => {
    fs.writeFileSync(path.join(agentDir, 'config.yaml'),
      'platforms:\n  api_server:\n    enabled: true\n    extra:\n      host: 0.0.0.0\n      port: 8642\n')
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/8642/)
    expect(composeSharedVpnState(readCompose(), NAME)).toBe('off')
  })

  it('refuses a bundled-ollama compose', async () => {
    writeAgent(generateAgentCompose(NAME, PORT, agentDir, { image: 'x' }, { bundledOllama: true }))
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ollama/i)
  })

  it('a hand-made network_mode is reported off and left alone by an unrelated save', async () => {
    const handMade = readCompose().replace(
      '    extra_hosts:\n      - "host.docker.internal:host-gateway"\n',
      '    network_mode: "container:gluetun-vera"\n',
    )
    writeAgent(handMade)
    const got = await (await GET(new Request('http://x'), params())).json()
    expect(got.sharedVpn).toBe(false)
    const res = await PUT(put({ ...BASE, sharedVpn: false, mentionGating: false }), params())
    expect(res.status).toBe(200)
    expect(readCompose()).toBe(handMade)
  })

  it('a hand-made network_mode refuses an explicit turn-on (migrate it first)', async () => {
    const handMade = readCompose().replace(
      '    extra_hosts:\n      - "host.docker.internal:host-gateway"\n',
      '    network_mode: "container:gluetun-vera"\n',
    )
    writeAgent(handMade)
    const res = await PUT(put({ ...BASE, sharedVpn: true }), params())
    expect(res.status).toBe(409)
    expect(readCompose()).toBe(handMade)
  })

  describe('standalone composes (the generator regenerates them on a resources change)', () => {
    beforeEach(() => {
      writeAgent(generateStandaloneCompose(NAME, PORT, agentDir))
    })

    it('a resources regeneration KEEPS the shared VPN', async () => {
      await PUT(put({ ...BASE, sharedVpn: true }), params())
      expect(composeSharedVpnState(readCompose(), NAME)).toBe('on')
      const res = await PUT(put({ ...BASE, sharedVpn: true, resources: { memory: '4G' } }), params())
      expect(res.status).toBe(200)
      const after = readCompose()
      expect(after).toContain('memory: 4G')
      expect(composeSharedVpnState(after, NAME)).toBe('on')
      expect(after).toMatch(new RegExp(`- API_SERVER_PORT=${PORT}\\b`))
    })

    it('a resources regeneration KEEPS the shared VPN even when the client omits sharedVpn', async () => {
      await PUT(put({ ...BASE, sharedVpn: true }), params())
      const { sharedVpn: _omit, ...older } = { ...BASE, sharedVpn: undefined }
      void _omit
      const res = await PUT(put({ ...older, resources: { memory: '3G' } }), params())
      expect(res.status).toBe(200)
      expect(composeSharedVpnState(readCompose(), NAME)).toBe('on')
    })

    it('a resources regeneration REFUSES rather than drop a hand-made network_mode', async () => {
      const handMade = readCompose().replace(
        '    extra_hosts:\n      - "host.docker.internal:host-gateway"\n',
        '    network_mode: "container:gluetun-vera"\n',
      )
      writeAgent(handMade)
      const res = await PUT(put({ ...BASE, resources: { memory: '4G' } }), params())
      expect(res.status).toBe(409)
      expect(readCompose()).toBe(handMade)
    })
  })
})
