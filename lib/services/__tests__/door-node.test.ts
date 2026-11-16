// @vitest-environment node
/**
 * Which Node a door's start script names, and whether that Node can be used.
 *
 * The choice is checked against a made-up machine (a table of paths and the
 * versions they answer with), and once against real files: a scratch folder
 * laid out like a Homebrew prefix, with links to the Node running this test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { chooseNode, nodeProblem, runsTypeScript, realProbe, NODE_OVERRIDE_ENV, type NodeProbe } from '../door-node'

const CELLAR = '/opt/homebrew/Cellar/node@22/22.23.4_2/bin/node'
const OPT = '/opt/homebrew/opt/node@22/bin/node'

/** A machine: each path that is an executable Node, and the version it prints. */
const machine = (nodes: Record<string, string>, notExecutable: string[] = []): NodeProbe => ({
  executable: (p) => p in nodes && !notExecutable.includes(p),
  version: (p) => (p in nodes && !notExecutable.includes(p) ? nodes[p] : undefined),
})

describe('the Node a start script names', () => {
  it('is the stable opt path when this Node runs from a Homebrew Cellar', () => {
    const probe = machine({ [CELLAR]: 'v22.23.4', [OPT]: 'v22.23.4' })
    expect(chooseNode({ execPath: CELLAR, version: 'v22.23.4', env: {}, probe })).toEqual({ path: OPT, source: 'homebrew-opt' })
  })

  it('maps an unversioned formula and an Intel prefix the same way', () => {
    const cellar = '/usr/local/Cellar/node/24.22.1/bin/node'
    const opt = '/usr/local/opt/node/bin/node'
    const probe = machine({ [cellar]: 'v24.22.1', [opt]: 'v24.30.0' })
    expect(chooseNode({ execPath: cellar, version: 'v24.22.1', env: {}, probe }).path).toBe(opt)
  })

  it('stays on the Cellar path when there is no opt path to use', () => {
    const probe = machine({ [CELLAR]: 'v22.23.4' })
    expect(chooseNode({ execPath: CELLAR, version: 'v22.23.4', env: {}, probe })).toEqual({ path: CELLAR, source: 'this-node' })
  })

  it('stays on the Cellar path when the opt path is another major version', () => {
    const probe = machine({ [CELLAR]: 'v22.23.4', [OPT]: 'v24.1.0' })
    expect(chooseNode({ execPath: CELLAR, version: 'v22.23.4', env: {}, probe }).path).toBe(CELLAR)
  })

  it('leaves a path outside Homebrew as it is', () => {
    for (const p of ['/usr/local/bin/node', '/home/u/.nvm/versions/node/v24.22.1/bin/node', '/opt/homebrew/Cellar/node@22/bin/node', '/x/Cellar/a/b/c/bin/node']) {
      const probe = machine({ [p]: 'v24.22.1', '/usr/local/opt/node/bin/node': 'v24.22.1', '/x/opt/a/bin/node': 'v24.22.1', '/opt/homebrew/opt/node@22/bin/node': 'v24.22.1' })
      expect(chooseNode({ execPath: p, version: 'v24.22.1', env: {}, probe })).toEqual({ path: p, source: 'this-node' })
    }
  })

  it('is the configured override, ahead of everything else', () => {
    const probe = machine({ [CELLAR]: 'v22.23.4', [OPT]: 'v22.23.4', '/custom/node': 'v24.22.1' })
    expect(chooseNode({ execPath: CELLAR, version: 'v22.23.4', env: { [NODE_OVERRIDE_ENV]: '/custom/node' }, probe }))
      .toEqual({ path: '/custom/node', source: 'override' })
  })

  it('keeps a configured override even when it is unusable, so the refusal names it', () => {
    const probe = machine({ [CELLAR]: 'v22.23.4', [OPT]: 'v22.23.4' })
    const chosen = chooseNode({ execPath: CELLAR, version: 'v22.23.4', env: { [NODE_OVERRIDE_ENV]: '/gone/node' }, probe })
    expect(chosen).toEqual({ path: '/gone/node', source: 'override' })
    expect(nodeProblem(chosen.path, probe)).toMatch(/\/gone\/node/)
  })

  it('treats an empty override as not set', () => {
    const probe = machine({ '/usr/local/bin/node': 'v24.22.1' })
    expect(chooseNode({ execPath: '/usr/local/bin/node', version: 'v24.22.1', env: { [NODE_OVERRIDE_ENV]: '  ' }, probe }).source).toBe('this-node')
  })
})

describe('whether a Node can run the launcher', () => {
  it.each([
    ['v22.18.0', true], ['v22.23.4', true], ['v23.6.0', true], ['v24.0.0', true], ['v26.12.0', true],
    ['v22.17.9', false], ['v23.5.0', false], ['v20.19.0', false], ['v18.20.0', false], ['', false], ['node', false],
  ])('%s runs TypeScript directly: %s', (version, ok) => {
    expect(runsTypeScript(version)).toBe(ok)
  })

  it('has no problem with a Node that is there and new enough', () => {
    expect(nodeProblem(OPT, machine({ [OPT]: 'v22.23.4' }))).toBeUndefined()
  })

  it('refuses a Node that is not there', () => {
    expect(nodeProblem(OPT, machine({}))).toBe(`Node was not found at ${OPT}, or it cannot be run. Reinstall Node, or set ${NODE_OVERRIDE_ENV} to the full path of a Node that can be run, and restart Swarm Map.`)
  })

  it('refuses a Node that cannot be executed', () => {
    expect(nodeProblem(OPT, machine({ [OPT]: 'v22.23.4' }, [OPT]))).toMatch(/was not found at .*or it cannot be run/)
  })

  it('refuses a Node that is too old to run the launcher', () => {
    expect(nodeProblem(OPT, machine({ [OPT]: 'v20.19.0' }))).toBe(`The Node at ${OPT} is v20.19.0, which is too old to run the launcher. It needs Node 22.18 or newer. Upgrade Node, or set ${NODE_OVERRIDE_ENV} to the full path of a newer one, and restart Swarm Map.`)
  })

  it('refuses a Node that does not say what version it is', () => {
    const probe: NodeProbe = { executable: () => true, version: () => undefined }
    expect(nodeProblem(OPT, probe)).toMatch(/did not answer with a version/)
  })

  it('refuses an override that is not a full path', () => {
    expect(nodeProblem('node', machine({ node: 'v24.22.1' }))).toMatch(/must be a full path/)
  })
})

describe('against real files', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'door-node-'))) })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const link = (rel: string, target = process.execPath): string => {
    const p = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.symlinkSync(target, p)
    return p
  }

  it('finds the opt path beside a Cellar, and it is this major version', () => {
    const cellar = link('Cellar/node@99/99.1.0_1/bin/node')
    const opt = link('opt/node@99/bin/node')
    expect(chooseNode({ execPath: cellar, version: process.version, env: {}, probe: realProbe })).toEqual({ path: opt, source: 'homebrew-opt' })
    expect(nodeProblem(opt, realProbe)).toBeUndefined()
  })

  it('refuses a path whose keg has been removed', () => {
    const dangling = link('opt/node@99/bin/node', path.join(tmp, 'Cellar/node@99/99.0.0/bin/node'))
    expect(nodeProblem(dangling, realProbe)).toMatch(/was not found/)
  })

  it('refuses a file that is there but is not executable', () => {
    const p = path.join(tmp, 'node')
    fs.writeFileSync(p, '#!/bin/sh\necho v24.0.0\n', { mode: 0o600 })
    expect(nodeProblem(p, realProbe)).toMatch(/was not found at .*or it cannot be run/)
  })

  it('refuses a real program that reports an old version', () => {
    const p = path.join(tmp, 'node')
    fs.writeFileSync(p, '#!/bin/sh\necho v18.20.0\n', { mode: 0o700 })
    expect(nodeProblem(p, realProbe)).toMatch(/is v18\.20\.0, which is too old/)
  })
})
