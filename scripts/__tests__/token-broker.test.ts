// @vitest-environment node
/**
 * Broker logic, against a throwaway key and a fake GitHub server. Nothing here
 * talks to the real GitHub. The fake verifies the App JWT signature for real,
 * so "the broker signs with the key on disk" is proved rather than assumed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { adoptKey, createBroker, enrollAgent, listen, mintBody, scopeHash, signAppJwt, startMonitor, unenrollAgent } from '../token-broker/lib.mjs'
import { checkGithubCredentials } from '../../lib/services/github-credential-check'

const APP_ID = '111'
const INSTALL_ID = '222'

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey }
}

function verifyJwt(jwt: string, publicKey: crypto.KeyObject) {
  const [h, p, s] = jwt.split('.')
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))
  return ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null
}

type Mint = { path: string; body: unknown }

/** Fake GitHub: accepts only JWTs signed by the keys it currently trusts. */
function fakeGitHub(trusted: () => crypto.KeyObject[]) {
  const mints: Mint[] = []
  let n = 0
  let failWith: number | null = null
  let hang = false
  const ttl = { seconds: 3600 }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (hang) return
      const jwt = (req.headers.authorization ?? '').replace('Bearer ', '')
      const authed = trusted().some((k) => verifyJwt(jwt, k)?.iss === APP_ID)
      if (failWith) { res.writeHead(failWith); return res.end('{}') }
      if (!authed) { res.writeHead(401); return res.end('{}') }
      if (req.method === 'GET') { res.writeHead(200); return res.end('{}') }
      if (req.method !== 'POST') { res.writeHead(401); return res.end('{}') }
      mints.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : undefined })
      n += 1
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        token: `fake-minted-${n}`,
        expires_at: new Date(Date.now() + ttl.seconds * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      }))
    })
  })
  return {
    server, mints, ttl,
    fail: (code: number | null) => { failWith = code },
    hang: () => { hang = true },
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)) },
  }
}

describe('token broker', () => {
  let keyA: ReturnType<typeof makeKey>
  let keyB: ReturnType<typeof makeKey>
  let trusted: crypto.KeyObject[]
  let gh: ReturnType<typeof fakeGitHub>
  let dir: string
  let homes: string
  let api: string

  const readAudit = () => fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf-8')
  const enroll = (agent: string, scope = {}) => {
    const home = path.join(homes, agent)
    fs.mkdirSync(home, { recursive: true })
    enrollAgent({ dir, agent, home, url: 'http://unused', scope })
    return JSON.parse(fs.readFileSync(path.join(home, 'github-broker.json'), 'utf-8')).secret as string
  }

  beforeAll(() => { keyA = makeKey(); keyB = makeKey() })

  beforeEach(async () => {
    trusted = [keyA.publicKey]
    gh = fakeGitHub(() => trusted)
    api = await gh.start()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-'))
    homes = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-homes-'))
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app_id: APP_ID, installation_id: INSTALL_ID, api_base: api }))
    fs.writeFileSync(path.join(dir, 'private-key.pem'), keyA.pem, { mode: 0o600 })
  })
  afterEach(async () => {
    await gh.stop()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(homes, { recursive: true, force: true })
  })

  it('signs an RS256 App JWT that GitHub-side verification accepts', () => {
    const claims = verifyJwt(signAppJwt(APP_ID, keyA.pem, 1000), keyA.publicKey)
    expect(claims).toMatchObject({ iss: APP_ID, iat: 940, exp: 1600 })
  })

  it('sends no body for the all-repos first cut and a narrowed body otherwise', () => {
    expect(mintBody({ repos: 'all', permissions: 'all' })).toBeUndefined()
    expect(mintBody({ repos: ['a'], permissions: { contents: 'read' } })).toEqual({ repositories: ['a'], permissions: { contents: 'read' } })
    expect(mintBody({ repos: 'all', permissions: { metadata: 'read' } })).toEqual({ permissions: { metadata: 'read' } })
  })

  it('hashes equal scopes the same whatever the key order', () => {
    expect(scopeHash({ repos: ['a'], permissions: { x: 'read', y: 'write' } }))
      .toBe(scopeHash({ permissions: { y: 'write', x: 'read' }, repos: ['a'] }))
    expect(scopeHash({ repos: ['a'], permissions: 'all' })).not.toBe(scopeHash({ repos: ['b'], permissions: 'all' }))
  })

  it('mints from the installation for a known agent secret', async () => {
    const secret = enroll('mare')
    const res = await createBroker({ dir }).requestToken(secret)
    expect(res.status).toBe(200)
    expect(res.body.token).toBe('fake-minted-1')
    expect(gh.mints).toEqual([{ path: `/app/installations/${INSTALL_ID}/access_tokens`, body: undefined }])
  })

  it('applies the registry scope to the mint', async () => {
    const secret = enroll('mare', { repos: ['swarm-map'], permissions: { contents: 'write' } })
    await createBroker({ dir }).requestToken(secret)
    expect(gh.mints[0].body).toEqual({ repositories: ['swarm-map'], permissions: { contents: 'write' } })
  })

  it('denies an unknown or missing secret and never mints', async () => {
    enroll('mare')
    const broker = createBroker({ dir })
    expect((await broker.requestToken('wrong')).status).toBe(401)
    expect((await broker.requestToken(undefined)).status).toBe(401)
    expect(gh.mints).toHaveLength(0)
    expect(readAudit()).toContain('"denied"')
  })

  it('keeps one agent from getting another agent\'s token', async () => {
    const a = enroll('a')
    const b = enroll('b')
    const broker = createBroker({ dir })
    const ra = await broker.requestToken(a)
    const rb = await broker.requestToken(b)
    expect(ra.body.token).not.toBe(rb.body.token)
    expect(gh.mints).toHaveLength(2)
  })

  it('caches until 900s before expiry, then mints again', async () => {
    const secret = enroll('mare')
    let t = Date.now()
    const broker = createBroker({ dir, now: () => t })
    await broker.requestToken(secret)
    await broker.requestToken(secret)
    expect(gh.mints).toHaveLength(1)
    t += (3600 - 899) * 1000
    expect((await broker.requestToken(secret)).body.token).toBe('fake-minted-2')
  })

  it('mints fresh when the registry scope changes, with no restart', async () => {
    const secret = enroll('mare')
    const broker = createBroker({ dir })
    await broker.requestToken(secret)
    const regPath = path.join(dir, 'registry.json')
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'))
    reg.agents.mare.repos = ['one']
    fs.writeFileSync(regPath, JSON.stringify(reg))
    await broker.requestToken(secret)
    expect(gh.mints).toHaveLength(2)
    expect(gh.mints[1].body).toEqual({ repositories: ['one'] })
  })

  it('shares one in-flight mint between concurrent requests', async () => {
    const secret = enroll('mare')
    const broker = createBroker({ dir })
    const [x, y] = await Promise.all([broker.requestToken(secret), broker.requestToken(secret)])
    expect(gh.mints).toHaveLength(1)
    expect(x.body.token).toBe(y.body.token)
  })

  it('reports a failed mint as 502 without detail, and does not cache it', async () => {
    const secret = enroll('mare')
    const broker = createBroker({ dir })
    gh.fail(500)
    const bad = await broker.requestToken(secret)
    expect(bad.status).toBe(502)
    expect(JSON.stringify(bad.body)).not.toContain('500')
    gh.fail(null)
    expect((await broker.requestToken(secret)).status).toBe(200)
  })

  it('bounds a hung GitHub by wall clock', async () => {
    const secret = enroll('mare')
    const broker = createBroker({ dir, mintTimeoutMs: 100 })
    gh.hang()
    const started = Date.now()
    expect((await broker.requestToken(secret)).status).toBe(502)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('fails closed on a registry with a malformed scope', async () => {
    const secret = enroll('mare')
    const regPath = path.join(dir, 'registry.json')
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'))
    reg.agents.mare.repos = 'everything'
    fs.writeFileSync(regPath, JSON.stringify(reg))
    expect((await createBroker({ dir }).requestToken(secret)).status).toBe(403)
    expect(gh.mints).toHaveLength(0)
  })

  describe('a broken registry.json', () => {
    const breakRegistry = () => fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {"mare": {"secret_sha256": "typo-here",},}}')

    it('keeps serving from the last good copy, and says so in the audit log', async () => {
      const secret = enroll('mare')
      const broker = createBroker({ dir })
      expect((await broker.requestToken(secret)).status).toBe(200)
      breakRegistry()
      const r = await broker.requestToken(secret)
      expect(r.status).toBe(200)
      expect((await broker.requestToken('junk')).status).toBe(401)
      expect(readAudit()).toContain('registry-unreadable')
      expect(readAudit()).not.toContain('typo-here')
    })

    it('answers 503 and does not mint when it has never read a good copy', async () => {
      const secret = enroll('mare')
      breakRegistry()
      const r = await createBroker({ dir }).requestToken(secret)
      expect(r.status).toBe(503)
      expect(gh.mints).toHaveLength(0)
    })

    it('treats JSON of the wrong shape as broken', async () => {
      fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {"mare": null}}')
      expect((await createBroker({ dir }).requestToken('junk')).status).toBe(503)
      fs.writeFileSync(path.join(dir, 'registry.json'), 'null')
      expect((await createBroker({ dir }).requestToken('junk')).status).toBe(503)
    })

    it('never overwrites a broken file on enrol', () => {
      breakRegistry()
      const before = fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')
      expect(() => enroll('cyborg')).toThrow()
      expect(fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')).toBe(before)
    })
  })

  // The real CLI, because the failure was the process dying, which launchd then
  // repeats on every request.
  describe('the serve process', () => {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../token-broker/broker.mjs')
    let child: ChildProcess
    let base: string

    const serve = async () => {
      const port = await new Promise<number>((resolve) => {
        const probe = http.createServer().listen(0, '127.0.0.1', () => {
          const p = (probe.address() as AddressInfo).port
          probe.close(() => resolve(p))
        })
      })
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ app_id: APP_ID, installation_id: INSTALL_ID, api_base: api, port }))
      child = spawn(process.execPath, [cli, 'serve'], { env: { ...process.env, GITHUB_BROKER_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] })
      await new Promise((resolve, reject) => {
        child.stdout!.once('data', resolve)
        child.once('exit', reject)
      })
      base = `http://127.0.0.1:${port}`
    }
    const ask = (secret: string) => fetch(`${base}/v1/token`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } })
    afterEach(() => { child.kill() })

    it('survives a request against a registry with a typo, even with a wrong secret', async () => {
      fs.writeFileSync(path.join(dir, 'registry.json'), '{"agents": {},}')
      await serve()
      expect((await ask('junk')).status).toBe(503)
      expect(child.exitCode).toBeNull()
      expect((await fetch(`${base}/healthz`)).status).toBe(200)
    })

    it('survives a failed audit write', async () => {
      fs.mkdirSync(path.join(dir, 'audit.jsonl'))
      await serve()
      expect((await ask('junk')).status).toBe(500)
      expect(child.exitCode).toBeNull()
      expect((await fetch(`${base}/healthz`)).status).toBe(200)
    })
  })

  describe('reporting its own health', () => {
    const readStatus = () => JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf-8'))
    const healthCheck = (secretHome?: string) => checkGithubCredentials({
      agents: secretHome ? [{ name: 'mare', dataDir: secretHome }] : [],
      keyPath: path.join(dir, 'private-key.pem'),
    })

    it('checks the key with GitHub without minting a token', async () => {
      const broker = createBroker({ dir })
      await broker.checkKey()
      broker.writeStatus()
      expect(readStatus().key).toMatchObject({ ok: true, failures: 0, status: 200 })
      expect(gh.mints).toHaveLength(0)
    })

    it('counts a key GitHub rejects, and recovers once it is accepted again', async () => {
      const broker = createBroker({ dir })
      trusted = []
      await broker.checkKey()
      await broker.checkKey()
      broker.writeStatus()
      expect(readStatus().key).toMatchObject({ ok: false, failures: 2, status: 401 })
      trusted = [keyA.publicKey]
      await broker.checkKey()
      broker.writeStatus()
      expect(readStatus().key).toMatchObject({ ok: true, failures: 0 })
    })

    it('records no answer from GitHub as a failure with no status', async () => {
      const broker = createBroker({ dir, mintTimeoutMs: 50 })
      gh.hang()
      await broker.checkKey()
      broker.writeStatus()
      expect(readStatus().key).toMatchObject({ ok: false, failures: 1, status: null })
    })

    it('leaves the key unknown, not bad, before the first key is installed', async () => {
      fs.rmSync(path.join(dir, 'private-key.pem'))
      const broker = createBroker({ dir })
      await broker.checkKey()
      broker.writeStatus()
      expect(readStatus().key.ok).toBeNull()
    })

    it('says on /healthz when the key is bad, and stays up', async () => {
      const broker = createBroker({ dir })
      const server = await listen(broker, { host: '127.0.0.1', port: 0 })
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`
      expect(await (await fetch(url)).json()).toEqual({ ok: true, key_ok: null })
      trusted = []
      await broker.checkKey()
      const res = await fetch(url)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, key_ok: false })
      await new Promise((r) => server.close(r))
    })

    it('tracks a failing agent and clears it on success, with no secret in the file', async () => {
      const secret = enroll('mare')
      const broker = createBroker({ dir })
      gh.fail(422)
      await broker.requestToken(secret)
      await broker.requestToken(secret)
      broker.writeStatus()
      expect(readStatus().agents.mare).toEqual({ failures: 2, status: 422 })
      expect(fs.readFileSync(path.join(dir, 'status.json'), 'utf-8')).not.toContain(secret)
      expect(fs.statSync(path.join(dir, 'status.json')).mode & 0o777).toBe(0o600)
      gh.fail(null)
      await broker.requestToken(secret)
      broker.writeStatus()
      expect(readStatus().agents).toEqual({})
    })

    it('tracks an agent whose scope is invalid', async () => {
      const secret = enroll('mare', { repos: [] })
      const broker = createBroker({ dir })
      await broker.requestToken(secret)
      broker.writeStatus()
      expect(readStatus().agents.mare).toEqual({ failures: 1, status: 'bad-scope' })
    })

    it('refuses empty permissions and an empty repo list without asking GitHub', async () => {
      const noPerms = enroll('mare', { permissions: {} })
      const noRepos = enroll('vera', { repos: [] })
      const broker = createBroker({ dir })
      expect((await broker.requestToken(noPerms)).status).toBe(403)
      expect((await broker.requestToken(noRepos)).status).toBe(403)
      expect(gh.mints).toHaveLength(0)
    })

    it('drops an agent from the report once it is unenrolled', async () => {
      const secret = enroll('mare')
      const other = enroll('vera')
      const broker = createBroker({ dir })
      gh.fail(422)
      await broker.requestToken(secret)
      await broker.requestToken(other)
      broker.writeStatus()
      expect(Object.keys(readStatus().agents).sort()).toEqual(['mare', 'vera'])
      unenrollAgent({ dir, agent: 'mare', home: path.join(homes, 'mare') })
      broker.writeStatus()
      expect(Object.keys(readStatus().agents)).toEqual(['vera'])
    })

    it('keeps its failure list when the registry has a typo', async () => {
      const secret = enroll('mare')
      const broker = createBroker({ dir })
      gh.fail(422)
      await broker.requestToken(secret)
      fs.writeFileSync(path.join(dir, 'registry.json'), '{oops')
      broker.writeStatus()
      expect(Object.keys(readStatus().agents)).toEqual(['mare'])
    })

    it('the monitor reports at once and keeps reporting', async () => {
      const broker = createBroker({ dir })
      const stop = startMonitor(broker, { heartbeatMs: 10, keyCheckMs: 10 })
      try {
        await expect.poll(() => fs.existsSync(path.join(dir, 'status.json')), { timeout: 2000 }).toBe(true)
        const first = readStatus().at
        await expect.poll(() => readStatus().at !== first && readStatus().key.ok === true, { timeout: 2000 }).toBe(true)
      } finally {
        stop()
      }
    })

    it('the health check goes red on a key GitHub rejects, end to end', async () => {
      enroll('mare')
      const home = path.join(homes, 'mare')
      fs.writeFileSync(path.join(home, '.hsm-github-broker'), '')
      fs.writeFileSync(path.join(home, '.env'), 'OK=1\n')
      const broker = createBroker({ dir })
      await broker.checkKey()
      broker.writeStatus()
      expect(healthCheck(home).status).toBe('ok')
      trusted = []
      await broker.checkKey()
      await broker.checkKey()
      broker.writeStatus()
      expect(healthCheck(home).status).toBe('fail')
    })

    it('the health check goes red when nothing ever started the broker', () => {
      enroll('mare')
      const home = path.join(homes, 'mare')
      fs.writeFileSync(path.join(home, '.hsm-github-broker'), '')
      expect(healthCheck(home).broker.running).toBe(false)
    })
  })

  it('keeps the audit log free of tokens, secrets and key material', async () => {
    const secret = enroll('mare')
    const broker = createBroker({ dir })
    await broker.requestToken(secret)
    await broker.requestToken(secret)
    await broker.requestToken('wrong-secret-value')
    const log = readAudit()
    const events = log.trim().split('\n').map((l) => JSON.parse(l).event)
    expect(events).toEqual(expect.arrayContaining(['minted', 'served-cached', 'denied']))
    for (const banned of ['fake-minted', secret, 'wrong-secret-value', 'PRIVATE KEY']) expect(log).not.toContain(banned)
    expect(fs.statSync(path.join(dir, 'audit.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('enrol stores only a hash on the host and a 0600 secret in the agent home', () => {
    const secret = enroll('mare')
    const reg = fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')
    expect(reg).not.toContain(secret)
    expect(JSON.parse(reg).agents.mare).toMatchObject({ repos: 'all', permissions: 'all' })
    expect(fs.statSync(path.join(dir, 'registry.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(homes, 'mare', 'github-broker.json')).mode & 0o777).toBe(0o600)
  })

  it('re-enrolling replaces the secret and keeps the agent scope', async () => {
    const old = enroll('mare', { repos: ['x'], permissions: 'all' })
    const fresh = enroll('mare')
    const broker = createBroker({ dir })
    expect((await broker.requestToken(old)).status).toBe(401)
    expect((await broker.requestToken(fresh)).status).toBe(200)
    expect(gh.mints[0].body).toEqual({ repositories: ['x'] })
  })

  describe('over HTTP', () => {
    let server: http.Server
    let base: string
    beforeEach(async () => {
      server = await listen(createBroker({ dir }), { host: '127.0.0.1', port: 0 })
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterEach(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }))

    it('serves a token for a bearer secret, marked no-store', async () => {
      const secret = enroll('mare')
      const res = await fetch(`${base}/v1/token`, { method: 'POST', headers: { authorization: `Bearer ${secret}` } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect((await res.json()).token).toBe('fake-minted-1')
    })
    it('binds to loopback only by default args and 404s everything else', async () => {
      expect((await fetch(`${base}/v1/token`)).status).toBe(404)
      expect((await fetch(`${base}/nope`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${base}/healthz`)).status).toBe(200)
    })
    it('refuses to bind anywhere but loopback', async () => {
      await expect(listen(createBroker({ dir }), { host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/)
    })
  })

  describe('adoptKey', () => {
    it('proves the new key with a narrow test mint, then swaps it in with no restart', async () => {
      const secret = enroll('mare')
      const broker = createBroker({ dir })
      await broker.requestToken(secret) // cached under key A
      trusted = [keyA.publicKey, keyB.publicKey]
      await adoptKey({ dir, pem: keyB.pem })
      expect(gh.mints.at(-1)?.body).toEqual({ permissions: { metadata: 'read' } })
      expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyB.pem)
      expect(fs.statSync(path.join(dir, 'private-key.pem')).mode & 0o777).toBe(0o600)
      // Existing cached token keeps serving; the next mint signs with B even
      // after GitHub stops trusting A.
      expect((await broker.requestToken(secret)).body.token).toBe('fake-minted-1')
      trusted = [keyB.publicKey]
      const other = enroll('other')
      expect((await broker.requestToken(other)).status).toBe(200)
    })

    it('leaves the working key alone when the new key fails the test mint', async () => {
      await expect(adoptKey({ dir, pem: keyB.pem })).rejects.toThrow(/test mint/)
      expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyA.pem)
      expect(fs.readdirSync(dir).filter((f) => f.includes('incoming'))).toEqual([])
    })

    it('rejects something that is not a private key, without echoing it', async () => {
      await expect(adoptKey({ dir, pem: 'not-a-key-value-123' })).rejects.toThrow(/not an RSA private key/)
      await expect(adoptKey({ dir, pem: 'not-a-key-value-123' })).rejects.not.toThrow(/not-a-key-value-123/)
      expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyA.pem)
    })

    it('never logs key material or the test token', async () => {
      trusted = [keyB.publicKey]
      await adoptKey({ dir, pem: keyB.pem })
      const log = readAudit()
      expect(log).toContain('key-adopted')
      expect(log).not.toContain('fake-minted')
      expect(log).not.toContain('PRIVATE KEY')
    })
  })
})
