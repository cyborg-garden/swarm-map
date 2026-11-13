// @vitest-environment node
/**
 * Where an agent's home is, for every way the code asks.
 *
 * Three rules are in use, each written out below exactly as the code has
 * them: from an ID (routes, resolvers, the admins service), from a NAME
 * (keys, tools, memory, the surface list), and from a container's SERVICE
 * name (discovery). This test plants a marker in the directory each rule
 * names and checks that the real reader finds it there, for a spread of
 * names: hyphens, underscores, dots, capitals, an `h_` at the front, a
 * leading separator, and "personal". Key writes, the admins service and the
 * routes check an id's shape first (isValidHarnessId) and refuse one that
 * fails it; the test expects that refusal for those shapes.
 *
 * It pins the mapping. A change that moves any agent's home, for any of
 * these shapes, fails here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { agentDataDirForName, guessDataDir } from '../harness'
import { agentDataDir as adminsAgentDataDir, isValidHarnessId } from '../surface-admins'
import { KeysService } from '../keys'
import { MemoryService } from '../memory'
import { ToolsService } from '../tools'
import { ConfigService } from '../config'
import { AuditService } from '../audit'
import { Storage } from '../storage'
import { resolveTelegramUsername } from '@/lib/resolvers'
import { GET as pairingGET } from '@/app/api/harnesses/[id]/pairing/route'

let home: string
let storage: Storage

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-home-rule-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  storage = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-home-rule-store-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(storage.getBaseDir(), { recursive: true, force: true })
})

// ---- the three rules, as the code has them --------------------------------

/** From an id: drop one `h_`, turn every `_` into `-`. */
const homeOfId = (id: string) => {
  const name = id.replace(/^h_/, '').replace(/_/g, '-')
  return name === 'personal' ? path.join(home, '.hermes') : path.join(home, `.hermes-${name}`)
}

/** From a name: used as it stands. */
const homeOfName = (name: string) => (name === 'personal' ? path.join(home, '.hermes') : path.join(home, `.hermes-${name}`))

/** From a container's service name. */
const homeOfService = (serviceName: string, containerName: string) => {
  if (containerName === 'hermes-personal' || serviceName === 'hermes-personal') return path.join(home, '.hermes')
  if (!serviceName) return path.join(home, '.hermes-' + (containerName || 'unknown'))
  if (serviceName.startsWith('hermes-')) return path.join(home, '.' + serviceName)
  return path.join(home, '.hermes-' + serviceName)
}

const NAMES = ['iris', 'seraph-doer', 'foo_bar', 'foo.bar', 'Mixed-Case', 'UPPER', 'h_prefixed', 'a-b_c.d', '-x', '_x', 'x-', 'personal', 'personal-2']
/** The id discovery gives a container named `hermes-<name>`. */
const idOf = (name: string) => 'h_' + name.replace(/-/g, '_')
const IDS = [...new Set([...NAMES.map(idOf), ...NAMES])]

describe('from a name', () => {
  it.each(NAMES)('agentDataDirForName(%s)', (name) => {
    expect(agentDataDirForName(name)).toBe(homeOfName(name))
  })

  it.each(NAMES)('key discovery and key writes use the home of %s', (name) => {
    const keys = new KeysService(storage, new AuditService(storage))
    fs.mkdirSync(homeOfName(name), { recursive: true })
    fs.writeFileSync(path.join(homeOfName(name), '.env'), 'BRAVE_SEARCH_API_KEY=planted-value\n')
    expect(keys.list([name]).map((k) => k.provider)).toEqual(['brave'])
    // A write takes an id or a name, and checks its shape first.
    if (!isValidHarnessId(name)) {
      expect(() => keys.writeKeyToEnv(name, 'notion', 'written-value')).toThrow(/invalid harness id/i)
      return
    }
    // Anything starting `h_` is read as an id.
    const written = name.startsWith('h_') ? homeOfId(name) : homeOfName(name)
    expect(keys.writeKeyToEnv(name, 'notion', 'written-value')).toBe(true)
    expect(fs.readFileSync(path.join(written, '.env'), 'utf-8')).toContain('NOTION_API_KEY=written-value')
  })

  it.each(NAMES)('memory, tool and surface discovery read the home of %s', (name) => {
    const dir = homeOfName(name)
    fs.mkdirSync(path.join(dir, 'memories'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'mcp_servers:\n  planted_server:\n    command: x\n')
    fs.writeFileSync(path.join(dir, '.env'), 'MATTERMOST_URL=http://mm.invalid\nMATTERMOST_TOKEN=t\n')
    expect(new MemoryService(storage).list([name]).map((s) => s.name)).toEqual([name])
    expect(new ToolsService(storage).discover([name]).map((t) => t.name).join(' ')).toContain('planted_server')
    expect(new ConfigService(storage).listSurfaces([name]).map((s) => s.platform)).toContain('mattermost')
  })
})

describe('from an id', () => {
  it.each(IDS)('a key written by the id %s lands in its home', (id) => {
    const keys = new KeysService(storage, new AuditService(storage))
    // Keys take an id or a name: an `h_` id is converted, anything else is a name.
    const want = id.startsWith('h_') ? homeOfId(id) : homeOfName(id)
    if (!isValidHarnessId(id)) {
      expect(() => keys.writeKeyToEnv(id, 'notion', 'written-value')).toThrow(/invalid harness id/i)
      expect(fs.readdirSync(home)).toEqual([])
      return
    }
    expect(keys.writeKeyToEnv(id, 'notion', 'written-value')).toBe(true)
    expect(fs.readFileSync(path.join(want, '.env'), 'utf-8')).toContain('NOTION_API_KEY=written-value')
    expect(fs.readdirSync(home)).toEqual([path.basename(want)])
  })

  it.each(IDS)('the admins service maps %s, or refuses it, as its id rule says', (id) => {
    if (isValidHarnessId(id)) expect(adminsAgentDataDir(id)).toBe(homeOfId(id))
    else expect(() => adminsAgentDataDir(id)).toThrow(/invalid harness id/i)
  })

  it.each(IDS)('a route that works from the URL id reads the home of %s', async (id) => {
    const dir = path.join(homeOfId(id), 'platforms', 'pairing')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'discord-approved.json'), JSON.stringify({ planted: { user_name: 'p', approved_at: 1 } }))
    const res = await pairingGET(new Request('http://localhost/x'), { params: Promise.resolve({ id }) })
    if (!isValidHarnessId(id)) {
      expect(res.status).toBe(400)
      return
    }
    expect((await res.json()).users.map((u: { userId: string }) => u.userId)).toEqual(['planted'])
  })

  it.each(IDS)('a username resolver reads the bot token from the home of %s', async (id) => {
    fs.mkdirSync(homeOfId(id), { recursive: true })
    fs.writeFileSync(path.join(homeOfId(id), '.env'), 'TELEGRAM_BOT_TOKEN=999:planted\n')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    await resolveTelegramUsername(id, '@someone').catch(() => null)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('999:planted')
  })
})

describe('from a container', () => {
  it.each(NAMES)('guessDataDir for the container hermes-%s', (name) => {
    const service = `hermes-${name}`
    expect(guessDataDir(service, service)).toBe(homeOfService(service, service))
  })

  it('the other shapes of service name', () => {
    for (const [service, container] of [
      ['', 'hermes-x'],
      ['', ''],
      ['seraph-thinker', 'seraph-thinker'],
      ['custom', 'custom-1'],
      ['hermes-personal', 'whatever'],
      ['anything', 'hermes-personal'],
    ]) {
      expect(guessDataDir(service, container), `${service} / ${container}`).toBe(homeOfService(service, container))
    }
  })
})
