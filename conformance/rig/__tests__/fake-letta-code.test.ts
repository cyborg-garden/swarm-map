// @vitest-environment node
//
// The fake Letta Code, driven on its own with the environment the lab gives
// it. These prove the tripwire inside it is armed and can trip, and that it
// refuses to start the ways the shim must never start the real one.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lettaCodeArgs, lettaCodeEnv, writeLettaCodeProvider } from '../../../lib/runtimes/letta-code/shim.ts'
import { childTripwireEnv, readChildTripwire } from '../../guards/child-tripwire.ts'
import { fakeLettaCodeCommand } from '../../harnesses/letta-code.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-fakelc-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Start the fake pointed at `baseUrl`, send one message, and wait for it to stop. */
function runFake(baseUrl: string, env: Record<string, string>, args = lettaCodeArgs({ tools: [], model: 'scripted' })): Promise<{ code: number | null; stdout: string; stderr: string }> {
  for (const sub of ['home', 'work']) mkdirSync(path.join(dir, sub), { recursive: true })
  writeLettaCodeProvider(path.join(dir, 'home'), { baseUrl, placeholder: 'PLACEHOLDER-test' })
  const [bin, ...rest] = fakeLettaCodeCommand()
  const child = spawn(bin, [...rest, ...args], { cwd: path.join(dir, 'work'), env: env as NodeJS.ProcessEnv })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('"type":"result"')) child.stdin.end() })
  child.stderr.on('data', (d) => { stderr += d })
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n')
  const timer = setTimeout(() => child.kill(), 8000)
  return new Promise((resolve) => child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) }))
}
const env = (rig: Record<string, string> = {}) => lettaCodeEnv({ homeDir: path.join(dir, 'home'), rigEnv: rig })

describe('the fake Letta Code', () => {
  it('[U:child-tripwire] told to call a model outside this machine, it is stopped, and the attempt is on record', async () => {
    const log = path.join(dir, 'tripwire.log')
    // 192.0.2.1 is TEST-NET-1: reserved, never routed.
    const run = await runFake('http://192.0.2.1:9/v1', env(childTripwireEnv(log)))
    expect(run.code).not.toBe(0)
    const seen = readChildTripwire(log)
    expect(seen.armed).toBeGreaterThan(0)
    expect(seen.attempts).toEqual(['fetch 192.0.2.1'])
  }, 15_000)

  it('[U:child-tripwire] positive control: a call to this machine is let through and nothing is recorded', async () => {
    const log = path.join(dir, 'tripwire.log')
    const run = await runFake('http://127.0.0.1:9/v1', env(childTripwireEnv(log)))
    expect(run.stdout).toContain('"type":"fake_letta_code"')
    expect(readChildTripwire(log)).toMatchObject({ attempts: [] })
    expect(readChildTripwire(log).armed).toBeGreaterThan(0)
  }, 15_000)

  it.each(['DISABLE_AUTOUPDATER', 'LETTA_CODE_TELEM', 'DO_NOT_TRACK'])(
    '[U:letta-code-env] it refuses to start when %s is not set the way the lab sets it', async (name) => {
      const withOut = env()
      delete withOut[name]
      const run = await runFake('http://127.0.0.1:9/v1', withOut)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain(`fake letta code: refusing to start: ${name}`)
    }, 15_000)

  it('[U:letta-code-args] it has no server mode, so nothing that starts the chat channels can pass against it', async () => {
    for (const args of [['server', '--backend', 'local', '--channels', 'discord'], lettaCodeArgs({ tools: [], model: 'scripted' }).filter((a) => a !== '-p')]) {
      const run = await runFake('http://127.0.0.1:9/v1', env(), args)
      expect(run.code).toBe(1)
      expect(run.stderr).toContain('only the headless stream-json mode on the local backend exists here')
    }
  }, 15_000)

  it('[U:letta-code-args] like the real one, it refuses a conversation and an agent together', async () => {
    const run = await runFake('http://127.0.0.1:9/v1', env(), [...lettaCodeArgs({ tools: [], model: 'scripted' }), '--agent', 'a', '--conversation', 'c'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--conversation cannot be used with --agent')
  }, 15_000)
})
