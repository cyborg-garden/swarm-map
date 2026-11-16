// @vitest-environment node
//
// Finding a real SDK in the folder it was installed in. The program that is
// asked its version must be the one that is run, so there has to be exactly
// one, beside the package.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_SDK_VERSION, CLAUDE_SDK_VERSION_LINE } from '../caps.ts'
import { findClaudeSdk, loadClaudeSdk } from '../load.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-sdk-load-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const scope = () => path.join(dir, 'node_modules', '@anthropic-ai')
function install(version = CLAUDE_SDK_VERSION, programs: string[] = ['claude-agent-sdk-linux-arm64']): void {
  mkdirSync(path.join(scope(), 'claude-agent-sdk'), { recursive: true })
  writeFileSync(path.join(scope(), 'claude-agent-sdk', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version }))
  writeFileSync(path.join(scope(), 'claude-agent-sdk', 'sdk.mjs'), 'export const query = (args) => args\n')
  for (const name of programs) {
    mkdirSync(path.join(scope(), name), { recursive: true })
    // A stand-in for the program: it only knows how to say its version.
    writeFileSync(path.join(scope(), name, 'claude'), '#!/bin/sh\necho "2.1.325 (Claude Code)"\n', { mode: 0o755 })
  }
}

describe('loading the SDK from its install folder', () => {
  it('[U:claude-sdk-version] finds the package, its version and the one program beside it', () => {
    install()
    expect(findClaudeSdk(dir)).toEqual({
      packageDir: path.join(scope(), 'claude-agent-sdk'), version: CLAUDE_SDK_VERSION,
      executable: path.join(scope(), 'claude-agent-sdk-linux-arm64', 'claude'),
    })
  })

  it('[U:claude-sdk-version] refuses a folder with no SDK, with no program, or with more than one', () => {
    expect(() => findClaudeSdk(dir)).toThrow('no @anthropic-ai/claude-agent-sdk under')
    install(CLAUDE_SDK_VERSION, [])
    expect(() => findClaudeSdk(dir)).toThrow('expected one Claude Code program beside the SDK, found 0')
    install(CLAUDE_SDK_VERSION, ['claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-x64'])
    expect(() => findClaudeSdk(dir)).toThrow('found 2')
  })

  it('[U:claude-sdk-version] what it says it is comes from the package on disk and from the program itself, and the program it names is the one it starts', async () => {
    install()
    const sdk = await loadClaudeSdk(dir)
    expect(await sdk.version({ PATH: '/usr/bin:/bin' })).toBe(CLAUDE_SDK_VERSION_LINE)
    const passed = sdk.query({ prompt: (async function* () {})(), options: { cwd: '/x' } as never }) as unknown as { options: { pathToClaudeCodeExecutable: string; cwd: string } }
    expect(passed.options).toEqual({ cwd: '/x', pathToClaudeCodeExecutable: path.join(scope(), 'claude-agent-sdk-linux-arm64', 'claude') })
    // Another package version on disk is another line, which the shim will not send a turn to.
    rmSync(dir, { recursive: true, force: true })
    install('0.3.326')
    expect(await (await loadClaudeSdk(dir)).version({ PATH: '/usr/bin:/bin' })).toBe('0.3.326 (Claude Agent SDK), 2.1.325 (Claude Code)')
  })
})
