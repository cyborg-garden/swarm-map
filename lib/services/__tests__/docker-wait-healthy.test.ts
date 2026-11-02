// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const exec = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execFileSync: exec.fn }))

import { DockerService } from '../docker'

describe('DockerService.waitHealthy', () => {
  beforeEach(() => exec.fn.mockReset())
  const inspectReturns = (...outs: string[]) => {
    let i = 0
    exec.fn.mockImplementation((cmd: string) => {
      if (cmd === 'sleep') return Buffer.from('')
      return Buffer.from(outs[Math.min(i++, outs.length - 1)])
    })
  }

  it('true once healthy and running', () => {
    inspectReturns('starting|true', 'healthy|true')
    expect(new DockerService().waitHealthy('gluetun-private', 5000)).toBe(true)
  })

  it('false at once for a missing container or no healthcheck', () => {
    exec.fn.mockImplementation((cmd: string) => { if (cmd !== 'sleep') throw new Error('no such container'); return Buffer.from('') })
    expect(new DockerService().waitHealthy('gluetun-private', 60000)).toBe(false)
    inspectReturns('none|true')
    expect(new DockerService().waitHealthy('gluetun-private', 60000)).toBe(false)
  })

  it('false (before the timeout) for a container that stays down', () => {
    vi.useFakeTimers()
    let now = 0
    vi.setSystemTime(0)
    exec.fn.mockImplementation((cmd: string) => {
      if (cmd === 'sleep') { now += 2000; vi.setSystemTime(now); return Buffer.from('') }
      return Buffer.from('unhealthy|false')
    })
    expect(new DockerService().waitHealthy('gluetun-private', 90000)).toBe(false)
    expect(now).toBeLessThan(30000)
    vi.useRealTimers()
  })
})
