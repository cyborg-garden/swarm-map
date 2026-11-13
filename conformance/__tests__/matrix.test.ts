// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../lib/core/rules/catalogue.ts'
import { buildMatrix, KNOWN_CHECK_IDS, ruleProof, type Matrix } from '../matrix.ts'
import { CHECKS } from '../suites/checks.ts'

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

  // A rule is claimed for a harness only on what that harness's own run showed.
  describe('rule by harness', () => {
    const rules = [
      { id: 'r.shared', checks: [] },
      { id: 'r.one', checks: ['C1'] },
      { id: 'r.two', checks: ['C1', 'C4'] },
      { id: 'r.later', checks: ['C1', 'C13'] },
    ]
    const proofOf = (results: ReturnType<typeof result>[]) =>
      Object.fromEntries(buildMatrix(meta, results, {}, quiet, rules).rules.map((r) => [r.rule, r]))

    it('[U:rule-proof] a rule is proven for a harness only when every check it names passed in that run', () => {
      const p = proofOf([result('C1', true), result('C4', true)])
      expect(p['r.one']).toEqual({ rule: 'r.one', status: 'pass', checks: [{ id: 'C1', status: 'pass' }] })
      expect(p['r.two'].status).toBe('pass')
    })

    it('[U:rule-proof] one failed check fails the rule', () => {
      const p = proofOf([result('C1', true), result('C4', false)])
      expect(p['r.two']).toEqual({ rule: 'r.two', status: 'fail', checks: [{ id: 'C1', status: 'pass' }, { id: 'C4', status: 'fail' }] })
      expect(p['r.one'].status).toBe('pass')
    })

    it('[U:rule-proof] a check that did not run leaves the rule unproven, never passed', () => {
      expect(proofOf([result('C1', true)])['r.two'].status).toBe('not-run')
      // C13 is not run for any harness yet, so a rule that leans on it is unproven even with C1 green.
      expect(proofOf([result('C1', true)])['r.later']).toEqual({
        rule: 'r.later', status: 'not-run', checks: [{ id: 'C1', status: 'pass' }, { id: 'C13', status: 'not-run' }],
      })
      expect(proofOf([])['r.one'].status).toBe('not-run')
    })

    it('[U:rule-proof] a rule that needs nothing from the harness says so, and is not counted as a harness pass', () => {
      expect(proofOf([])['r.shared']).toEqual({ rule: 'r.shared', status: 'shared', checks: [] })
    })

    it('[U:rule-proof] a rule that names a check nobody knows is refused, not quietly unproven', () => {
      expect(() => ruleProof([{ id: 'r.typo', checks: ['C99'] }], [])).toThrow(/r\.typo names C99/)
    })

    it('[U:rule-proof] every check the suite runs, and every one it lists as not run, is a known id', () => {
      expect(KNOWN_CHECK_IDS).toEqual(expect.arrayContaining([...CHECKS.map((c) => c.id), 'C6', 'C7', 'C13', 'C16']))
      expect(new Set(KNOWN_CHECK_IDS).size).toBe(KNOWN_CHECK_IDS.length)
    })

    it('[U:rule-proof] the committed matrix carries a line for every rule in the catalogue, from that run', () => {
      const file = path.resolve(import.meta.dirname, '..', 'matrix', 'pi-1.5.2.process.json')
      const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
      // Rebuilt from the rows that run recorded: the committed lines must be exactly what the rows imply.
      expect(committed.rules).toEqual(ruleProof(RULES, committed.rows))
      const status = Object.fromEntries(committed.rules.map((r) => [r.rule, r.status]))
      expect(Object.keys(status).sort()).toEqual(RULES.map((r) => r.id).sort())
      expect(status['tools.no-verdict']).toBe('pass')
      expect(status['ctl.applied']).toBe('pass')
      expect(status['priv.no-forged-identity']).toBe('not-run') // waits on C13
      expect(status['tools.unknown']).toBe('not-run') // waits on C7
      expect(status['adm.users']).toBe('shared')
    })
  })
})
