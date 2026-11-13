// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileLedger, createMemoryLedger, monthOf } from '../spend-ledger.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-ledger-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOV = new Date('2026-11-13T10:00:00Z')
const DEC = new Date('2026-12-01T00:00:00Z')

describe('spend ledger', () => {
  it('[U:budget-ledger] a month is a UTC calendar month', () => {
    expect(monthOf(new Date('2026-11-30T23:59:59Z'))).toBe('2026-11')
    expect(monthOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12')
  })

  it.each([
    ['memory', () => createMemoryLedger()],
    ['file', () => createFileLedger(path.join(dir, 'spend.json'))],
  ])('[U:budget-ledger] %s: spend adds up within a month and is kept apart between months', (_kind, make) => {
    const ledger = make()
    expect(ledger.spent(NOV)).toBe(0)
    ledger.add(NOV, 1.5); ledger.add(NOV, 0.25); ledger.add(DEC, 4)
    expect(ledger.spent(NOV)).toBe(1.75)
    expect(ledger.spent(DEC)).toBe(4)
  })

  it('[U:budget-ledger] the file ledger is read back by the next process, and leaves no half-written file', () => {
    const file = path.join(dir, 'spend.json')
    createFileLedger(file).add(NOV, 3)
    expect(createFileLedger(file).spent(NOV)).toBe(3)
    expect(readdirSync(dir)).toEqual(['spend.json'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: 1, months: { '2026-11': 3 } })
  })

  it.each([
    ['not JSON', 'spent: lots'],
    ['the wrong shape', '{"months":[1,2]}'],
    ['a figure that is not a number', '{"schema":1,"months":{"2026-11":"3"}}'],
    ['a negative figure', '{"schema":1,"months":{"2026-11":-3}}'],
    ['empty', ''],
  ])('[U:budget-ledger] a ledger file that is %s is refused, not read as zero', (_what, content) => {
    const file = path.join(dir, 'spend.json')
    writeFileSync(file, content)
    expect(() => createFileLedger(file)).toThrow(/spend ledger: .* refusing to start from zero/)
  })

  it('[U:budget-ledger] spend that is not a real amount is refused', () => {
    const ledger = createMemoryLedger()
    expect(() => ledger.add(NOV, Number.NaN)).toThrow(/spend ledger/)
    expect(() => ledger.add(NOV, -1)).toThrow(/spend ledger/)
  })
})
