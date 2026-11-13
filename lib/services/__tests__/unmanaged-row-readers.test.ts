// @vitest-environment node
/**
 * The services that walk agent NAMES or take a harness ID and then read that
 * agent's Hermes home. A name or id whose stored row Swarm Map does not
 * manage (retired or unknown runtime) is not a Hermes agent, so none of them
 * may open `~/.hermes-<name>` for it, even when a directory is there.
 *
 * Each case has a twin on a managed row that proves the reader does find
 * what was planted, so "found nothing" is not a broken fixture.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const scratch = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path')
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'swarm-unmanaged-readers-'))
  const home = nodePath.join(root, 'home')
  const data = nodePath.join(root, 'data')
  nodeFs.mkdirSync(home)
  nodeFs.mkdirSync(data)
  // lib/services/data-dir reads DATA_DIR once, at import. The module-level
  // readers (usage, integrity, the resolvers) find harnesses.json through it.
  process.env.DATA_DIR = data
  return { root, home, data }
})

import { Storage } from '../storage'
import { MemoryService } from '../memory'
import { ToolsService } from '../tools'
import { ConfigService } from '../config'
import { RETIRED_RUNTIMES, UnsupportedRuntimeError } from '../runtime-adapter'
import { getCostMonth, getCostToday, getInvocationsToday, getUsageSummary } from '../usage'
import { getWriteFailureSignal, _resetIntegrityStateForTests } from '../integrity'
import { resolveTelegramUsername, resolveDiscordUsername, resolveMattermostUsername, getSignalAccountUuid } from '@/lib/resolvers'

const NAMES = ['kept', 'old', 'odd']
const rowsWith = (oldRuntime: string, oddRuntime: string) => [
  { id: 'h_kept', name: 'kept', runtime: 'hermes' },
  { id: 'h_old', name: 'old', runtime: oldRuntime },
  { id: 'h_odd', name: 'odd', runtime: oddRuntime },
]
const UNMANAGED = rowsWith(Object.keys(RETIRED_RUNTIMES)[0], 'pi-from-the-future')
const ALL_HERMES = rowsWith('hermes', 'hermes')

let storage: Storage

beforeEach(() => {
  vi.spyOn(os, 'homedir').mockReturnValue(scratch.home)
  for (const d of [scratch.home, scratch.data]) {
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d)
  }
  storage = new Storage(scratch.data)
  for (const name of NAMES) {
    const dir = path.join(scratch.home, `.hermes-${name}`)
    fs.mkdirSync(path.join(dir, 'memories'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'skills', `skill-of-${name}`), { recursive: true })
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), `mcp_servers:\n  server_of_${name}:\n    command: x\n`)
    fs.writeFileSync(path.join(dir, '.env'), `TELEGRAM_BOT_TOKEN=1:t\nMATTERMOST_URL=http://mm-${name}.invalid\nMATTERMOST_TOKEN=t\n`)
  }
  _resetIntegrityStateForTests()
})

afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(scratch.root, { recursive: true, force: true })
})

describe('readers that walk agent names skip a row Swarm Map does not manage', () => {
  it('memory scopes', () => {
    storage.write('harnesses.json', UNMANAGED)
    expect(new MemoryService(storage).list(NAMES).map((s) => s.name)).toEqual(['kept'])
  })

  it('control: memory scopes of the same names, all Hermes', () => {
    storage.write('harnesses.json', ALL_HERMES)
    expect(new MemoryService(storage).list(NAMES).map((s) => s.name).sort()).toEqual(['kept', 'odd', 'old'])
  })

  it('tool discovery', () => {
    storage.write('harnesses.json', UNMANAGED)
    const tools = new ToolsService(storage)
    const names = tools.list(NAMES).map((t) => t.name).join(' ')
    expect(names).toContain('kept')
    expect(names).not.toMatch(/of[-_]old|of[-_]odd/)
    expect(tools.discoverForHarness('old')).toEqual([])
    expect(tools.discoverForHarness('kept').length).toBeGreaterThan(0)
  })

  it('control: tool discovery of the same names, all Hermes', () => {
    storage.write('harnesses.json', ALL_HERMES)
    const tools = new ToolsService(storage)
    expect(tools.list(NAMES).map((t) => t.name).join(' ')).toMatch(/of[-_]old/)
    expect(tools.discoverForHarness('old').length).toBeGreaterThan(0)
  })

  it('surface listing', () => {
    storage.write('harnesses.json', UNMANAGED)
    const ids = new ConfigService(storage).listSurfaces(NAMES).map((s) => s.id).join(' ')
    expect(ids).toContain('kept')
    expect(ids).not.toMatch(/_old|_odd/)
  })

  it('control: surface listing of the same names, all Hermes', () => {
    storage.write('harnesses.json', ALL_HERMES)
    expect(new ConfigService(storage).listSurfaces(NAMES).map((s) => s.id).join(' ')).toMatch(/_old/)
  })
})

describe('readers that take a harness id refuse a row Swarm Map does not manage', () => {
  beforeEach(() => storage.write('harnesses.json', UNMANAGED))

  it.each([
    ['getCostToday', getCostToday],
    ['getCostMonth', getCostMonth],
    ['getInvocationsToday', getInvocationsToday],
    ['getUsageSummary', getUsageSummary],
    ['getWriteFailureSignal', getWriteFailureSignal],
  ] as Array<[string, (id: string) => unknown]>)('%s throws for the id and for the bare slug', (_name, read) => {
    expect(() => read('h_old')).toThrow(UnsupportedRuntimeError)
    expect(() => read('old')).toThrow(UnsupportedRuntimeError)
    expect(() => read('h_odd')).toThrow(UnsupportedRuntimeError)
    expect(() => read('h_kept')).not.toThrow()
  })

  it.each([
    ['telegram', () => resolveTelegramUsername('h_old', '@someone')],
    ['discord', () => resolveDiscordUsername('h_old', 'someone')],
    ['mattermost', () => resolveMattermostUsername('h_old', 'someone')],
    ['signal', () => getSignalAccountUuid('h_old')],
  ] as Array<[string, () => Promise<unknown>]>)('the %s resolver does not read the bot token out of that home', async (_name, resolve) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    await expect(resolve()).rejects.toThrow(UnsupportedRuntimeError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('control: the telegram resolver DOES read the token of a managed agent and calls out with it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    await resolveTelegramUsername('h_kept', '@someone').catch(() => null)
    expect(fetchSpy).toHaveBeenCalled()
  })
})
