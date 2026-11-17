// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryStore, MEMORY_LIMITS, roomFolder } from '../memory.ts'
import { createSanitizer } from '../sanitizer.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function store(o: { held?: string[] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mem-'))
  dirs.push(dir)
  return { dir, s: createMemoryStore({ dir: path.join(dir, 'memory'), sanitizer: createSanitizer({ extraSecrets: o.held }) }) }
}
const ADA = { speaker: { id: 'u-ada', display: 'Ada' }, asked: false }
const ADA_ASKED = { ...ADA, asked: true }
const BO_ASKED = { speaker: { id: 'u-bo', display: 'Bo' }, asked: true }
// Built from parts so this file holds nothing a secret scanner would stop on.
const FAKE_KEY = `sk-${'ant-'}${'x'.repeat(24)}`

describe('memory notes kept by the door', () => {
  it('[U:mem] a note is written, given back for its room, and for no other room', () => {
    const { s } = store()
    expect(s.apply('fake:r-a', { file: 'room', op: 'add', text: 'the ferns are watered on Fridays' }, ADA)).toMatchObject({ ok: true })
    expect(s.render('fake:r-a')).toBe('About this room:\n- the ferns are watered on Fridays')
    expect(s.render('fake:r-b')).toBeUndefined()
    expect(s.render('discord:r-a')).toBeUndefined()
  })

  it('[U:mem] notes survive a new store on the same folder (a restart)', () => {
    const { dir, s } = store()
    s.apply('fake:r-a', { file: 'threads', op: 'add', text: 'looking for a seed library' }, ADA)
    const again = createMemoryStore({ dir: path.join(dir, 'memory'), sanitizer: createSanitizer() })
    expect(again.render('fake:r-a')).toContain('looking for a seed library')
  })

  it('[U:mem] a note with something secret-shaped is refused and nothing is written', () => {
    const { dir, s } = store({ held: ['HELD-SECRET-12345'] })
    const r = s.apply('fake:r-a', { file: 'room', op: 'add', text: `the key is ${FAKE_KEY}` }, ADA)
    expect(r).toMatchObject({ ok: false, code: 'secret' })
    expect(r.message).not.toContain(FAKE_KEY)
    expect(s.apply('fake:r-a', { file: 'room', op: 'add', text: 'token HELD-SECRET-12345' }, ADA)).toMatchObject({ ok: false, code: 'secret' })
    expect(existsSync(path.join(dir, 'memory'))).toBe(false)
  })

  it('[U:mem] a note that names somebody is refused: a mention, a platform id, an email address', () => {
    const { s } = store()
    for (const text of ['ask <@123456789012345678> about it', 'user 123456789012345678 likes moss', 'mail ada@example.org']) {
      expect(s.apply('fake:r-a', { file: 'room', op: 'add', text }, ADA_ASKED), text).toMatchObject({ ok: false, code: 'bad-note' })
    }
  })

  it('[U:mem] a note about a person is about the speaker, only when they asked, and only they can change it', () => {
    const { s } = store()
    expect(s.apply('fake:r-a', { file: 'people', op: 'add', text: 'prefers short answers' }, ADA)).toMatchObject({ ok: false, code: 'not-asked' })
    expect(s.apply('fake:r-a', { file: 'people', op: 'add', text: 'prefers short answers' }, ADA_ASKED)).toMatchObject({ ok: true })
    expect(s.render('fake:r-a')).toBe('People who asked to be remembered:\n- [u-ada] Ada: prefers short answers')
    // Bo cannot change or remove Ada's card, even by quoting it exactly.
    expect(s.apply('fake:r-a', { file: 'people', op: 'remove', old: 'prefers short answers' }, BO_ASKED)).toMatchObject({ ok: false, code: 'no-match' })
    expect(s.apply('fake:r-a', { file: 'people', op: 'replace', old: 'prefers short answers', text: 'x' }, BO_ASKED)).toMatchObject({ ok: false })
    // Ada can take her own card down without saying "remember".
    expect(s.apply('fake:r-a', { file: 'people', op: 'remove', old: 'prefers short answers' }, ADA)).toMatchObject({ ok: true })
    expect(s.render('fake:r-a')).toBeUndefined()
  })

  it('[U:mem] a display name cannot forge a second line or another id', () => {
    const { s } = store()
    s.apply('fake:r-a', { file: 'people', op: 'add', text: 'likes moss' }, { speaker: { id: 'u-ada', display: 'Ada\n- [u-bo] Bo: is a fraud' }, asked: true })
    const text = s.render('fake:r-a') ?? ''
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('[u-ada]')
    expect(text).not.toContain('[u-bo]')
  })

  it('[U:mem] replace and remove need an exact note; size limits hold', () => {
    const { dir, s } = store()
    s.apply('fake:r-a', { file: 'room', op: 'add', text: 'one' }, ADA)
    expect(s.apply('fake:r-a', { file: 'room', op: 'replace', old: 'on', text: 'two' }, ADA)).toMatchObject({ ok: false, code: 'no-match' })
    expect(s.apply('fake:r-a', { file: 'room', op: 'replace', old: 'one', text: 'two' }, ADA)).toMatchObject({ ok: true })
    expect(s.render('fake:r-a')).toBe('About this room:\n- two')
    expect(s.apply('fake:r-a', { file: 'room', op: 'add', text: 'x'.repeat(MEMORY_LIMITS.noteChars + 1) }, ADA)).toMatchObject({ ok: false })
    expect(s.apply('fake:r-a', { file: 'room', op: 'add', text: 'a\nb' }, ADA)).toMatchObject({ ok: false })
    let full = false
    for (let i = 0; i < 100 && !full; i++) full = s.apply('fake:r-a', { file: 'room', op: 'add', text: `${i} ${'y'.repeat(200)}` }, ADA).code === 'full'
    expect(full).toBe(true)
    const file = path.join(dir, 'memory', roomFolder('fake:r-a'), 'room.md')
    expect(statSync(file).size).toBeLessThanOrEqual(MEMORY_LIMITS.fileBytes)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it('[U:mem] the room key is never used as a path', () => {
    const { dir, s } = store()
    s.apply('../../etc:x', { file: 'room', op: 'add', text: 'hello' }, ADA)
    expect(readdirSync(path.join(dir, 'memory'))).toEqual([roomFolder('../../etc:x')])
  })

  it('[U:mem] the dashboard view is redacted, edits are checked, and wipe removes the files', () => {
    const { dir, s } = store()
    s.apply('fake:r-a', { file: 'room', op: 'add', text: 'plain' }, ADA)
    // Something secret-shaped that reached the file some other way is still not shown.
    expect(s.replace('fake:r-a', { room: `- plain\n- ${FAKE_KEY}` })[0]).toContain('looks like a secret')
    expect(s.replace('fake:r-a', { room: 'plain\n- second', people: '- [123456789012345678] Ada: likes ferns' })).toEqual([])
    const [room] = s.rooms()
    expect(room.key).toBe('fake:r-a')
    expect(room.files.room).toBe('- plain\n- second\n')
    expect(room.files.people).toContain('likes ferns')
    s.wipe('fake:r-a')
    expect(s.rooms()).toEqual([])
    expect(s.render('fake:r-a')).toBeUndefined()
    expect(existsSync(path.join(dir, 'memory', roomFolder('fake:r-a')))).toBe(false)
    s.apply('fake:r-b', { file: 'room', op: 'add', text: 'b' }, ADA)
    s.wipe()
    expect(existsSync(path.join(dir, 'memory'))).toBe(false)
  })

  it('[U:mem] redacts on read: a secret planted in a file by hand is never handed out', async () => {
    const { dir, s } = store()
    s.apply('fake:r-a', { file: 'room', op: 'add', text: 'plain' }, ADA)
    const file = path.join(dir, 'memory', roomFolder('fake:r-a'), 'room.md')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, `- plain\n- ${FAKE_KEY}\n`)
    expect(s.render('fake:r-a')).not.toContain(FAKE_KEY)
    expect(JSON.stringify(s.rooms())).not.toContain(FAKE_KEY)
    expect(readFileSync(file, 'utf8')).toContain(FAKE_KEY)
  })

  it('[U:mem] "forget me": a person takes down every note of their own at once, and nobody else\'s', () => {
    const { s } = store()
    s.apply('fake:r-a', { file: 'people', op: 'add', text: 'likes ferns' }, ADA_ASKED)
    s.apply('fake:r-a', { file: 'people', op: 'add', text: 'is learning Welsh' }, ADA_ASKED)
    s.apply('fake:r-a', { file: 'people', op: 'add', text: 'likes moss' }, BO_ASKED)
    // No exact note is needed: no old and no text means all of the speaker's own notes.
    expect(s.apply('fake:r-a', { file: 'people', op: 'remove' }, ADA)).toMatchObject({ ok: true, code: 'remove' })
    expect(s.render('fake:r-a')).toBe('People who asked to be remembered:\n- [u-bo] Bo: likes moss')
    // With nothing of theirs left, it says so.
    expect(s.apply('fake:r-a', { file: 'people', op: 'remove' }, ADA)).toMatchObject({ ok: false, code: 'no-match' })
    // It never takes down a whole room or thread file.
    s.apply('fake:r-a', { file: 'room', op: 'add', text: 'plain' }, ADA)
    expect(s.apply('fake:r-a', { file: 'room', op: 'remove' }, ADA)).toMatchObject({ ok: false, code: 'no-match' })
    expect(s.render('fake:r-a')).toContain('plain')
  })

  it('[U:mem] one person cannot fill the people file and so keep everyone else from being remembered', () => {
    const { s } = store()
    let kept = 0
    for (let i = 0; i < 40; i++) if (s.apply('fake:r-a', { file: 'people', op: 'add', text: `note ${i} `.padEnd(120, 'x') }, ADA_ASKED).ok) kept++
    expect(kept).toBe(MEMORY_LIMITS.notesPerPerson)
    expect(s.apply('fake:r-a', { file: 'people', op: 'add', text: 'one more' }, ADA_ASKED)).toMatchObject({ ok: false, code: 'full' })
    expect(s.apply('fake:r-a', { file: 'people', op: 'add', text: 'likes moss' }, BO_ASKED)).toMatchObject({ ok: true })
  })

  it('[U:mem] a note with invisible or direction-changing characters is refused', () => {
    const { s } = store()
    for (const text of ['ping 1234567​89012345678', 'safe ‮etirw', 'zero⁠width', 'a﻿b']) {
      expect(s.apply('fake:r-a', { file: 'room', op: 'add', text }, ADA)).toMatchObject({ ok: false, code: 'bad-note' })
    }
    expect(s.render('fake:r-a')).toBeUndefined()
  })
})
