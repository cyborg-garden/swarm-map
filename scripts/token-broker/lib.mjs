/**
 * Host-side GitHub App token broker. One App private key lives here, in one 0600
 * file; agents hold only a per-agent secret that can ask for that agent's own
 * short-lived token. See README.md.
 *
 * Runs as plain Node on the host with no dependencies, because it has to work
 * outside HSM's install. Nothing in this file prints or logs a token, a key or an
 * agent secret; the audit log has event names only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

export const REMINT_MARGIN_SECONDS = 900
export const DEFAULT_PORT = 8799
export const AGENT_CONFIG_FILE = 'github-broker.json'
const MINT_TIMEOUT_MS = 10_000
const AUDIT_MAX_BYTES = 10 * 1024 * 1024
const KEY_FILE = 'private-key.pem'

function writePrivate(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

function validRegistry(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  if (r.agents === undefined) return true
  return !!r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents) &&
    Object.values(r.agents).every((e) => e && typeof e === 'object' && !Array.isArray(e))
}

/** Throws on a bad file rather than guess, so enrol can never overwrite one. */
function readRegistry(dir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(dir, 'registry.json'), 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') return { agents: {} }
    throw err
  }
  const registry = JSON.parse(raw)
  if (!validRegistry(registry)) throw new SyntaxError('registry.json has the wrong shape')
  return registry
}

export function audit(dir, event, fields = {}) {
  const file = path.join(dir, 'audit.jsonl')
  try {
    if (fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, `${file}.1`)
  } catch { /* first write */ }
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 })
}

export function signAppJwt(appId, pem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: nowSeconds - 60, exp: nowSeconds + 600, iss: String(appId) })}`
  return `${body}.${crypto.sign('sha256', Buffer.from(body), pem).toString('base64url')}`
}

/** The narrowing request body. `"all"` leaves that dimension to the installation. */
export function mintBody({ repos, permissions }) {
  const body = {}
  if (repos !== 'all') body.repositories = repos
  if (permissions !== 'all') body.permissions = permissions
  return Object.keys(body).length ? body : undefined
}

function validScope(s) {
  const reposOk = s.repos === 'all' || (Array.isArray(s.repos) && s.repos.length > 0 && s.repos.every((r) => typeof r === 'string' && r))
  const permsOk = s.permissions === 'all' ||
    (s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) &&
      Object.values(s.permissions).every((v) => ['read', 'write', 'admin'].includes(v)))
  return reposOk && permsOk
}

export function scopeHash({ repos, permissions }) {
  const perms = permissions === 'all' ? 'all' : Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b))
  const repoList = repos === 'all' ? 'all' : [...repos].sort()
  return crypto.createHash('sha256').update(JSON.stringify([repoList, perms])).digest('hex').slice(0, 12)
}

/**
 * node:http rather than fetch: undici dies on a host with broken IPv6 while curl
 * succeeds. The AbortSignal is the wall-clock bound; a socket timeout alone resets
 * on every byte, so a slow-dripping peer would hold the mint open indefinitely.
 */
function post(url, headers, body, timeoutMs) {
  const u = new URL(url)
  const payload = body === undefined ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'github-token-broker',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, raw }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}

async function mint(config, pem, scope, timeoutMs = MINT_TIMEOUT_MS) {
  const base = config.api_base ?? 'https://api.github.com'
  const url = `${base}/app/installations/${config.installation_id}/access_tokens`
  const res = await post(url, { authorization: `Bearer ${signAppJwt(config.app_id, pem)}` }, mintBody(scope), timeoutMs)
  if (res.status !== 201) throw new MintError(res.status)
  const { token, expires_at: expiresAt } = JSON.parse(res.raw)
  const expiresMs = Date.parse(expiresAt)
  if (!token || !Number.isFinite(expiresMs)) throw new MintError(res.status)
  return { token, expiresAt, expiresMs }
}

class MintError extends Error {
  constructor(status) {
    super(`mint failed: HTTP ${status}`)
    this.status = status
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest()
}

function identify(registry, secret) {
  if (typeof secret !== 'string' || !secret) return null
  const presented = hashSecret(secret)
  let found = null
  for (const [agent, entry] of Object.entries(registry.agents ?? {})) {
    const stored = Buffer.from(String(entry.secret_sha256 ?? ''), 'hex')
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) found = agent
  }
  return found
}

export function createBroker({ dir, now = Date.now, mintTimeoutMs = MINT_TIMEOUT_MS }) {
  const cache = new Map()
  const inFlight = new Map()
  const config = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
  let lastGoodRegistry = null

  // This file is edited by hand, so a typo is an expected event. Agents keep working
  // from the last good copy until it is fixed, and HSM's GitHub check goes red. The
  // audit line has no error message because a JSON error quotes the file.
  function currentRegistry() {
    try {
      lastGoodRegistry = readRegistry(dir)
    } catch (err) {
      audit(dir, 'registry-unreadable', { error: err.code ?? err.name, serving: lastGoodRegistry ? 'last-good' : 'nothing' })
    }
    return lastGoodRegistry
  }

  async function requestToken(secret) {
    const registry = currentRegistry()
    if (!registry) return { status: 503, body: { error: 'broker registry unreadable' } }
    const agent = identify(registry, secret)
    if (!agent) {
      audit(dir, 'denied', { reason: 'unknown-secret' })
      return { status: 401, body: { error: 'unauthorized' } }
    }
    const entry = registry.agents[agent]
    const scope = { repos: entry.repos, permissions: entry.permissions }
    if (!validScope(scope)) {
      audit(dir, 'denied', { agent, reason: 'bad-scope' })
      return { status: 403, body: { error: 'no valid scope for this agent' } }
    }
    const scopeId = scopeHash(scope)
    const cacheKey = `${agent}:${scopeId}`
    const fresh = () => {
      const c = cache.get(cacheKey)
      return c && (c.expiresMs - now()) / 1000 > REMINT_MARGIN_SECONDS ? c : null
    }
    const cached = fresh()
    if (cached) {
      audit(dir, 'served-cached', { agent, scope: scopeId, expires_at: cached.expiresAt })
      return { status: 200, body: { token: cached.token, expires_at: cached.expiresAt } }
    }
    try {
      let pending = inFlight.get(cacheKey)
      if (!pending) {
        // The key is read per mint, so a key change needs no restart.
        pending = mint(config(), fs.readFileSync(path.join(dir, KEY_FILE), 'utf-8'), scope, mintTimeoutMs)
          .then((t) => {
            cache.set(cacheKey, t)
            audit(dir, 'minted', { agent, scope: scopeId, expires_at: t.expiresAt })
            return t
          })
          .finally(() => inFlight.delete(cacheKey))
        inFlight.set(cacheKey, pending)
      }
      const t = await pending
      return { status: 200, body: { token: t.token, expires_at: t.expiresAt } }
    } catch (err) {
      audit(dir, 'mint-failed', { agent, scope: scopeId, status: err.status ?? null })
      return { status: 502, body: { error: 'mint failed' } }
    }
  }

  return { requestToken }
}

export function listen(broker, { host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) return Promise.reject(new Error('the broker binds to loopback only'))
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    // One bad request must not take the broker down for the whole fleet. The message
    // stays out of the log for the same reason as in currentRegistry.
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true })
      if (req.method === 'POST' && req.url === '/v1/token') {
        const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        const { status, body } = await broker.requestToken(secret)
        return send(status, body)
      }
      return send(404, { error: 'not found' })
    } catch (err) {
      console.error(`token broker: request failed (${err.code ?? err.name})`)
      if (!res.headersSent) send(500, { error: 'broker error' })
      else res.destroy()
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

/**
 * Give an agent a fresh secret: the hash goes in the host registry, the value in
 * the agent's own home. A re-enrol keeps the scope unless one is passed.
 */
export function enrollAgent({ dir, agent, home, url, scope = {} }) {
  const registry = readRegistry(dir)
  registry.agents ??= {}
  const prev = registry.agents[agent] ?? {}
  const secret = crypto.randomBytes(32).toString('hex')
  registry.agents[agent] = {
    secret_sha256: hashSecret(secret).toString('hex'),
    repos: scope.repos ?? prev.repos ?? 'all',
    permissions: scope.permissions ?? prev.permissions ?? 'all',
  }
  writePrivate(path.join(dir, 'registry.json'), JSON.stringify(registry, null, 2))
  writePrivate(path.join(home, AGENT_CONFIG_FILE), JSON.stringify({ url, secret }))
  audit(dir, 'enrolled', { agent })
}

export function unenrollAgent({ dir, agent, home }) {
  const registry = readRegistry(dir)
  if (registry.agents?.[agent]) {
    delete registry.agents[agent]
    writePrivate(path.join(dir, 'registry.json'), JSON.stringify(registry, null, 2))
  }
  fs.rmSync(path.join(home, AGENT_CONFIG_FILE), { force: true })
  audit(dir, 'unenrolled', { agent })
}

/**
 * Swap in a new App key with no downtime. It only replaces the working key after
 * GitHub accepts a test mint with it, and the swap is one atomic rename. The test
 * token is the narrowest there is and is dropped on the spot.
 */
export async function adoptKey({ dir, pem, mintTimeoutMs = MINT_TIMEOUT_MS }) {
  let key
  try {
    key = crypto.createPrivateKey(pem)
  } catch {
    key = null
  }
  if (key?.asymmetricKeyType !== 'rsa') throw new Error('that file is not an RSA private key')
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
  try {
    await mint(config, pem, { repos: 'all', permissions: { metadata: 'read' } }, mintTimeoutMs)
  } catch (err) {
    audit(dir, 'key-rejected', { status: err.status ?? null })
    throw new Error(`the test mint failed (${err.status ? `HTTP ${err.status}` : 'no response'}); the old key is still in use`)
  }
  writePrivate(path.join(dir, KEY_FILE), pem)
  audit(dir, 'key-adopted')
}
