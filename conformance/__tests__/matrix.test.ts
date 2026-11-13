// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildMatrix } from '../matrix.ts'

const meta = { harness: 'pi', version: '1.5.2', harnessBuild: 'real' as const, substrate: 'process' as const, date: '2026-01-01' }
const result = (id: string, pass: boolean) => ({ id, title: `title of ${id}`, pass, detail: pass ? 'ok' : 'broke' })
// A harness that owns no chat, with its own reason for C7.
const quiet = { caps: { ownsChat: false }, rows: [{ id: 'C7', title: 't', status: 'not-run' as const, reason: 'no second tool surface' }] }

describe('conformance matrix', () => {
  it('[U:matrix] a check that ran shows pass or fail, with the reason for a fail', () => {
    const m = buildMatrix(meta, [result('C1', true), result('C4', false)], {}, quiet)
    expect(m.rows.find((r) => r.id === 'C1')).toEqual({ id: 'C1', title: 'title of C1', status: 'pass' })
    expect(m.rows.find((r) => r.id === 'C4')).toEqual({ id: 'C4', title: 'title of C4', status: 'fail', reason: 'broke' })
  })

  it('[U:matrix] a check that did not run never shows as pass', () => {
    const m = buildMatrix(meta, [result('C1', true)], {}, quiet)
    const notRun = m.rows.filter((r) => r.status === 'not-run').map((r) => r.id)
    expect(notRun).toEqual(expect.arrayContaining(['S0', 'S1', 'S2', 'S3', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C13', 'C14', 'C17']))
    for (const row of m.rows.filter((r) => r.status === 'not-run' || r.status === 'n/a')) expect(row.reason, row.id).toBeTruthy()
    expect(m.rows.find((r) => r.id === 'C16')?.status).toBe('n/a')
    // A known check that was expected to run but has no result is not-run, never pass.
    expect(m.rows.find((r) => r.id === 'C4')?.status).toBe('not-run')
  })

  it('[U:matrix] a check that cannot fail for the reason it names is not-run, never a pass', () => {
    // C13 (forged admin text) needs a tool verdict that depends on who asked. Nothing does yet.
    const m = buildMatrix(meta, [result('C1', true)], {}, quiet)
    expect(m.rows.find((r) => r.id === 'C13')).toMatchObject({ status: 'not-run', reason: expect.stringContaining('C6') })
    expect(m.rows.filter((r) => r.id === 'C13')).toHaveLength(1)
  })

  it('[U:matrix] rows that depend on the harness come from the harness, not from this file', () => {
    // A harness that owns chat: C16 is the check that matters most for it, so it can never read n/a.
    const chatty = buildMatrix({ ...meta, harness: 'letta-code' }, [], {}, { caps: { ownsChat: true }, rows: [] })
    expect(chatty.rows.find((r) => r.id === 'C16')).toMatchObject({ status: 'not-run' })
    expect(chatty.rows.find((r) => r.id === 'C7')).toMatchObject({ status: 'not-run', reason: expect.stringContaining('adapter') })
    // An adapter cannot talk C16 down to n/a for a harness that owns chat.
    const pushy = buildMatrix(meta, [], {}, { caps: { ownsChat: true }, rows: [{ id: 'C16', title: 't', status: 'n/a', reason: 'trust me' }] })
    expect(pushy.rows.find((r) => r.id === 'C16')?.status).toBe('not-run')
    // And one that owns none gets n/a with the plain reason, plus its own reason for C7.
    const m = buildMatrix(meta, [], {}, quiet)
    expect(m.rows.find((r) => r.id === 'C16')).toMatchObject({ status: 'n/a', reason: 'this harness owns no chat' })
    expect(m.rows.find((r) => r.id === 'C7')).toMatchObject({ status: 'not-run', reason: 'no second tool surface' })
    expect(JSON.stringify(m.rows)).not.toMatch(/\bPi\b/)
  })

  it('[U:matrix] it says what kind of evidence this is', () => {
    const m = buildMatrix(meta, [], {}, quiet)
    expect(m).toMatchObject({ harness: 'pi', version: '1.5.2', harnessBuild: 'real', substrate: 'process', model: 'scripted' })
    expect(m.caveats.join(' ')).toContain('scripted model')
    expect(m.caveats.join(' ')).toContain('no wall')
  })

  it('[U:matrix] the fake harness can never produce a matrix that claims to be real', () => {
    expect(() => buildMatrix({ ...meta, harnessBuild: 'fake' }, [], {}, quiet)).toThrow(/fake harness/)
  })

  it('[U:matrix] must-fail results are recorded, and a broken shim that passed is flagged', () => {
    const m = buildMatrix(meta, [], {
      'ignores-verdicts': { mustFail: ['C4', 'C5'], failed: ['C4', 'C5', 'C13'] },
      'leaks-env': { mustFail: ['C8p'], failed: [] },
    }, quiet)
    expect(m.mustFail).toEqual([
      { shim: 'ignores-verdicts', mustFail: ['C4', 'C5'], failed: ['C4', 'C5', 'C13'], suiteCaughtIt: true },
      { shim: 'leaks-env', mustFail: ['C8p'], failed: [], suiteCaughtIt: false },
    ])
    expect(m.suiteTrusted).toBe(false)
  })
})
