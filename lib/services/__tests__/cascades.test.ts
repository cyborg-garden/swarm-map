/**
 * Tests for CascadeLibraryService — the named cascade library.
 *
 * A cascade is a saved, named fallback_providers list that can be applied
 * (ported) to any harness. Persisted at DATA_DIR/cascades.json. Names are
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
    const rec = cascades.save({ name: 'fleet-default', entries: ENTRIES, sourceHarness: 'h_test' })
    expect(rec.name).toBe('fleet-default')
    expect(rec.entries).toEqual(ENTRIES)
    expect(rec.sourceHarness).toBe('h_test')
    expect(typeof rec.createdAt).toBe('number')
    expect(rec.updatedAt).toBe(rec.createdAt)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].name).toBe('fleet-default')

    // A fresh service instance over the same dir sees it.
    const again = new CascadeLibraryService(storage, audit)
    expect(again.get('fleet-default')?.entries).toEqual(ENTRIES)
  })

  it('get() is case-insensitive and trims', () => {
    cascades.save({ name: 'Fleet-Default', entries: ENTRIES })
    expect(cascades.get('fleet-default')?.name).toBe('Fleet-Default')
    expect(cascades.get('  FLEET-DEFAULT ')?.name).toBe('Fleet-Default')
  })

  it('lists cascades sorted by name (case-insensitive)', () => {
    cascades.save({ name: 'zeta', entries: ENTRIES })
    cascades.save({ name: 'Alpha', entries: ENTRIES })
    cascades.save({ name: 'beta', entries: ENTRIES })
    expect(cascades.list().map((c) => c.name)).toEqual(['Alpha', 'beta', 'zeta'])
  })

  it('update() replaces entries and bumps updatedAt, keeping createdAt', () => {
    const rec = cascades.save({ name: 'x', entries: ENTRIES })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const updated = cascades.update('x', next)
    expect(updated.entries).toEqual(next)
    expect(updated.createdAt).toBe(rec.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt)
    expect(cascades.get('x')?.entries).toEqual(next)
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
    const rec = cascades.save({ name: 'old', entries: ENTRIES, sourceHarness: 'h_a' })
    const renamed = cascades.rename('old', 'new')
    expect(renamed.name).toBe('new')
    expect(renamed.entries).toEqual(ENTRIES)
    expect(renamed.sourceHarness).toBe('h_a')
    expect(renamed.createdAt).toBe(rec.createdAt)
    expect(cascades.get('old')).toBeUndefined()
    expect(cascades.get('new')).toBeDefined()
  })

  it('rename() to a name that already exists (any case) conflicts with 409', () => {
    cascades.save({ name: 'one', entries: ENTRIES })
    cascades.save({ name: 'two', entries: ENTRIES })
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
    cascades.save({ name: 'fleet', entries: ENTRIES })
    expect(cascades.rename('fleet', 'Fleet').name).toBe('Fleet')
    expect(cascades.list()).toHaveLength(1)
  })

  it('remove() deletes and returns true; false when missing', () => {
    cascades.save({ name: 'gone', entries: ENTRIES })
    expect(cascades.remove('GONE')).toBe(true)
    expect(cascades.get('gone')).toBeUndefined()
    expect(cascades.remove('gone')).toBe(false)
  })

  // --- Conflict rule -----------------------------------------------------
  //
  // Rule: save() with a name that already exists (case-insensitively) throws a
  // 409 CascadeLibraryError UNLESS overwrite:true. With overwrite, the existing
  // record's entries/sourceHarness are replaced, its createdAt is preserved,
  // and the stored name adopts the new casing.

  it('save() with an existing name throws 409 conflict by default', () => {
    cascades.save({ name: 'dup', entries: ENTRIES })
    try {
      cascades.save({ name: 'DUP', entries: [{ provider: 'openai', model: 'gpt-5' }] })
      throw new Error('expected conflict')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(409)
      expect((e as CascadeLibraryError).code).toBe('conflict')
    }
    // Nothing changed.
    expect(cascades.list()).toHaveLength(1)
    expect(cascades.get('dup')?.entries).toEqual(ENTRIES)
  })

  it('save() with overwrite:true replaces the existing record, preserving createdAt', () => {
    const first = cascades.save({ name: 'dup', entries: ENTRIES, sourceHarness: 'h_a' })
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const second = cascades.save({ name: 'Dup', entries: next, sourceHarness: 'h_b' }, { overwrite: true })
    expect(cascades.list()).toHaveLength(1)
    expect(second.name).toBe('Dup')
    expect(second.entries).toEqual(next)
    expect(second.sourceHarness).toBe('h_b')
    expect(second.createdAt).toBe(first.createdAt)
  })

  // --- Name validation ---------------------------------------------------

  it('trims the name', () => {
    expect(cascades.save({ name: '  padded  ', entries: ENTRIES }).name).toBe('padded')
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too long', 'a'.repeat(65)],
  ])('rejects an invalid name (%s) with 400', (_label, name) => {
    try {
      cascades.save({ name, entries: ENTRIES })
      throw new Error('expected invalid')
    } catch (e) {
      expect(e).toBeInstanceOf(CascadeLibraryError)
      expect((e as CascadeLibraryError).status).toBe(400)
    }
    expect(cascades.list()).toHaveLength(0)
  })

  it('accepts a 64-char name', () => {
    expect(cascades.save({ name: 'b'.repeat(64), entries: ENTRIES }).name).toHaveLength(64)
  })

  // --- Entry validation --------------------------------------------------

  it('rejects empty entries with 400', () => {
    expect(() => cascades.save({ name: 'x', entries: [] })).toThrow(CascadeLibraryError)
  })

  it('rejects an entry with a missing model or provider with 400', () => {
    expect(() =>
      cascades.save({ name: 'x', entries: [{ provider: 'anthropic', model: '' }] })
    ).toThrow(CascadeLibraryError)
    expect(() =>
      cascades.save({ name: 'x', entries: [{ provider: '', model: 'claude-sonnet-4-6' }] })
    ).toThrow(CascadeLibraryError)
    expect(cascades.list()).toHaveLength(0)
  })

  it('never stores api_key (stripped from entries on save and update)', () => {
    const dirty = [
      { provider: 'openrouter', model: 'moonshotai/kimi', api_key: 'sk-or-SECRET-VALUE', base_url: 'https://openrouter.ai/api/v1' },
    ]
    const rec = cascades.save({ name: 'secret', entries: dirty as never })
    expect(rec.entries[0]).toEqual({
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
      entries: [{ provider: ' anthropic ', model: ' claude-sonnet-4-6 ', extra: 'junk' } as never],
    })
    expect(rec.entries[0]).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })

  // --- Audit -------------------------------------------------------------

  it('audits save, rename, update and delete', () => {
    cascades.save({ name: 'a', entries: ENTRIES, sourceHarness: 'h_src' })
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
    cascades.save({ name: 'a', entries: ENTRIES })
    expect(() => cascades.save({ name: 'a', entries: ENTRIES })).toThrow()
    cascades.remove('missing')
    expect(audit.query({})).toHaveLength(1)
  })
})
