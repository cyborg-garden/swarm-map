// @vitest-environment node
//
// The tripwire in a test file guards the test process only. The harness is a
// child process, and every model call comes from that child, so the child has
// to carry its own tripwire or "nothing left this machine" says nothing about
// it. These tests drive the fake Pi on its own, with the same environment the
// lab gives it, and prove the tripwire inside it is armed and can trip.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { piArgs, piEnv } from '../../../lib/runtimes/pi/shim.ts'
import { childTripwireEnv, readChildTripwire } from '../../guards/child-tripwire.ts'
import { fakePiCommand } from '../../harnesses/pi.ts'

const GATE = path.resolve(import.meta.dirname, '..', '..', '..', 'lib', 'runtimes', 'pi', 'cell', 'gate.ts')

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-fakepi-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Start the fake Pi pointed at `baseUrl`, send one prompt, and wait for it to stop. */
function runFakePi(baseUrl: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  for (const sub of ['agent', 'sessions', 'work', 'home']) mkdirSync(path.join(dir, sub), { recursive: true })
  writeFileSync(path.join(dir, 'agent', 'models.json'), JSON.stringify({
    providers: { swarm: { baseUrl, api: 'openai-completions', apiKey: 'PLACEHOLDER-test', models: [{ id: 'scripted' }] } },
  }))
  const [bin, ...rest] = fakePiCommand()
  const args = piArgs({ sessionDir: path.join(dir, 'sessions'), tools: [], gate: { path: GATE }, model: 'scripted' })
  const child = spawn(bin, [...rest, ...args], { cwd: path.join(dir, 'work'), env: env as NodeJS.ProcessEnv })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.stdin.write(JSON.stringify({ type: 'prompt', id: 'p1', message: 'hello' }) + '\n')
  const timer = setTimeout(() => child.kill(), 8000)
  return new Promise((resolve) => child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) }))
}
const env = (rig: Record<string, string> = {}) =>
  piEnv({ agentDir: path.join(dir, 'agent'), homeDir: path.join(dir, 'home'), rigEnv: rig })

describe('the tripwire inside the harness process', () => {
  it('[U:child-tripwire] a fake Pi that is told to call a model outside this machine is stopped, and the attempt is on record', async () => {
    const log = path.join(dir, 'tripwire.log')
    // 192.0.2.1 is TEST-NET-1: reserved, never routed.
    const run = await runFakePi('http://192.0.2.1:9/v1', env(childTripwireEnv(log)))
    expect(run.code).not.toBe(0)
    const seen = readChildTripwire(log)
    expect(seen.armed).toBeGreaterThan(0)
    expect(seen.attempts).toEqual(['fetch 192.0.2.1'])
  }, 15_000)

  it('[U:child-tripwire] positive control: a call to this machine is let through and nothing is recorded', async () => {
    const log = path.join(dir, 'tripwire.log')
    // Port 9 on loopback: nothing listens, so the call fails, but it was allowed to be made.
    const run = await runFakePi('http://127.0.0.1:9/v1', env(childTripwireEnv(log)))
    expect(run.stdout).toContain('"type":"fake_pi"')
    const seen = readChildTripwire(log)
    expect(seen.armed).toBeGreaterThan(0)
    expect(seen.attempts).toEqual([])
  }, 15_000)

  it('[U:child-tripwire] a process started without the tripwire leaves no record, which reads as not armed', () => {
    expect(readChildTripwire(path.join(dir, 'never-written.log'))).toEqual({ armed: 0, attempts: [] })
  })

  it('[U:child-tripwire] the log is plain lines, so the record is exactly what the child wrote', () => {
    const log = path.join(dir, 'tripwire.log')
    writeFileSync(log, 'armed 41\narmed 42\ntrip net.connect 192.0.2.1:9\ntrip dns.lookup example.com\n')
    expect(readChildTripwire(log)).toEqual({ armed: 2, attempts: ['net.connect 192.0.2.1:9', 'dns.lookup example.com'] })
    expect(readFileSync(log, 'utf8')).toContain('armed 41')
  })

  it.each(['PI_OFFLINE', 'PI_TELEMETRY', 'PI_SKIP_VERSION_CHECK'])(
    '[U:pi-env] the fake Pi refuses to start when %s is not set the way the lab sets it', async (name) => {
      const withOut = env()
      delete withOut[name]
      const run = await runFakePi('http://127.0.0.1:9/v1', withOut)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(`fake pi: refusing to start: ${name}`)
    }, 15_000)
})
