// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildMatrix } from '../matrix.ts'

const meta = { harness: 'pi', version: '1.5.2', harnessBuild: 'real' as const, substrate: 'process' as const, date: '2026-01-01' }
const result = (id: string, pass: boolean) => ({ id, title: `title of ${id}`, pass, detail: pass ? 'ok' : 'broke' })

describe('conformance matrix', () => {
  it('[U:matrix] a check that ran shows pass or fail, with the reason for a fail', () => {
    const m = buildMatrix(meta, [result('C1', true), result('C4', false)], {})
    expect(m.rows.find((r) => r.id === 'C1')).toEqual({ id: 'C1', title: 'title of C1', status: 'pass' })
    expect(m.rows.find((r) => r.id === 'C4')).toEqual({ id: 'C4', title: 'title of C4', status: 'fail', reason: 'broke' })
  })

  it('[U:matrix] a check that did not run never shows as pass', () => {
    const m = buildMatrix(meta, [result('C1', true)], {})
    const notRun = m.rows.filter((r) => r.status === 'not-run').map((r) => r.id)
    expect(notRun).toEqual(expect.arrayContaining(['S0', 'S1', 'S2', 'S3', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C14', 'C17']))
    for (const row of m.rows.filter((r) => r.status === 'not-run' || r.status === 'n/a')) expect(row.reason, row.id).toBeTruthy()
    expect(m.rows.find((r) => r.id === 'C16')?.status).toBe('n/a')
    // A known check that was expected to run but has no result is not-run, never pass.
    expect(m.rows.find((r) => r.id === 'C4')?.status).toBe('not-run')
  })

  it('[U:matrix] it says what kind of evidence this is', () => {
    const m = buildMatrix(meta, [], {})
    expect(m).toMatchObject({ harness: 'pi', version: '1.5.2', harnessBuild: 'real', substrate: 'process', model: 'scripted' })
    expect(m.caveats.join(' ')).toContain('scripted model')
    expect(m.caveats.join(' ')).toContain('no wall')
  })

  it('[U:matrix] the fake harness can never produce a matrix that claims to be real', () => {
    expect(() => buildMatrix({ ...meta, harnessBuild: 'fake' }, [], {})).toThrow(/fake harness/)
  })

  it('[U:matrix] must-fail results are recorded, and a broken shim that passed is flagged', () => {
    const m = buildMatrix(meta, [], {
      'ignores-verdicts': { mustFail: ['C4', 'C5'], failed: ['C4', 'C5', 'C13'] },
      'leaks-env': { mustFail: ['C8p'], failed: [] },
    })
    expect(m.mustFail).toEqual([
      { shim: 'ignores-verdicts', mustFail: ['C4', 'C5'], failed: ['C4', 'C5', 'C13'], suiteCaughtIt: true },
      { shim: 'leaks-env', mustFail: ['C8p'], failed: [], suiteCaughtIt: false },
    ])
    expect(m.suiteTrusted).toBe(false)
  })
})
