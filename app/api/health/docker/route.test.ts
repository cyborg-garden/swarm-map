// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: (...args: unknown[]) => execFile(...args) }
})

type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void

function ok() {
  execFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Cb) => {
    cb(null, { stdout: args[0] === '--version' ? 'Docker version 29\n' : '29\n', stderr: '' })
  })
}

beforeEach(() => {
  vi.resetModules()
  execFile.mockReset()
})

describe('GET /api/health/docker (ungated)', () => {
  it('reports availability without blocking (async exec)', async () => {
    ok()
    const { GET } = await import('./route')
    const body = await (await GET()).json()
    expect(body).toEqual({ available: true, version: 'Docker version 29', serverVersion: '29' })
  })

  it('reports unavailable when the engine does not answer', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Cb) => cb(new Error('down')))
    const { GET } = await import('./route')
    expect(await (await GET()).json()).toEqual({ available: false, error: 'Docker not found or not running' })
  })

  it('bounds docker calls: concurrent and repeat requests share one probe', async () => {
    ok()
    const { GET } = await import('./route')
    await Promise.all(Array.from({ length: 20 }, () => GET()))
    await GET()
    // one probe = `docker --version` + `docker info`
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})
