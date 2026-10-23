// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  defaultAgentConfig,
  serverKeyVarForModel,
  writeServerEnv,
  ensureLettaServer,
  deployLettaAgent,
  lettaServerDir,
  LETTA_IMAGE,
  LETTA_MODERN_AGENT_TYPE,
  LETTA_LEGACY_AGENT_TYPE,
} from '../letta-deploy-templates'

describe('serverKeyVarForModel', () => {
  it('maps anthropic/openai handles to their server env var', () => {
    expect(serverKeyVarForModel('anthropic/claude-3-5-sonnet')).toBe('ANTHROPIC_API_KEY')
    expect(serverKeyVarForModel('openai/gpt-4o')).toBe('OPENAI_API_KEY')
  })
  it('returns undefined for unmapped/handle-less models', () => {
    expect(serverKeyVarForModel('google/gemini-2.5-pro')).toBeUndefined()
    expect(serverKeyVarForModel('bare-model-name')).toBeUndefined()
    expect(serverKeyVarForModel(undefined)).toBeUndefined()
  })
})

describe('defaultAgentConfig', () => {
  it('defaults to the MODERN memfs agent type and does NOT seed memory_blocks', () => {
    const cfg = defaultAgentConfig({ name: 'librarian', model: 'anthropic/claude-3-5-sonnet' })
    expect(cfg.agent_type).toBe(LETTA_MODERN_AGENT_TYPE)
    expect(cfg.name).toBe('librarian')
    expect(cfg.model).toBe('anthropic/claude-3-5-sonnet')
    // The Letta team flagged memory_blocks as the old style — modern base must not use it.
    expect(cfg.memory_blocks).toBeUndefined()
  })

  it('passes persona as `system` for the modern agent', () => {
    const cfg = defaultAgentConfig({ name: 'x', model: 'anthropic/m', persona: '  be terse  ' })
    expect(cfg.system).toBe('be terse')
    expect(cfg.memory_blocks).toBeUndefined()
  })

  it('legacy opt-in switches to memgpt_agent + persona/human blocks', () => {
    const cfg = defaultAgentConfig({
      name: 'x',
      model: 'anthropic/m',
      persona: 'p',
      legacyMemoryBlocks: true,
      extraBlocks: [{ label: 'shareable', value: '' }],
    })
    expect(cfg.agent_type).toBe(LETTA_LEGACY_AGENT_TYPE)
    const labels = (cfg.memory_blocks ?? []).map((b) => b.label)
    expect(labels).toEqual(['persona', 'human', 'shareable'])
    expect(cfg.system).toBeUndefined()
  })
})

describe('writeServerEnv', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-env-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes provided keys at mode 0600 and returns the path', () => {
    const server = path.join(dir, 'letta')
    const envFile = writeServerEnv(server, { ANTHROPIC_API_KEY: 'sk-ant-xyz' })
    expect(envFile).toBe(path.join(server, '.env'))
    expect(fs.readFileSync(envFile!, 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-xyz')
    expect(fs.statSync(envFile!).mode & 0o777).toBe(0o600)
  })

  it('merges over an existing .env rather than blanking prior keys', () => {
    const server = path.join(dir, 'letta')
    writeServerEnv(server, { ANTHROPIC_API_KEY: 'first' })
    // Second deploy provides only OPENAI — the anthropic key must survive.
    writeServerEnv(server, { OPENAI_API_KEY: 'second' })
    const text = fs.readFileSync(path.join(server, '.env'), 'utf-8')
    expect(text).toContain('ANTHROPIC_API_KEY=first')
    expect(text).toContain('OPENAI_API_KEY=second')
  })

  it('returns undefined when nothing to write and no prior file', () => {
    const server = path.join(dir, 'letta')
    expect(writeServerEnv(server, {})).toBeUndefined()
    expect(writeServerEnv(server, { ANTHROPIC_API_KEY: '' })).toBeUndefined()
  })
})

function fakeDocker(overrides: Record<string, unknown> = {}) {
  return {
    isAvailable: vi.fn(() => true),
    pullImage: vi.fn(() => ({ ok: true })),
    start: vi.fn(),
    healthCheck: vi.fn(() => true),
    ...overrides,
  }
}

describe('ensureLettaServer', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-srv-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('pulls, starts with the project + env-file, and health-checks', async () => {
    const docker = fakeDocker()
    const info = await ensureLettaServer(docker as never, {
      swarmMapDataDir: dir,
      serverEnv: { ANTHROPIC_API_KEY: 'sk-ant' },
      composeFile: '/repo/docker/letta-compose.yml',
      baseUrl: 'http://localhost:8283',
    })
    // C2: the pre-pull must use the exact pinned ref — a looser assertion here
    // let :latest drift silently while the compose pinned something else.
    expect(docker.pullImage).toHaveBeenCalledWith('letta/letta:0.16.8')
    // start(composeFile, service, project, envFile)
    const call = docker.start.mock.calls[0]
    expect(call[0]).toBe('/repo/docker/letta-compose.yml')
    expect(call[1]).toBe('letta')
    expect(call[2]).toBe('letta')
    expect(call[3]).toBe(path.join(lettaServerDir(dir), '.env'))
    expect(docker.healthCheck).toHaveBeenCalledWith('http://localhost:8283/v1/agents', expect.any(Number))
    expect(info.baseUrl).toBe('http://localhost:8283')
  })

  it('passes no env-file when no keys are provided (loopback bind = compose default)', async () => {
    const docker = fakeDocker()
    await ensureLettaServer(docker as never, { swarmMapDataDir: dir, composeFile: '/c.yml', bindHost: '127.0.0.1' })
    expect(docker.start.mock.calls[0][3]).toBeUndefined()
  })

  it('a non-loopback bind host is delivered to the compose as LETTA_BIND_HOST (Linux default)', async () => {
    const docker = fakeDocker()
    await ensureLettaServer(docker as never, { swarmMapDataDir: dir, composeFile: '/c.yml', bindHost: '0.0.0.0' })
    const envFile = docker.start.mock.calls[0][3]
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('LETTA_BIND_HOST=0.0.0.0')
  })

  it('the default bind host follows the platform rule', async () => {
    const real = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const docker = fakeDocker()
      await ensureLettaServer(docker as never, { swarmMapDataDir: dir, composeFile: '/c.yml' })
      expect(fs.readFileSync(docker.start.mock.calls[0][3], 'utf-8')).toContain('LETTA_BIND_HOST=0.0.0.0')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const docker2 = fakeDocker()
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-bind-'))
      await ensureLettaServer(docker2 as never, { swarmMapDataDir: dir2, composeFile: '/c.yml' })
      expect(docker2.start.mock.calls[0][3]).toBeUndefined()
      fs.rmSync(dir2, { recursive: true, force: true })
    } finally {
      Object.defineProperty(process, 'platform', { value: real })
    }
  })

  it('refuses a bind host compose would reject', async () => {
    const docker = fakeDocker()
    await expect(ensureLettaServer(docker as never, { swarmMapDataDir: dir, composeFile: '/c.yml', bindHost: 'localhost' })).rejects.toThrow()
    expect(docker.start).not.toHaveBeenCalled()
  })

  it('the compose template reads LETTA_BIND_HOST with a loopback fallback', () => {
    const tpl = fs.readFileSync(path.join(__dirname, '../../../docker/letta-compose.yml'), 'utf-8')
    expect(tpl).toContain('- "${LETTA_BIND_HOST:-127.0.0.1}:${LETTA_PORT:-8283}:8283"')
  })

  // C1: parameterized instance (name/port/dir), singleton default untouched.
  it('C1: a named instance gets a letta-<name> project + dir, LETTA_PORT, and health on the given port', async () => {
    const docker = fakeDocker()
    const info = await ensureLettaServer(docker as never, {
      swarmMapDataDir: dir,
      composeFile: '/c.yml',
      name: 'acme',
      port: 8300,
    })
    const call = docker.start.mock.calls[0]
    expect(call[2]).toBe('letta-acme') // compose project
    const envFile = path.join(dir, 'letta-acme', '.env')
    expect(call[3]).toBe(envFile) // env-file lives in the instance dir
    // The published port is delivered to the compose via LETTA_PORT.
    const envText = fs.readFileSync(envFile, 'utf-8')
    expect(envText).toContain('LETTA_PORT=8300')
    // And the container name is instance-scoped so named instances can
    // coexist with the default (compose pins container_name via this var).
    expect(envText).toContain('LETTA_CONTAINER_NAME=letta-acme')
    expect(docker.healthCheck).toHaveBeenCalledWith('http://localhost:8300/v1/agents', expect.any(Number))
    expect(info.baseUrl).toBe('http://localhost:8300')
    expect(info.project).toBe('letta-acme')
  })

  it('C1: the default instance writes no LETTA_CONTAINER_NAME (keeps the historical `letta` name)', async () => {
    const docker = fakeDocker()
    await ensureLettaServer(docker as never, {
      swarmMapDataDir: dir,
      composeFile: '/c.yml',
      serverEnv: { ANTHROPIC_API_KEY: 'sk-x' }, // force an env file to exist
    })
    const envText = fs.readFileSync(path.join(dir, 'letta', '.env'), 'utf-8')
    expect(envText).not.toContain('LETTA_CONTAINER_NAME')
  })

  it('throws when the server never becomes reachable', async () => {
    const docker = fakeDocker({ healthCheck: vi.fn(() => false) })
    await expect(
      ensureLettaServer(docker as never, { swarmMapDataDir: dir, composeFile: '/c.yml' }),
    ).rejects.toThrow(/did not become reachable/)
  })
})

describe('LETTA_IMAGE pin (C2)', () => {
  it('is the exact pinned ref', () => {
    expect(LETTA_IMAGE).toBe('letta/letta:0.16.8')
  })

  it('drift guard: docker/letta-compose.yml image: matches LETTA_IMAGE', () => {
    // The pre-pull (LETTA_IMAGE) and the compose the server actually runs from
    // MUST reference the same image, or the pull warms one ref while compose-up
    // fetches another. String-match the compose `image:` line against the const.
    const composeText = fs.readFileSync(
      path.join(process.cwd(), 'docker/letta-compose.yml'),
      'utf-8',
    )
    const imageLine = composeText.split('\n').find((l) => l.trim().startsWith('image:'))
    expect(imageLine).toBeDefined()
    expect(imageLine).toContain(LETTA_IMAGE)
  })
})

function fakeLetta(overrides: Record<string, unknown> = {}) {
  return {
    listAgents: vi.fn(async () => []),
    createAgent: vi.fn(async (cfg: { name: string }) => ({ id: 'agent-123', name: cfg.name })),
    ...overrides,
  }
}

describe('deployLettaAgent', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-dep-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const base = (extra: Record<string, unknown>) => ({
    slug: 'scout',
    model: 'anthropic/claude-3-5-sonnet',
    swarmMapDataDir: dir,
    composeFile: '/c.yml',
    ...extra,
  })

  it('happy path: ensures server, checks name, creates agent, returns h_letta_ id', async () => {
    const docker = fakeDocker()
    const letta = fakeLetta()
    const res = await deployLettaAgent(base({ docker: docker as never, letta: letta as never, serverKey: 'sk-ant' }) as never)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, runtime: 'letta', harnessId: 'h_letta_agent-123', agentId: 'agent-123' })
    // Server key was injected into the env-file for the matching provider var.
    const envText = fs.readFileSync(path.join(lettaServerDir(dir), '.env'), 'utf-8')
    expect(envText).toContain('ANTHROPIC_API_KEY=sk-ant')
    // Modern agent type by default.
    expect((letta.createAgent.mock.calls[0][0] as { agent_type?: string }).agent_type).toBe(LETTA_MODERN_AGENT_TYPE)
  })

  it('400 when the model handle is missing', async () => {
    const res = await deployLettaAgent(base({ docker: fakeDocker() as never, letta: fakeLetta() as never, model: '' }) as never)
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  it('409 when an agent with the same name already exists', async () => {
    const letta = fakeLetta({ listAgents: vi.fn(async () => [{ id: 'x', name: 'scout' }]) })
    const res = await deployLettaAgent(base({ docker: fakeDocker() as never, letta: letta as never }) as never)
    expect(res.status).toBe(409)
    expect(letta.createAgent).not.toHaveBeenCalled()
  })

  it('502 when the server is unreachable', async () => {
    const docker = fakeDocker({ healthCheck: vi.fn(() => false) })
    const res = await deployLettaAgent(base({ docker: docker as never, letta: fakeLetta() as never }) as never)
    expect(res.status).toBe(502)
  })

  it('502 when listAgents (the clobber check) throws', async () => {
    const letta = fakeLetta({ listAgents: vi.fn(async () => { throw new Error('boom') }) })
    const res = await deployLettaAgent(base({ docker: fakeDocker() as never, letta: letta as never }) as never)
    expect(res.status).toBe(502)
    expect(letta.createAgent).not.toHaveBeenCalled()
  })

  it('502 when createAgent is rejected by the server (the live-validation risk)', async () => {
    const letta = fakeLetta({ createAgent: vi.fn(async () => { throw new Error('422 Unprocessable: unknown field system') }) })
    const res = await deployLettaAgent(base({ docker: fakeDocker() as never, letta: letta as never }) as never)
    expect(res.status).toBe(502)
    expect(res.body.ok).toBe(false)
    expect(String(res.body.error)).toContain('Letta agent creation failed')
  })

  it('passes persona through as `system` on the created agent', async () => {
    const letta = fakeLetta()
    const res = await deployLettaAgent(
      base({ docker: fakeDocker() as never, letta: letta as never, persona: 'be terse' }) as never,
    )
    expect(res.status).toBe(200)
    const cfg = letta.createAgent.mock.calls[0][0] as { system?: string; memory_blocks?: unknown }
    expect(cfg.system).toBe('be terse')
    expect(cfg.memory_blocks).toBeUndefined()
  })

  it('queries the server-side name filter for the clobber check (no full-list pagination gap)', async () => {
    const letta = fakeLetta()
    await deployLettaAgent(base({ docker: fakeDocker() as never, letta: letta as never }) as never)
    expect(letta.listAgents).toHaveBeenCalledWith({ name: 'scout' })
  })

  it('500 when Docker is unavailable', async () => {
    const docker = fakeDocker({ isAvailable: vi.fn(() => false) })
    const res = await deployLettaAgent(base({ docker: docker as never, letta: fakeLetta() as never }) as never)
    expect(res.status).toBe(500)
  })
})
