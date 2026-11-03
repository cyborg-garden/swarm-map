// @vitest-environment node
/**
 * The real ghkey script, through a fake ssh, into the real adopt-key command, up to
 * a fake GitHub. That is the whole key-change path with only the machine boundary
 * and GitHub swapped out. All keys here are generated for the test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const HERE = path.resolve(__dirname, '../token-broker')
const GHKEY = path.join(HERE, 'ghkey')
const makeKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey }
}
const accepts = (auth: string | undefined, key: crypto.KeyObject) => {
  const [h, p, s] = (auth ?? '').replace('Bearer ', '').split('.')
  return !!s && crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
}

describe('ghkey', () => {
  let keyOld: ReturnType<typeof makeKey>
  let keyNew: ReturnType<typeof makeKey>
  let root: string
  let downloads: string
  let dir: string
  let fakeBin: string
  let gh: http.Server
  let trusted: crypto.KeyObject[]

  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('bash', [GHKEY, ...args], {
        env: { ...process.env, HOME: root, PATH: `${fakeBin}:${process.env.PATH}`, GHKEY_DOWNLOADS: downloads, ...env },
      })
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      child.on('close', (code) => resolve({ code, out }))
    })
  const drop = (name: string, content: string) => {
    const f = path.join(downloads, name)
    fs.writeFileSync(f, content)
    return f
  }

  beforeAll(() => { keyOld = makeKey(); keyNew = makeKey() })

  beforeEach(async () => {
    trusted = [keyOld.publicKey, keyNew.publicKey]
    gh = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (!trusted.some((k) => accepts(req.headers.authorization, k))) { res.writeHead(401); return res.end('{}') }
        res.writeHead(201)
        res.end(JSON.stringify({ token: 'fake-test-mint', expires_at: new Date(Date.now() + 3600e3).toISOString() }))
      })
    })
    await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()))

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghkey-'))
    downloads = path.join(root, 'Downloads')
    fs.mkdirSync(downloads)
    dir = path.join(root, '.config/hermes/github-app')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      app_id: '1', installation_id: '2', api_base: `http://127.0.0.1:${(gh.address() as AddressInfo).port}`,
    }))
    fs.writeFileSync(path.join(dir, 'private-key.pem'), keyOld.pem, { mode: 0o600 })
    fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'bin/github-broker'), `#!/bin/sh\nexec ${process.execPath} ${HERE}/broker.mjs "$@"\n`, { mode: 0o755 })
    fakeBin = path.join(root, 'fakebin')
    fs.mkdirSync(fakeBin)
    // Fake ssh: drop the host argument and run the rest in a shell, stdin intact.
    fs.writeFileSync(path.join(fakeBin, 'ssh'), '#!/bin/sh\nshift\nexec sh -c "$*"\n', { mode: 0o755 })
  })
  afterEach(async () => {
    gh.closeAllConnections()
    await new Promise((r) => gh.close(r))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('is under 40 characters to invoke', () => {
    expect('~/bin/ghkey'.length).toBeLessThan(40)
  })

  it('moves the newest key over, proves it, deletes the local copy, prints the delete link', async () => {
    const old = drop('hermes-fleet-git.2026-01-01.private-key.pem', 'an older file')
    fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3))
    const fresh = drop('hermes-fleet-git.2026-11-03.private-key.pem', keyNew.pem)
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(fs.existsSync(fresh)).toBe(false)
    expect(fs.existsSync(old)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyNew.pem)
    expect(out).toContain('settings/apps/hermes-fleet-git')
    expect(out).toContain('1 older key file')
    expect(out).not.toContain('PRIVATE KEY')
    expect(out).not.toContain('fake-test-mint')
  })

  it('keeps the local copy and the old key when GitHub rejects the new one', async () => {
    trusted = [keyOld.publicKey]
    const fresh = drop('hermes-fleet-git.2026-11-03.private-key.pem', keyNew.pem)
    const { code, out } = await run()
    expect(code).toBe(1)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyOld.pem)
    expect(out).toContain('Key not changed')
    expect(out).not.toContain('settings/apps/hermes-fleet-git')
  })

  it('uses a second download the browser named (1), not the file GitHub rejected', async () => {
    trusted = [keyOld.publicKey]
    const rejected = drop('hermes-fleet-git.2026-11-03.private-key.pem', keyNew.pem)
    const first = await run()
    expect(first.code).toBe(1)
    expect(first.out).toContain('hermes-fleet-git.2026-11-03.private-key.pem')
    expect(first.out).toContain('still in Downloads')

    const old = new Date(Date.now() - 60e3)
    fs.utimesSync(rejected, old, old)
    const keyThird = makeKey()
    trusted = [keyOld.publicKey, keyThird.publicKey]
    const second = drop('hermes-fleet-git.2026-11-03.private-key (1).pem', keyThird.pem)
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyThird.pem)
    expect(fs.existsSync(second)).toBe(false)
    // The rejected file is named, not silently left behind.
    expect(fs.existsSync(rejected)).toBe(true)
    expect(out).toContain('hermes-fleet-git.2026-11-03.private-key.pem')
    expect(out).toContain('1 older key file')
    expect(out).not.toContain('PRIVATE KEY')
  })

  it('counts a leftover (1) file among the older ones', async () => {
    const leftover = drop('hermes-fleet-git.2026-11-03.private-key (1).pem', 'an older file')
    fs.utimesSync(leftover, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3))
    drop('hermes-fleet-git.2026-11-03.private-key (2).pem', keyNew.pem)
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(out).toContain('1 older key file')
    expect(fs.existsSync(leftover)).toBe(true)
  })

  it('holds back the delete link while an agent still carries the old key', async () => {
    fs.mkdirSync(path.join(root, '.hermes-mare'))
    fs.writeFileSync(path.join(root, '.hermes-mare/.env'), 'GITHUB_APP_PRIVATE_KEY_B64=x\n')
    const fresh = drop('hermes-fleet-git.2026-11-03.private-key.pem', keyNew.pem)
    const { code, out } = await run()
    expect(code).toBe(0)
    expect(fs.existsSync(fresh)).toBe(false)
    expect(out).toContain('HOLD')
    expect(out).toContain('mare')
    expect(out).toContain("Don't delete the old key")
    expect(out).not.toContain('Last step')
  })

  it('prints the link and stops when there is no key file', async () => {
    const { code, out } = await run()
    expect(code).toBe(1)
    expect(out).toContain('settings/apps/hermes-fleet-git')
  })

  it('refuses a key file over a day old', async () => {
    const f = drop('hermes-fleet-git.2020-01-01.private-key.pem', keyNew.pem)
    const old = new Date(Date.now() - 2 * 86400e3)
    fs.utimesSync(f, old, old)
    const { code, out } = await run()
    expect(code).toBe(1)
    expect(fs.existsSync(f)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'private-key.pem'), 'utf-8')).toBe(keyOld.pem)
    expect(out).toContain('over a day old')
  })

  it('refuses shell metacharacters in an agent name', async () => {
    for (const bad of ['a;rm', '$(x)', 'A B']) {
      const { code } = await run(['roll', bad])
      expect(code).toBe(2)
    }
    expect((await run(['roll', 'mare', '--bad'])).code).toBe(2)
  })

  it('installs a working ~/bin/ghkey that needs no repo checkout', async () => {
    expect((await run(['install'])).code).toBe(0)
    const installed = path.join(root, 'bin/ghkey')
    expect(fs.lstatSync(installed).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(root, '.local/share/token-broker/lib.mjs'))).toBe(true)
    const r = spawnSync(installed, ['nonsense'], { env: { ...process.env, HOME: root }, encoding: 'utf-8' })
    expect(r.status).toBe(2)
  })

  it('setup-mini writes a private config, a thin-PATH wrapper and a valid launch agent', () => {
    fs.rmSync(path.join(dir, 'config.json'))
    for (const tool of ['launchctl', 'lsof']) {
      // lsof "nothing listening" is exit 1.
      fs.writeFileSync(path.join(fakeBin, tool), `#!/bin/sh\necho "$*" >> ${root}/${tool}.log\n${tool === 'lsof' ? 'exit 1' : 'exit 0'}\n`, { mode: 0o755 })
    }
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = spawnSync('bash', [path.join(HERE, 'setup-mini.sh'), '123', '456'], {
      env: { ...process.env, HOME: root, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: 'utf-8',
    })
    expect(r.status).toBe(0)
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
    expect(config).toEqual({ app_id: '123', installation_id: '456', port: 8799 })
    expect(fs.statSync(path.join(dir, 'config.json')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(root, 'bin/github-broker'), 'utf-8')).toContain('export PATH=')
    const plist = fs.readFileSync(path.join(root, 'Library/LaunchAgents/garden.github-token-broker.plist'), 'utf-8')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', path.join(root, 'Library/LaunchAgents/garden.github-token-broker.plist')])
      expect(lint.status).toBe(0)
    }
    expect(fs.readFileSync(path.join(root, 'launchctl.log'), 'utf-8')).toContain('bootstrap')
  })
})
