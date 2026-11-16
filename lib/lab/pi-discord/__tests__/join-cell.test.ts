// @vitest-environment node
//
// The last step of a start: the cell joins the door, and a cell that dialled
// before the door was listening is started again, once. Here the clock, the
// door and Docker are all handed in, so every wait is exact and nothing is
// slept through. Needs no Docker.
import { describe, expect, it } from 'vitest'
import { cellStopStartArgs } from '../cell.ts'
import { joinCell, type JoinDeps } from '../launch.ts'

const WAITS = { redialMs: 3_000, readyMs: 60_000 }

/**
 * A door, a cell and a clock. `dials` says how the cell behaves each time it is
 * started: the number of milliseconds after which it reaches the door, or
 * `never`. The first entry is the cell as `start` first brought it up.
 */
function world(o: {
  dials: (number | 'never')[]
  stopFails?: boolean
  startFails?: boolean
  /** What the look from outside finds wrong with the cell once it was started again. */
  unsealed?: string[]
  /** The door goes on holding the stopped cell's link for this long. */
  linkHeldMs?: number
}) {
  let now = 0
  let run = 0
  let startedAt = 0
  let stopped = false
  // Until when the door goes on holding the link of a cell that was stopped while connected.
  let heldUntil = 0
  const calls: string[] = []
  const dialsAt = (): number | undefined => {
    const dial = o.dials[run]
    return stopped || dial === undefined || dial === 'never' ? undefined : startedAt + dial
  }
  const live = (): boolean => { const at = dialsAt(); return at !== undefined && now >= at }
  // A link the door has not yet seen close still reads as a connected shim.
  const held = (): boolean => now < heldUntil
  const deps: JoinDeps = {
    async ready(ms) {
      calls.push(`ready ${ms}`)
      if (live() || held()) return true
      const at = dialsAt()
      if (at !== undefined && at <= now + ms) { now = at; return true }
      now += ms
      return false
    },
    stopStart(what) {
      calls.push(what)
      if (what === 'stop') {
        if (o.stopFails) return false
        if (live()) heldUntil = now + (o.linkHeldMs ?? 0)
        stopped = true
        return true
      }
      if (o.startFails) return false
      run += 1
      // The door takes one shim at a time: a cell started while the old link is held is turned away, and does not dial again.
      if (held()) o.dials[run] = 'never'
      startedAt = now
      stopped = false
      return true
    },
    sealProblems() { calls.push('seal'); return o.unsealed ?? [] },
    async pause(ms) { calls.push(`pause ${ms}`); now += ms },
    now: () => now,
    log: (line) => { calls.push(`log: ${line}`) },
  }
  return { deps, calls, clock: () => now, starts: () => calls.filter((c) => c === 'start').length, stops: () => calls.filter((c) => c === 'stop').length }
}

describe('the cell joins the door', () => {
  it('a cell that reaches the door in time is left alone: nothing is stopped, started or looked at again', async () => {
    const w = world({ dials: [1_200] })
    await joinCell(w.deps, WAITS)
    expect(w.calls).toEqual(['ready 3000'])
    expect(w.clock()).toBe(1_200)
  })

  it('a cell that has not reached the door after exactly the redial wait is stopped, started once, looked at from outside, and waited for', async () => {
    const w = world({ dials: ['never', 500] })
    await joinCell(w.deps, WAITS)
    expect(w.calls).toEqual([
      'ready 3000', 'stop', 'pause 300', 'ready 0', 'start', 'seal',
      'log: the cell had not reached the door, so it was started again', 'ready 60000',
    ])
    // The redial wait, the pause for the door to see the link close, and the half second the second cell took.
    expect(w.clock()).toBe(3_000 + 300 + 500)
  })

  it('the wait is the one it is given, to the millisecond: a cell one millisecond late is started again, one on time is not', async () => {
    const late = world({ dials: [3_001, 10] })
    await joinCell(late.deps, WAITS)
    expect(late.starts()).toBe(1)
    const onTime = world({ dials: [3_000] })
    await joinCell(onTime.deps, WAITS)
    expect(onTime.starts()).toBe(0)
    const shorter = world({ dials: [800, 10] })
    await joinCell(shorter.deps, { redialMs: 500, readyMs: 1_000 })
    expect(shorter.starts()).toBe(1)
  })

  it('it is started again once and no more: a cell that still does not reach the door fails the start, after the full wait', async () => {
    const w = world({ dials: ['never', 'never', 5] })
    await expect(joinCell(w.deps, WAITS)).rejects.toThrow('the cell did not reach the door in time')
    expect([w.stops(), w.starts()]).toEqual([1, 1])
    expect(w.clock()).toBe(3_000 + 300 + 60_000)
    expect(w.calls.at(-1)).toBe('ready 60000')
  })

  it('a cell that is not sealed once it was started again fails the start, and is never waited for', async () => {
    const w = world({ dials: ['never', 5], unsealed: ['the cell has a route off its own network'] })
    await expect(joinCell(w.deps, WAITS)).rejects.toThrow('the cell is not sealed: the cell has a route off its own network')
    expect(w.calls.slice(-2)).toEqual(['start', 'seal'])
    expect(w.calls.some((c) => c.startsWith('log:'))).toBe(false)
  })

  it('a cell that cannot be stopped is not started, and one that cannot be started is not waited for', async () => {
    const stuck = world({ dials: ['never', 5], stopFails: true })
    await expect(joinCell(stuck.deps, WAITS)).rejects.toThrow(/could not be stopped to be started again/)
    expect(stuck.calls).toEqual(['ready 3000', 'stop'])
    const dead = world({ dials: ['never', 5], startFails: true })
    await expect(joinCell(dead.deps, WAITS)).rejects.toThrow(/could not be started again/)
    expect(dead.calls.slice(-1)).toEqual(['start'])
    expect(dead.calls).not.toContain('seal')
  })

  it('asked to, it starts a cell again that had reached the door, and waits for the door to see the old link close first', async () => {
    const w = world({ dials: [100, 400], linkHeldMs: 420 })
    await joinCell(w.deps, { ...WAITS, force: true })
    // 300 ms, then every 50 ms until the door no longer holds the stopped cell's link: at 450 ms it is gone.
    expect(w.calls).toEqual([
      'ready 3000', 'stop', 'pause 300', 'ready 0', 'pause 50', 'ready 0', 'pause 50', 'ready 0', 'pause 50', 'ready 0',
      'start', 'seal', 'log: the cell was started again', 'ready 60000',
    ])
    expect(w.clock()).toBe(100 + 450 + 400)
  })

  it('a door that still holds the stopped cell\'s link is not taken for a cell that came back: the start fails, and no cell is started', async () => {
    // Without this the wait that follows would see the old link, and a start with no cell behind it would be called live.
    const w = world({ dials: [100, 400], linkHeldMs: 60_000 })
    await expect(joinCell(w.deps, { ...WAITS, force: true })).rejects.toThrow(/the door still holds the link of the cell that was stopped/)
    expect(w.starts()).toBe(0)
    expect(w.calls).not.toContain('seal')
    // It gave the door five seconds, and no longer.
    expect(w.clock()).toBeGreaterThanOrEqual(100 + 300 + 5_000)
    expect(w.clock()).toBeLessThan(100 + 300 + 5_000 + 100)
  })
})

describe('what Docker is asked, to stop the cell and to start it again', () => {
  it('names the run\'s one cell container, and gives the stop one second, by the flag every Docker takes', () => {
    // `--time` is the old spelling: Docker no longer lists it, and will drop it. `-t` is in every version.
    expect(cellStopStartArgs('smlab-0badf00d', 'stop')).toEqual(['stop', '-t', '1', 'smlab-0badf00d-cell-1'])
    expect(cellStopStartArgs('smlab-0badf00d', 'start')).toEqual(['start', 'smlab-0badf00d-cell-1'])
  })

  it('refuses a name that is not a lab project', () => {
    for (const bad of ['smlab-0badf00d; rm -rf /', '--all', 'other-0badf00d', '']) expect(() => cellStopStartArgs(bad, 'stop')).toThrow(/REFUSING TO RUN: F5/)
  })
})
