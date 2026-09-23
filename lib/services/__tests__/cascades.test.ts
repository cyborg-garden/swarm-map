/**
 * Tests for CascadeLibraryService — the named cascade library.
 *
 * A cascade is a saved, named CHAIN (chain[0] = primary, the rest = fallbacks)
 * that can be applied (ported) to any harness. Persisted at DATA_DIR/cascades.json. Names are
 * trimmed, 1–64 chars, unique case-insensitively. api_key is never stored.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CascadeLibraryService, CascadeLibraryError } from '../cascades'
import { Storage } from '../storage'
import { AuditService } from '../audit'
import fs from 'fs'
import path from 'path'
import os from 'os'

const ENTRIES = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
]

describe('CascadeLibraryService', () => {
  let tmpDir: string
  let storage: Storage
  let audit: AuditService
  let cascades: CascadeLibraryService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascades-'))
    storage = new Storage(tmpDir)
    audit = new AuditService(storage)
    cascades = new CascadeLibraryService(storage, audit)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // --- CRUD --------------------------------------------------------------

  it('starts empty', () => {
    expect(cascades.list()).toEqual([])
    expect(cascades.get('nope')).toBeUndefined()
  })

  it('saves a cascade and persists it to cascades.json', () => {
    const rec = cascades.save({ name: 'fleet-default', chain: ENTRIES, sourceHarness: 'h_test' })
    expect(rec.name).toBe('fleet-default')
    expect(rec.chain).toEqual(ENTRIES)
    expect(rec.sourceHarness).toBe('h_test')
    expect(typeof rec.createdAt).toBe('number')
    expect(rec.updatedAt).toBe(rec.createdAt)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].name).toBe('fleet-default')

    // A fresh service instance over the same dir sees it.
    const again = new CascadeLibraryService(storage, audit)
    expect(again.get('fleet-default')?.chain).toEqual(ENTRIES)
  })

  it('get() is case-insensitive and trims', () => {
    cascades.save({ name: 'Fleet-Default', chain: ENTRIES })
    expect(cascades.get('fleet-default')?.name).toBe('Fleet-Default')
    expect(cascades.get('  FLEET-DEFAULT ')?.name).toBe('Fleet-Default')
  })

  it('lists cascades sorted by name (case-insensitive)', () => {
    cascades.save({ name: 'zeta', chain: ENTRIES })
    cascades.save({ name: 'Alpha', chain: ENTRIES })
    cascades.save({ name: 'beta', chain: ENTRIES })
    expect(cascades.list().map((c) => c.name)).toEqual(['Alpha', 'beta', 'zeta'])
  })

  it('update() replaces chain and bumps updatedAt, keeping createdAt', () => {
    const rec = cascades.save({ name: 'x', chain: ENTRIES })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const updated = cascades.update('x', next)
    expect(updated.chain).toEqual(next)
    expect(updated.createdAt).toBe(rec.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt)
    expect(cascades.get('x')?.chain).toEqual(next)
  })

  it('update() of a missing cascade throws not_found', () => {
    expect(() => cascades.update('missing', ENTRIES)).toThrow(CascadeLibraryError)
    try {
      cascades.update('missing', ENTRIES)
    } catch (e) {
      expect((e as CascadeLibraryError).status).toBe(404)
    }
  })

  it('rename() changes the name and keeps everything else', () => {
    const rec = cascades.save({ name: 'old', chain: ENTRIES, sourceHarness: 'h_a' })
    const renamed = cascades.rename('old', 'new')
    expect(renamed.name).toBe('new')
    expect(renamed.chain).toEqual(ENTRIES)
    expect(renamed.sourceHarness).toBe('h_a')
    expect(renamed.createdAt).toBe(rec.createdAt)
    expect(cascades.get('old')).toBeUndefined()
    expect(cascades.get('new')).toBeDefined()
  })

  it('rename() to a name that already exists (any case) conflicts with 409', () => {
    cascades.save({ name: 'one', chain: ENTRIES })
    cascades.save({ name: 'two', chain: ENTRIES })
    try {
      cascades.rename('one', 'TWO')
      throw new Error('expected conflict')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(409)
    }
    expect(cascades.get('one')).toBeDefined()
  })

  it('rename() to the same name with different casing is allowed', () => {
    cascades.save({ name: 'fleet', chain: ENTRIES })
    expect(cascades.rename('fleet', 'Fleet').name).toBe('Fleet')
    expect(cascades.list()).toHaveLength(1)
  })

  it('remove() deletes and returns true; false when missing', () => {
    cascades.save({ name: 'gone', chain: ENTRIES })
    expect(cascades.remove('GONE')).toBe(true)
    expect(cascades.get('gone')).toBeUndefined()
    expect(cascades.remove('gone')).toBe(false)
  })

  // --- Conflict rule -----------------------------------------------------
  //
  // Rule: save() with a name that already exists (case-insensitively) throws a
  // 409 CascadeLibraryError UNLESS overwrite:true. With overwrite, the existing
  // record's chain/sourceHarness are replaced, its createdAt is preserved,
  // and the stored name adopts the new casing.

  it('save() with an existing name throws 409 conflict by default', () => {
    cascades.save({ name: 'dup', chain: ENTRIES })
    try {
      cascades.save({ name: 'DUP', chain: [{ provider: 'openai', model: 'gpt-5' }] })
      throw new Error('expected conflict')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(409)
      expect((e as CascadeLibraryError).code).toBe('conflict')
    }
    // Nothing changed.
    expect(cascades.list()).toHaveLength(1)
    expect(cascades.get('dup')?.chain).toEqual(ENTRIES)
  })

  it('save() with overwrite:true replaces the existing record, preserving createdAt', () => {
    const first = cascades.save({ name: 'dup', chain: ENTRIES, sourceHarness: 'h_a' })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const second = cascades.save({ name: 'Dup', chain: next, sourceHarness: 'h_b' }, { overwrite: true })
    expect(cascades.list()).toHaveLength(1)
    expect(second.name).toBe('Dup')
    expect(second.chain).toEqual(next)
    expect(second.sourceHarness).toBe('h_b')
    expect(second.createdAt).toBe(first.createdAt)
  })

  // --- Name validation ---------------------------------------------------

  it('trims the name', () => {
    expect(cascades.save({ name: '  padded  ', chain: ENTRIES }).name).toBe('padded')
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'a'.repeat(65)],
  ])('rejects an invalid name (%s) with 400', (_label, name) => {
    try {
      cascades.save({ name, chain: ENTRIES })
      throw new Error('expected invalid')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(400)
    }
    expect(cascades.list()).toHaveLength(0)
  })

  it('accepts a 64-char name', () => {
    expect(cascades.save({ name: 'b'.repeat(64), chain: ENTRIES }).name).toHaveLength(64)
  })

  // --- Entry validation --------------------------------------------------

  it('rejects empty chain with 400', () => {
    expect(() => cascades.save({ name: 'x', chain: [] })).toThrow(CascadeLibraryError)
  })

  it('rejects an entry with a missing model or provider with 400', () => {
    expect(() =>
      cascades.save({ name: 'x', chain: [{ provider: 'anthropic', model: '' }] })
    ).toThrow(CascadeLibraryError)
    expect(() =>
      cascades.save({ name: 'x', chain: [{ provider: '', model: 'claude-sonnet-4-6' }] })
    ).toThrow(CascadeLibraryError)
    expect(cascades.list()).toHaveLength(0)
  })

  it('never stores api_key (stripped from chain on save and update)', () => {
    const dirty = [
      { provider: 'openrouter', model: 'moonshotai/kimi', api_key: 'sk-or-SECRET-VALUE', base_url: 'https://openrouter.ai/api/v1' },
    ]
    const rec = cascades.save({ name: 'secret', chain: dirty as never })
    expect(rec.chain[0]).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi',
      base_url: 'https://openrouter.ai/api/v1',
    })
    expect(JSON.stringify(rec)).not.toContain('SECRET')
    const onDisk = fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8')
    expect(onDisk).not.toContain('SECRET')
    expect(onDisk).not.toContain('api_key')

    cascades.update('secret', dirty as never)
    expect(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8')).not.toContain('SECRET')
  })

  it('drops unknown fields and trims provider/model', () => {
    const rec = cascades.save({
      name: 'x',
      chain: [{ provider: ' anthropic ', model: ' claude-sonnet-4-6 ', extra: 'junk' } as never],
    })
    expect(rec.chain[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })

  it('rejects chain that cannot be written as plain YAML scalars (newline, ": ", " #", leading indicator) with 400 and stores nothing', () => {
    const bad = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6\nmodel: injected\ntoolsets: [oops]' },
      { provider: 'anthropic\nfoo: bar', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://h:11434/v1\nplatforms: {}' },
      { provider: 'anthropic', model: 'foo: bar' },
      { provider: 'anthropic', model: 'foo #bar' },
      { provider: 'anthropic', model: '@cf/meta/llama' },
      { provider: 'anthropic', model: 'foo:' },
    ]
    for (const entry of bad) {
      try {
        cascades.save({ name: 'x', chain: [entry] })
        throw new Error('expected 400 for ' + JSON.stringify(entry))
      } catch (e) {
        expect(e, JSON.stringify(entry)).toBeInstanceOf(CascadeLibraryError)
        expect((e as CascadeLibraryError).status, JSON.stringify(entry)).toBe(400)
      }
    }
    expect(cascades.list()).toHaveLength(0)
    expect(fs.existsSync(path.join(tmpDir, 'cascades.json'))).toBe(false)

    // update() runs the same sanitizer
    cascades.save({ name: 'ok', chain: ENTRIES })
    expect(() => cascades.update('ok', [bad[0]])).toThrow(CascadeLibraryError)
    expect(cascades.get('ok')?.chain).toEqual(ENTRIES)
  })

  it('still accepts real-world ids with inner colons, slashes and dots', () => {
    const rec = cascades.save({
      name: 'real',
      chain: [
        { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
        { provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6-20250527-v1:0' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
      ],
    })
    expect(rec.chain).toHaveLength(3)
  })

  // --- edit(): atomic rename + chain -----------------------------------

  it('edit() with a conflicting rename AND new chain is 409 and changes nothing (atomic)', () => {
    cascades.save({ name: 'fleet', chain: ENTRIES })
    cascades.save({ name: 'other', chain: ENTRIES })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    try {
      cascades.edit('fleet', { name: 'OTHER', chain: next })
      throw new Error('expected conflict')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(409)
    }
    expect(cascades.get('fleet')?.chain).toEqual(ENTRIES)
    expect(cascades.get('other')?.chain).toEqual(ENTRIES)
    expect(audit.query({ what: 'cascade:save' })).toHaveLength(2) // the two saves only
  })

  it('edit() with a valid rename AND invalid chain is 400 and changes nothing (atomic)', () => {
    cascades.save({ name: 'fleet', chain: ENTRIES })
    expect(() =>
      cascades.edit('fleet', { name: 'renamed', chain: [{ provider: 'anthropic', model: '' }] })
    ).toThrow(CascadeLibraryError)
    expect(cascades.get('fleet')?.chain).toEqual(ENTRIES)
    expect(cascades.get('renamed')).toBeUndefined()
    expect(audit.query({ what: 'cascade:save' })).toHaveLength(1)
  })

  it('edit() renames and replaces chain in ONE write with ONE audit row', () => {
    const rec = cascades.save({ name: 'fleet', chain: ENTRIES, sourceHarness: 'h_a' })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const out = cascades.edit('fleet', { name: 'renamed', chain: next })
    expect(out).toMatchObject({ name: 'renamed', chain: next, sourceHarness: 'h_a', createdAt: rec.createdAt })
    expect(cascades.get('fleet')).toBeUndefined()
    expect(cascades.list()).toHaveLength(1)
    const log = audit.query({ what: 'cascade:save' })
    expect(log).toHaveLength(2)
    expect(log[0].meta).toMatchObject({ name: 'renamed', harness: 'h_a', renamedFrom: 'fleet' })
  })

  it('edit() with an empty patch throws 400; on a missing cascade throws 404', () => {
    cascades.save({ name: 'fleet', chain: ENTRIES })
    expect(() => cascades.edit('fleet', {})).toThrow(CascadeLibraryError)
    try {
      cascades.edit('ghost', { chain: ENTRIES })
      throw new Error('expected not_found')
    } catch (e) {
      expect((e as CascadeLibraryError).status).toBe(404)
    }
  })

  // --- Audit -------------------------------------------------------------

  it('audits save, rename, update and delete', () => {
    cascades.save({ name: 'a', chain: ENTRIES, sourceHarness: 'h_src' })
    cascades.update('a', ENTRIES)
    cascades.rename('a', 'b')
    cascades.remove('b')

    const log = audit.query({}).reverse() // chronological
    expect(log.map((e) => e.what)).toEqual([
      'cascade:save',
      'cascade:save',
      'cascade:save',
      'cascade:delete',
    ])
    expect(log[0].who).toBe('api')
    expect(log[0].target).toBe('a')
    expect(log[0].meta).toMatchObject({ name: 'a', harness: 'h_src' })
    expect(log[2].meta).toMatchObject({ name: 'b', renamedFrom: 'a' })
    expect(log[3].target).toBe('b')
    expect(log[3].meta).toMatchObject({ name: 'b' })
  })

  it('does not audit a conflicting save or a failed remove', () => {
    cascades.save({ name: 'a', chain: ENTRIES })
    expect(() => cascades.save({ name: 'a', chain: ENTRIES })).toThrow()
    cascades.remove('missing')
    expect(audit.query({})).toHaveLength(1)
  })
})

describe('CascadeLibraryService — migration from the `entries` records (pre chain semantics)', () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascades-migrate-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads an old record as a chain (entries[0] is the primary) without rewriting the file', () => {
    const old = [{ name: 'legacy', entries: ENTRIES, createdAt: 1, updatedAt: 2, sourceHarness: 'h_old' }]
    fs.writeFileSync(path.join(tmpDir, 'cascades.json'), JSON.stringify(old))
    const storage = new Storage(tmpDir)
    const cascades = new CascadeLibraryService(storage, new AuditService(storage))
    const rec = cascades.get('legacy')!
    expect(rec.chain).toEqual(ENTRIES)
    expect((rec as unknown as { entries?: unknown }).entries).toBeUndefined()
    expect(rec).toMatchObject({ name: 'legacy', createdAt: 1, updatedAt: 2, sourceHarness: 'h_old' })
    expect(cascades.list().map((c) => c.name)).toEqual(['legacy'])
    // Read-only migration: the file is untouched until something writes.
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8'))).toEqual(old)
    // The next write persists the migrated shape for every record.
    cascades.save({ name: 'new', chain: ENTRIES })
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8'))
    expect(onDisk.map((r: { name: string; chain?: unknown; entries?: unknown }) => [r.name, Array.isArray(r.chain), 'entries' in r])).toEqual([
      ['legacy', true, false],
      ['new', true, false],
    ])
  })
})
