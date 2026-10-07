// @vitest-environment node
//
// Route-level integration test for POST /api/setup/deploy. Docker, the services
// singleton, baseline-template install, and os.homedir are mocked; everything
// else (the route logic, .env + compose templating, fs writes) runs for real
// against temp dirs. This exercises the full Phase 1 wiring end-to-end in-process
// — the only thing not covered is the actual `docker compose up` (no Docker here).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const h = vi.hoisted(() => ({
  tmpHome: '',
  tmpData: '',
  hermesDir: '',
  settings: { useLocalBuild: false, defaultImage: 'ghcr.io/x:latest' } as Record<string, unknown>,
  getDecryptedValue: vi.fn((id: string) => (id === 'k_known' ? 'sk-ant-api-REALVALUE123' : undefined)),
  list: vi.fn(() => [{ id: 'k_known', provider: 'anthropic', assignedTo: [], maskedValue: 'sk-a…123', health: 'good' }]),
  update: vi.fn(),
  setAssignment: vi.fn(),
  add: vi.fn(),
  createOverlay: vi.fn(async () => ({ id: 'h_matilde' })),
  // Letta branch: docker.start + healthCheck + the letta REST client.
  dockerStart: vi.fn(),
  healthCheck: vi.fn(() => false),
  listAgents: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  createAgent: vi.fn(async (cfg: { name: string }) => ({ id: 'agent-xyz', name: cfg.name })),
  deleteAgent: vi.fn(async () => undefined),
}))

vi.mock('child_process', () => ({ execSync: vi.fn(() => Buffer.from('')) }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = () => h.tmpHome
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const baseline = vi.hoisted(() => ({ install: vi.fn(async () => []) }))
vi.mock('@/lib/services/templates', () => ({ installBaselineTemplates: baseline.install }))

const tmpl = vi.hoisted(() => ({ get: vi.fn(), install: vi.fn(async () => []) }))
vi.mock('@/lib/services/usecase-templates', () => ({
  getUseCaseTemplate: tmpl.get,
  installUseCaseTemplate: tmpl.install,
  templateEnabledPlugins: () => ['matilde'],
}))

vi.mock('@/lib/services', () => ({
  services: {
    docker: { isAvailable: () => true, pullImage: () => ({ ok: true }), healthCheck: h.healthCheck, start: h.dockerStart },
    config: { getSettings: () => ({ ...h.settings, dataDir: h.tmpData }) },
    keys: { getDecryptedValue: h.getDecryptedValue, list: h.list, update: h.update, setAssignment: h.setAssignment, add: h.add },
    harness: { createOverlay: h.createOverlay },
    letta: { listAgents: h.listAgents, createAgent: h.createAgent, deleteAgent: h.deleteAgent },
  },
}))

import { POST } from '@/app/api/setup/deploy/route'

function deploy(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/setup/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('POST /api/setup/deploy — Phase 1 wiring', () => {
  beforeEach(() => {
    h.tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-home-'))
    h.tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-data-'))
    h.hermesDir = ''
    h.settings = { useLocalBuild: false, defaultImage: 'ghcr.io/x:latest' }
    h.getDecryptedValue.mockClear()
    h.update.mockClear()
    h.setAssignment.mockClear()
    h.add.mockClear()
    h.createOverlay.mockClear()
    h.createOverlay.mockResolvedValue({ id: 'h_matilde' })
    h.dockerStart.mockClear()
    h.healthCheck.mockReset()
    h.healthCheck.mockReturnValue(false)
    h.listAgents.mockReset()
    h.listAgents.mockResolvedValue([])
    h.createAgent.mockReset()
    h.createAgent.mockImplementation(async (cfg: { name: string }) => ({ id: 'agent-xyz', name: cfg.name }))
    tmpl.get.mockReset()
    tmpl.install.mockReset()
    tmpl.install.mockResolvedValue([])
  })

  afterEach(() => {
    fs.rmSync(h.tmpHome, { recursive: true, force: true })
    fs.rmSync(h.tmpData, { recursive: true, force: true })
    if (h.hermesDir) fs.rmSync(h.hermesDir, { recursive: true, force: true })
  })

  it('local-build: builds the image as a separate step (build-appropriate timeout) before up -d', async () => {
    const { execSync } = await import('child_process')
    vi.mocked(execSync).mockClear()

    // useLocalBuild on, pointing at a source dir that has a Dockerfile.
    h.hermesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-src-'))
    fs.writeFileSync(path.join(h.hermesDir, 'Dockerfile'), 'FROM alpine\n')
    h.settings = { useLocalBuild: true, hermesDir: h.hermesDir }

    const res = await deploy({
      name: 'lb', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X',
    })
    expect((await res.json()).ok).toBe(true)

    const calls = vi.mocked(execSync).mock.calls
    const cmds = calls.map(c => String(c[0]))
    const buildIdx = cmds.findIndex(c => /compose -f .* build$/.test(c))
    const upIdx = cmds.findIndex(c => /compose -f .* up -d/.test(c))

    // A dedicated build step runs, before the container start.
    expect(buildIdx).toBeGreaterThanOrEqual(0)
    expect(upIdx).toBeGreaterThan(buildIdx)
    // The build gets a build-appropriate timeout, not the short start timeout —
    // this is the fix for cold first-time builds blowing the 60s start window.
    const buildOpts = calls[buildIdx][1] as { timeout?: number }
    expect(buildOpts?.timeout ?? 0).toBeGreaterThanOrEqual(600000)
  })

  // ── Base package (v1) ─────────────────────────────────────────────────────
  it('base package: passes the surface + packs to the shared injection point', async () => {
    baseline.install.mockClear()
    const res = await deploy({ name: 'pub', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X', surface: 'public' })
    expect((await res.json()).ok).toBe(true)
    expect(baseline.install).toHaveBeenCalledWith(path.join(h.tmpHome, '.hermes-pub'), { surface: 'public', packs: [] })
  })

  it('base package: browser tools imply the browser-ops pack', async () => {
    baseline.install.mockClear()
    await deploy({ name: 'brw', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X', browserEnabled: true })
    expect(baseline.install).toHaveBeenCalledWith(expect.any(String), { surface: 'team', packs: ['browser-ops'] })
  })

  it('base package: refuses a public agent with browser tools or GitHub, before writing anything', async () => {
    for (const extra of [{ browserEnabled: true }, { githubToken: 'x' }, { packs: ['browser-ops'] }]) {
      const res = await deploy({ name: 'bad', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X', surface: 'public', ...extra })
      expect(res.status).toBe(400)
      expect(fs.existsSync(path.join(h.tmpHome, '.hermes-bad'))).toBe(false)
    }
    const res = await deploy({ name: 'bad', provider: 'anthropic', primaryModel: 'claude-opus-4-6', surface: 'galaxy' })
    expect(res.status).toBe(400)
  })

  it('base package: SOUL is the shared default (no false per-group memory isolation claim)', async () => {
    await deploy({ name: 'soul', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X', persona: 'Warm and curious.' })
    const soul = fs.readFileSync(path.join(h.tmpHome, '.hermes-soul', 'SOUL.md'), 'utf-8')
    expect(soul).not.toMatch(/isolat/i)
    expect(soul).not.toMatch(/Mattermost/)
    expect(soul).toContain('Warm and curious.')
  })

  it('image mode (no local build) does not run a separate build step', async () => {
    const { execSync } = await import('child_process')
    vi.mocked(execSync).mockClear()

    await deploy({ name: 'img', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-X' })

    const cmds = vi.mocked(execSync).mock.calls.map(c => String(c[0]))
    expect(cmds.some(c => /compose -f .* build$/.test(c))).toBe(false)
    expect(cmds.some(c => /compose -f .* up -d/.test(c))).toBe(true)
  })

  it('1A: resolves an existing key server-side, writes it to .env, records assignment', async () => {
    const res = await deploy({
      name: 'matilde', provider: 'anthropic', primaryModel: 'claude-opus-4-6',
      tier: 'individual', existingKeyId: 'k_known',
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.harnessId).toBe('h_matilde')
    expect(h.getDecryptedValue).toHaveBeenCalledWith('k_known')

    const env = fs.readFileSync(path.join(h.tmpHome, '.hermes-matilde', '.env'), 'utf-8')
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-api-REALVALUE123')

    // setAssignment (not the registry-only update) so the reused key's value is
    // written into the new agent's .env, keeping keys.json and .env in lockstep.
    expect(h.setAssignment).toHaveBeenCalledWith('k_known', ['h_matilde'])
  })

  it('1A: rejects an unknown existing key id', async () => {
    const res = await deploy({
      name: 'x', provider: 'anthropic', primaryModel: 'claude-opus-4-6', existingKeyId: 'k_missing',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).ok).toBe(false)
  })

  it('1A: saves a freshly-pasted key to the registry when asked', async () => {
    await deploy({
      name: 'fresh', provider: 'anthropic', primaryModel: 'claude-opus-4-6',
      llmKey: 'sk-ant-api-PASTED', saveKeyToRegistry: true,
    })
    expect(h.add).toHaveBeenCalledWith({ provider: 'anthropic', value: 'sk-ant-api-PASTED', assignedTo: ['h_matilde'] })
  })

  it('1B: bundled ollama emits the sidecar compose + sidecar OLLAMA_BASE_URL', async () => {
    await deploy({
      name: 'sci', provider: 'ollama', primaryModel: 'qwen2.5:0.5b', bundledOllama: true,
    })
    const compose = fs.readFileSync(path.join(h.tmpData, 'compose', 'sci', 'docker-compose.yml'), 'utf-8')
    expect(compose).toContain('ollama-sci:')
    expect(compose).toContain('qwen2.5:0.5b')

    const env = fs.readFileSync(path.join(h.tmpHome, '.hermes-sci', '.env'), 'utf-8')
    expect(env).toContain('OLLAMA_BASE_URL=http://ollama-sci:11434/v1')
  })

  it('1B: host ollama (default) points at host.docker.internal and adds no sidecar', async () => {
    await deploy({ name: 'host', provider: 'ollama', primaryModel: 'qwen3:8b' })
    const compose = fs.readFileSync(path.join(h.tmpData, 'compose', 'host', 'docker-compose.yml'), 'utf-8')
    expect(compose).not.toContain('ollama-host:')
    const env = fs.readFileSync(path.join(h.tmpHome, '.hermes-host', '.env'), 'utf-8')
    expect(env).toContain('OLLAMA_BASE_URL=http://host.docker.internal:11434/v1')
  })

  it('notion: enabled + key → notion MCP server in config.yaml, literal key in .env', async () => {
    const res = await deploy({
      name: 'ntn', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-x',
      notionEnabled: true, notionKey: 'ntn_test123',
    })
    expect((await res.json()).ok).toBe(true)

    // Command-based server, same shape the github MCP uses (npx works in-image).
    const cfg = fs.readFileSync(path.join(h.tmpHome, '.hermes-ntn', 'config.yaml'), 'utf-8')
    expect(cfg).toContain('  notion:')
    expect(cfg).toContain('command: npx')
    expect(cfg).toContain('@notionhq/notion-mcp-server')
    // MCP server reads NOTION_TOKEN, mapped from the canonical NOTION_API_KEY.
    expect(cfg).toContain('NOTION_TOKEN: "${NOTION_API_KEY}"')

    // Only the canonical NOTION_API_KEY is written as a literal (env_file, never
    // a compose override); no duplicate NOTION_TOKEN literal that could go stale.
    const env = fs.readFileSync(path.join(h.tmpHome, '.hermes-ntn', '.env'), 'utf-8')
    expect(env).toContain('NOTION_API_KEY=ntn_test123')
    expect(env).not.toContain('NOTION_TOKEN=')
  })

  it('notion: disabled → no notion MCP server and no notion env vars', async () => {
    await deploy({
      name: 'nono', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-x',
    })
    const cfg = fs.readFileSync(path.join(h.tmpHome, '.hermes-nono', 'config.yaml'), 'utf-8')
    expect(cfg).not.toContain('notion')
    const env = fs.readFileSync(path.join(h.tmpHome, '.hermes-nono', '.env'), 'utf-8')
    expect(env).not.toContain('NOTION')
  })

  it('notion: enabled without a key → server omitted (gated like github)', async () => {
    await deploy({
      name: 'nokey', provider: 'anthropic', primaryModel: 'claude-opus-4-6', llmKey: 'sk-ant-api-x',
      notionEnabled: true,
    })
    const cfg = fs.readFileSync(path.join(h.tmpHome, '.hermes-nokey', 'config.yaml'), 'utf-8')
    expect(cfg).not.toContain('notion')
  })

  // Phase 2: use-case template (e.g. Matilde)
  it('P2: installs the chosen use-case template after baseline', async () => {
    const template = { id: 'matilde', name: 'Matilde', description: '', artifacts: [], recommends: {} }
    tmpl.get.mockReturnValue(template)
    const res = await deploy({
      name: 'sci', provider: 'anthropic', primaryModel: 'claude-opus-4-6', template: 'matilde', llmKey: 'sk-ant-api-x',
    })
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(tmpl.get).toHaveBeenCalledWith('matilde')
    expect(tmpl.install).toHaveBeenCalledWith(path.join(h.tmpHome, '.hermes-sci'), template)
    // template's enabled plugin is written into config.yaml plugins.enabled
    const cfg = fs.readFileSync(path.join(h.tmpHome, '.hermes-sci', 'config.yaml'), 'utf-8')
    expect(cfg).toContain('matilde')
  })

  it('P2: a template install failure removes the half-written agent dir (no leftover .env)', async () => {
    tmpl.get.mockReturnValue({ id: 'matilde', name: 'Matilde', description: '', artifacts: [], recommends: {} })
    tmpl.install.mockRejectedValue(new Error('Refused: injection scan'))
    const res = await deploy({
      name: 'sci', provider: 'anthropic', primaryModel: 'claude-opus-4-6', template: 'matilde', llmKey: 'sk-ant-api-x',
    })
    expect(res.status).toBe(500)
    expect(fs.existsSync(path.join(h.tmpHome, '.hermes-sci'))).toBe(false)
  })

  it('P2: rejects an unknown template id with 400 and installs nothing', async () => {
    tmpl.get.mockReturnValue(undefined)
    const res = await deploy({
      name: 'x', provider: 'anthropic', primaryModel: 'claude-opus-4-6', template: 'bogus', llmKey: 'sk-ant-api-x',
    })
    expect(res.status).toBe(400)
    expect(tmpl.install).not.toHaveBeenCalled()
  })

  // ── B2: the Letta runtime branch — linked pair (brain + Hermes door) ──────
  // A2's "no per-agent dir/compose/overlay" contract INVERTS here: after the
  // Letta brain agent is created over REST, the route falls through into the
  // Hermes block and deploys a door gateway whose .env carries the B1-contract
  // LETTA_BRAIN_* vars pointing at the brain.
  it('Letta: creates the brain over REST, then deploys a Hermes door wired to it', async () => {
    h.healthCheck.mockReturnValue(true) // server + door reachable
    h.createOverlay.mockResolvedValue({ id: 'h_scout' })
    const { execSync } = await import('child_process')
    vi.mocked(execSync).mockClear()

    const res = await deploy({
      name: 'scout', runtime: 'letta', lettaModel: 'anthropic/claude-3-5-sonnet',
      llmKey: 'sk-ant-server-key', persona: 'be terse',
    })
    const data = await res.json()
    expect(res.status).toBe(200)

    // (a) The brain agent was created on the Letta server (modern memfs type).
    expect(h.createAgent).toHaveBeenCalledTimes(1)
    expect((h.createAgent.mock.calls[0][0] as { agent_type?: string }).agent_type).toBe('letta_v1_agent')

    // The Letta server was brought up; the server key landed in the server .env.
    expect(h.dockerStart).toHaveBeenCalled()
    const serverEnv = path.join(h.tmpData, 'letta', '.env')
    expect(fs.readFileSync(serverEnv, 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-server-key')

    // (b) The DOOR agent dir exists, with the B1-contract brain vars at 0600.
    const doorEnvPath = path.join(h.tmpHome, '.hermes-scout', '.env')
    const doorEnv = fs.readFileSync(doorEnvPath, 'utf-8')
    expect(doorEnv).toContain('LETTA_BRAIN_URL=http://host.docker.internal:8283')
    expect(doorEnv).toContain('LETTA_BRAIN_AGENT_ID=agent-xyz')
    expect(fs.statSync(doorEnvPath).mode & 0o777).toBe(0o600)

    // (c) Door compose written, container started, overlay registered.
    expect(fs.existsSync(path.join(h.tmpData, 'compose', 'scout', 'docker-compose.yml'))).toBe(true)
    const cmds = vi.mocked(execSync).mock.calls.map((c) => String(c[0]))
    expect(cmds.some((c) => /compose -f .* up -d/.test(c))).toBe(true)
    expect(h.createOverlay).toHaveBeenCalledTimes(1)

    // (d) Merged response: door harness identity + brain identity. `agentId`
    // mirrors brainAgentId for the wizard's pre-pair success panel.
    expect(data).toMatchObject({
      ok: true,
      runtime: 'letta',
      harnessId: 'h_scout',
      agentId: 'agent-xyz',
      brainAgentId: 'agent-xyz',
      brainHarnessId: 'h_letta_agent-xyz',
      baseUrl: 'http://localhost:8283',
      port: 8642,
    })
  })

  it('Letta: a door-phase failure deletes the freshly created brain (no 409 on retry)', async () => {
    h.healthCheck.mockReturnValue(true)
    // Brain phase succeeds; the door phase then dies at overlay registration.
    h.createOverlay.mockRejectedValueOnce(new Error('overlay store exploded'))
    const res = await deploy({
      name: 'scout', runtime: 'letta', lettaModel: 'anthropic/claude-3-5-sonnet',
      llmKey: 'sk-ant-server-key',
    })
    expect(res.status).toBe(500)
    // The orphaned brain was cleaned up, so retrying the same name won't 409.
    expect(h.deleteAgent).toHaveBeenCalledWith('agent-xyz')
    // And the door dir cleanup still ran (pre-existing contract).
    expect(fs.existsSync(path.join(h.tmpHome, '.hermes-scout'))).toBe(false)
  })


  it('Letta: 409 when an agent with the same name already exists on the server (no door left behind)', async () => {
    h.healthCheck.mockReturnValue(true)
    h.listAgents.mockResolvedValue([{ id: 'a1', name: 'scout' }])
    const { execSync } = await import('child_process')
    vi.mocked(execSync).mockClear()
    const res = await deploy({
      name: 'scout', runtime: 'letta', lettaModel: 'anthropic/claude-3-5-sonnet', llmKey: 'sk-ant',
    })
    expect(res.status).toBe(409)
    expect(h.createAgent).not.toHaveBeenCalled()
    // Brain-first ordering: the brain failed, so NO door side effects exist.
    expect(fs.existsSync(path.join(h.tmpHome, '.hermes-scout'))).toBe(false)
    expect(fs.existsSync(path.join(h.tmpData, 'compose', 'scout'))).toBe(false)
    expect(h.createOverlay).not.toHaveBeenCalled()
    const cmds = vi.mocked(execSync).mock.calls.map((c) => String(c[0]))
    expect(cmds.some((c) => /compose -f .* up -d/.test(c))).toBe(false)
  })

  it('Letta: 502 when the server never becomes reachable (no door left behind)', async () => {
    h.healthCheck.mockReturnValue(false) // never healthy
    const { execSync } = await import('child_process')
    vi.mocked(execSync).mockClear()
    const res = await deploy({
      name: 'scout', runtime: 'letta', lettaModel: 'anthropic/claude-3-5-sonnet', llmKey: 'sk-ant',
    })
    expect(res.status).toBe(502)
    expect(h.createAgent).not.toHaveBeenCalled()
    // Brain-first ordering: unreachable server means no door dir/compose/overlay.
    expect(fs.existsSync(path.join(h.tmpHome, '.hermes-scout'))).toBe(false)
    expect(fs.existsSync(path.join(h.tmpData, 'compose', 'scout'))).toBe(false)
    expect(h.createOverlay).not.toHaveBeenCalled()
    const cmds = vi.mocked(execSync).mock.calls.map((c) => String(c[0]))
    expect(cmds.some((c) => /compose -f .* up -d/.test(c))).toBe(false)
  })
})
