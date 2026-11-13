// @vitest-environment node
//
// The shared suite is what every shim must pass, so it must name no harness.
// Everything that differs between harnesses comes in through a
// HarnessUnderTest (suites/harness.ts). This guard reads the shared files and
// fails if one of them reaches into a runtime, an adapter, or a harness's
// native names again.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HARNESSES } from '../../lib/door/protocol.ts'
import { fakePiCommand, piHarness } from '../harnesses/pi.ts'
import { CHECKS } from '../suites/checks.ts'
import { brokenVariants } from '../suites/harness.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const SHARED = ['suites/lab.ts', 'suites/checks.ts', 'suites/harness.ts', 'matrix.ts', 'broken/chatty.ts']
// Code only: a comment may mention a harness by way of example.
const code = (file: string): string =>
  readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('the shared shim suite names no harness', () => {
  it.each(SHARED)('[U:harness-blind] %s imports no runtime and no adapter', (file) => {
    const imports = [...code(file).matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((i) => i.includes('/runtimes/') || i.includes('/harnesses/'))).toEqual([])
  })

  it.each(SHARED)('[U:harness-blind] %s holds no harness name and no native tool name', (file) => {
    const literals = [...code(file).matchAll(/'([^'\n]*)'/g)].map((m) => m[1])
    const nativeTools = Object.keys(piHarness(fakePiCommand(), 'fake').caps.toolMap)
    const named = literals.filter((l) => (HARNESSES as string[]).includes(l) || nativeTools.includes(l))
    expect(named).toEqual([])
    expect(code(file)).not.toMatch(/\bpi[A-Z]\w*|\bPi\b|\bPI_/)
  })

  it('[U:harness-blind] a second harness can be put through the checks by writing an adapter and nothing else', () => {
    // The adapter is plain data plus two functions; the suite asks it for everything it needs.
    const pi = piHarness(fakePiCommand(), 'fake')
    expect(Object.keys(pi).sort()).toEqual(['broken', 'build', 'caps', 'cellEnv', 'modelShape', 'rows', 'shell', 'start', 'tripwire', 'workFile'])
    const ids = CHECKS.map((c) => c.id)
    for (const v of Object.values(brokenVariants(pi))) for (const id of [...v.red, ...v.green]) expect(ids).toContain(id)
  })
})
