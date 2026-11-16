// Load a real Claude Agent SDK from the folder it was installed in. The SDK
// is two things: a JavaScript package, and a Claude Code program for one
// platform that the package starts. Both are found here, under one install
// folder, so the program that is asked its version is the one that is run.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ClaudeSdk, SdkQuery } from './sdk.ts'

const SCOPE = '@anthropic-ai'
const PACKAGE = 'claude-agent-sdk'

/** Where the package and its program are, under `installDir/node_modules`. Throws if either is missing, or if there is more than one program. */
export function findClaudeSdk(installDir: string): { packageDir: string; executable: string; version: string } {
  const scope = path.join(installDir, 'node_modules', SCOPE)
  const packageDir = path.join(scope, PACKAGE)
  if (!existsSync(path.join(packageDir, 'package.json'))) throw new Error(`no ${SCOPE}/${PACKAGE} under ${installDir}`)
  const programs = readdirSync(scope).filter((name) => name.startsWith(`${PACKAGE}-`))
    .flatMap((name) => ['claude', 'claude.exe'].map((file) => path.join(scope, name, file))).filter((file) => existsSync(file))
  if (programs.length !== 1) throw new Error(`expected one Claude Code program beside the SDK, found ${programs.length}`)
  const version = String((JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }).version)
  return { packageDir, executable: programs[0], version }
}

export async function loadClaudeSdk(installDir: string): Promise<ClaudeSdk> {
  const found = findClaudeSdk(installDir)
  const mod = await import(pathToFileURL(path.join(found.packageDir, 'sdk.mjs')).href) as { query(args: unknown): SdkQuery }
  return {
    version: (env) => new Promise((resolve, reject) => {
      execFile(found.executable, ['--version'], { env: env as NodeJS.ProcessEnv, timeout: 30_000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(`${found.version} (Claude Agent SDK), ${stdout.trim()}`)
      })
    }),
    // The program is named, so the SDK starts the one that was just asked its version and no other.
    query: ({ prompt, options }) => mod.query({ prompt, options: { ...options, pathToClaudeCodeExecutable: found.executable } }),
  }
}
