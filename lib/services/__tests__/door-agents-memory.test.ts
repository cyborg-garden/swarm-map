// @vitest-environment node
/**
 * DoorAgentService: the persona, the door's notes and a kept scratch folder, as the dashboard
 * sees them. Everything is fake: a scratch data folder and a launcher stub. No Docker, no model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createMemoryStore } from '@/lib/door/memory'
import { createSanitizer } from '@/lib/door/sanitizer'
import { KEPT_SCRATCH_FILE, KEPT_SCRATCH_RULES_FILE } from '@/lib/lab/pi-discord/cell'
import { memoryDir } from '@/lib/lab/pi-discord/launch'
import { defaultPersona } from '@/lib/lab/pi-discord/persona'
import { AuditService } from '../audit'
import { DoorAgentService, DoorError } from '../door-agents'
import type { DoorLauncher } from '../door-launcher'
import { doorAgentPaths, draftRecord, renderConfig, type DoorRulesRecord } from '../door-record'
import { Storage } from '../storage'

const FIXTURES = path.resolve(__dirname, '../../lab/pi-discord/__tests__/fixtures')
const FAKE_KEY = `ghp_${'q7W3'.repeat(9)}`
let tmp: string
let dataDir: string
let storage: Storage
let live: Set<number>
let svc: DoorAgentService

const launcher = (): DoorLauncher => ({
  command: () => ({ node: '/fake/node', cli: '/fake/cli.ts' }),
  nodeProblem: () => undefined,
  dryRun: async () => ({ code: 0, output: 'RESULT: ready to start.\n' }),
  start: async () => {},
  stop: async () => ({ ok: true, output: '' }),
  alive: (pid) => live.has(pid),
})

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-mem-svc-')))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  storage = new Storage(dataDir)
  live = new Set()
  svc = new DoorAgentService({ storage, audit: new AuditService(storage), dataDir, launcher: launcher(), repoRoot: tmp, nameTaken: () => false, now: () => new Date('2026-11-17T00:00:00Z') })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Put an agent made before this change in place: its record and a state folder with no notes and no kept folder. */
function oldAgent(): DoorRulesRecord {
  const record = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'before-persona-memory.record.json'), 'utf8')) as DoorRulesRecord
  const p = doorAgentPaths(dataDir, record.id)
  fs.mkdirSync(p.stateDir, { recursive: true })
  fs.writeFileSync(p.record, JSON.stringify(record))
  fs.writeFileSync(path.join(p.stateDir, 'receipts.jsonl'), '')
  storage.write('harnesses.json', [{ id: record.id, name: record.name, runtime: record.runtime }])
  return record
}
const notesFor = (id: string) => createMemoryStore({ dir: doorAgentPaths(dataDir, id).memory, sanitizer: createSanitizer() })
const someone = { speaker: { id: 'u-1', display: 'one' }, asked: true }

describe('an agent made before persona documents and notes', () => {
  it('[U:back-compat] loads and renders unchanged, and its Memory tab says it keeps no notes', () => {
    const record = oldAgent()
    const view = svc.view(record.id)
    expect(view.record).toEqual(record)
    expect(view.problems.rules).toEqual([])
    expect(view.systemPrompt).toBe(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'before-persona-memory.expected.json'), 'utf8')).piPrompt)
    expect(renderConfig(record)).toBe(fs.readFileSync(path.join(FIXTURES, 'before-persona-memory.config.json'), 'utf8'))
    expect(svc.memory(record.id)).toEqual({ notes: false, rooms: [], limits: { noteChars: 280, fileBytes: 4096 }, scratch: null, running: false })
    // Reading it wrote nothing: no notes folder, no kept folder.
    expect(fs.readdirSync(doorAgentPaths(dataDir, record.id).stateDir)).toEqual(['receipts.jsonl'])
  })
})

describe('a new door agent', () => {
  it('[U:persona] starts with the default persona and notes on, and its rules are otherwise as closed as before', () => {
    const d = draftRecord('h_fern', 'fern', 'pi')
    expect(d.rules.persona.document).toBe(defaultPersona('fern'))
    expect(d.rules.memory).toEqual({ notes: true })
    expect(d.rules.tools).toBeUndefined()
  })
  it('[U:persona] the paths agree with the launcher\'s', () => {
    const p = doorAgentPaths(dataDir, 'h_fern')
    expect(p.memory).toBe(memoryDir(p.stateDir))
    expect(path.basename(p.keptScratch)).toBe(KEPT_SCRATCH_FILE)
    expect(path.basename(p.keptScratchRules)).toBe(KEPT_SCRATCH_RULES_FILE)
  })
})

describe('the Memory tab', () => {
  it('[U:mem-tab] shows each room\'s notes redacted, takes checked edits, wipes a room or all, and downloads', () => {
    const record = oldAgent()
    const notes = notesFor(record.id)
    notes.apply('discord:100000000000000011', { file: 'room', op: 'add', text: 'beds are watered on Friday' }, someone)
    notes.apply('discord:100000000000000099', { file: 'threads', op: 'add', text: 'other room' }, someone)
    // A secret that reached a file some other way is still never sent to the page.
    const file = path.join(doorAgentPaths(dataDir, record.id).memory, fs.readdirSync(doorAgentPaths(dataDir, record.id).memory).find((d) => fs.readFileSync(path.join(doorAgentPaths(dataDir, record.id).memory, d, 'room.json'), 'utf8').includes('11'))!, 'room.md')
    fs.appendFileSync(file, `- ${FAKE_KEY}\n`)
    const view = svc.memory(record.id)
    expect(view.rooms.map((r) => r.key)).toEqual(expect.arrayContaining(['discord:100000000000000011', 'discord:100000000000000099']))
    expect(JSON.stringify(view)).not.toContain(FAKE_KEY)
    expect(svc.memoryMarkdown(record.id).text).not.toContain(FAKE_KEY)
    expect(svc.memoryMarkdown(record.id).text).toContain('beds are watered on Friday')
    expect(svc.memoryMarkdown(record.id).name).toBe('ember-notes.md')

    expect(() => svc.saveMemory(record.id, { room: 'discord:100000000000000011', files: { room: `token ${FAKE_KEY}` } })).toThrow(DoorError)
    expect(() => svc.saveMemory(record.id, { room: 'discord:nope', files: { room: 'x' } })).toThrow(/No notes are kept for that room/)
    svc.saveMemory(record.id, { room: 'discord:100000000000000011', files: { room: 'beds are watered on Saturday' } })
    expect(notes.render('discord:100000000000000011')).toBe('About this room:\n- beds are watered on Saturday')

    svc.wipe(record.id, { room: 'discord:100000000000000011', all: null })
    expect(notes.render('discord:100000000000000011')).toBeUndefined()
    expect(notes.render('discord:100000000000000099')).toBeDefined()
    svc.wipe(record.id, { room: null, all: 'notes' })
    expect(fs.existsSync(doorAgentPaths(dataDir, record.id).memory)).toBe(false)
    expect(() => svc.wipe(record.id, { room: null, all: null })).toThrow(/Say what to wipe/)
  })

  it('[U:mem-tab] a kept scratch folder is shown, and wiped only while the agent is stopped', () => {
    const record = oldAgent()
    const p = doorAgentPaths(dataDir, record.id)
    fs.writeFileSync(p.keptScratch, Buffer.alloc(2048))
    fs.writeFileSync(p.keptScratchRules, '{}')
    expect(svc.memory(record.id).scratch).toMatchObject({ bytes: 2048, kept: false })
    fs.writeFileSync(path.join(p.stateDir, 'run.json'), JSON.stringify({ pid: 777, policyHash: 'x' }))
    live.add(777)
    expect(() => svc.wipe(record.id, { room: null, all: 'scratch' })).toThrow(/Stop the agent first/)
    expect(fs.existsSync(p.keptScratch)).toBe(true)
    live.clear()
    expect(svc.wipe(record.id, { room: null, all: 'scratch' }).scratch).toBeNull()
    expect(fs.existsSync(p.keptScratch)).toBe(false)
    expect(fs.existsSync(p.keptScratchRules)).toBe(false)
  })
})
