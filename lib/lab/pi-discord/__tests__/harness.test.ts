// @vitest-environment node
//
// The launcher with the harness as a setting. A config that names none is
// Pi, exactly as before: the same config, the same images, the same cell.
// Naming Letta Code picks its shim, its cell image and what it declares
// about itself. Needs no Docker.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { labSubnetBase, pickSubnets } from '../../../../conformance/docker/subnets.ts'
import { LETTA_CODE_VERSION } from '../../../runtimes/letta-code/caps.ts'
import { PI_VERSION } from '../../../runtimes/pi/caps.ts'
import { lettaCodeArgs, lettaCodeSystemPromptProblem } from '../../../runtimes/letta-code/shim.ts'
import { CELL_ENV, buildHint, launcherImages, renderCell, sealProblems, type CellOptions } from '../cell.ts'
import { harnessLines, harnessOf, parseConfig, policyFor, systemPromptFor } from '../config.ts'
import { fitProblems } from '../../../core/policy/fit.ts'
import { harnessFacts, isLauncherHarness, LAUNCHER_HARNESSES } from '../harnesses.ts'

const good = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agentId: 'lab-agent',
  discord: { guildId: '700000000000000001', channelId: '710000000000000001', adminUserIds: ['800000000000000001'] },
  budget: { monthlyUsd: 5 },
  model: { baseUrl: 'https://model.example/v1', id: 'lab/model', usdPerMTokIn: 1, usdPerMTokOut: 5 },
  ...extra,
})

const cellNonce = '0123456789abcdef'.repeat(2)
const [cellBlock, egressBlock, outsideBlock] = pickSubnets(3, [], labSubnetBase(), 0)
const options: CellOptions = {
  nonce: '0badf00d', cellNonce, brainToken: `BRAIN-${cellNonce}-0123456789abcdef`, brainPort: 50001, routePort: 50002,
  model: 'lab/model', systemPrompt: 'You are Fern. You have no tools.', subnets: { cell: cellBlock, egress: egressBlock, outside: outsideBlock },
}

describe('the harness is a setting of the config', () => {
  it('a config that names no harness is Pi, and is read exactly as it was before the setting existed', () => {
    const { config, errors } = parseConfig(good())
    expect(errors).toEqual([])
    expect(harnessOf(config!)).toBe('pi')
    expect('harness' in config!).toBe(false)
    // Naming Pi is the same as naming nothing: the same config, so the same policy and the same rendered files.
    const named = parseConfig(good({ harness: 'pi' }))
    expect(named.errors).toEqual([])
    expect(named.config).toEqual(config)
    expect(policyFor(named.config!).hash).toBe(policyFor(config!).hash)
  })

  it('Letta Code can be named, and nothing else can', () => {
    const { config, errors } = parseConfig(good({ harness: 'letta-code' }))
    expect(errors).toEqual([])
    expect(config!.harness).toBe('letta-code')
    expect(harnessOf(config!)).toBe('letta-code')
    for (const bad of ['hermes', 'Pi', '', 7, null, ['pi']]) {
      const refused = parseConfig(good({ harness: bad }))
      expect(refused.config, String(bad)).toBeUndefined()
      expect(refused.errors.join('\n')).toMatch(/harness: must be one of pi, letta-code/)
    }
    expect(LAUNCHER_HARNESSES).toEqual(['pi', 'letta-code'])
    expect([isLauncherHarness('letta-code'), isLauncherHarness('hermes'), isLauncherHarness(undefined)]).toEqual([true, false, false])
  })

  it('the harness does not change who is heard: the same rules give the same policy', () => {
    const pi = policyFor(parseConfig(good()).config!)
    const lc = policyFor(parseConfig(good({ harness: 'letta-code' })).config!)
    expect(lc).toEqual(pi)
  })
})

describe('what each harness is, from what its shim declares', () => {
  it('the pinned version and the label are the shim\'s own', () => {
    expect(harnessFacts('pi')).toMatchObject({ label: 'Pi', version: PI_VERSION, oneRoomOnly: false })
    expect(harnessFacts('letta-code')).toMatchObject({ label: 'Letta Code', version: LETTA_CODE_VERSION, oneRoomOnly: true })
  })

  it('Letta Code\'s one-room limit is said plainly, and Pi is not said to have it', () => {
    expect(harnessFacts('letta-code').limits.join('\n')).toMatch(/One room only\. It keeps one memory for the whole agent/)
    expect(harnessFacts('pi').limits.join('\n')).not.toMatch(/One room only/)
    expect(harnessFacts('pi').limits.join('\n')).toMatch(/keeps no memory of its own/)
    for (const h of LAUNCHER_HARNESSES) expect(harnessFacts(h).limits.join('\n')).toMatch(/No tools/)
  })

  it('the policy a config becomes fits what Letta Code declares, and one with a second room would not', () => {
    // The door makes this check itself, from the shim's hello. Here it is made from the same declaration,
    // to show that what the pages say about one room is what the door will enforce.
    const policy = policyFor(parseConfig(good({ harness: 'letta-code' })).config!)
    expect(fitProblems(policy, harnessFacts('letta-code').caps)).toEqual([])
    const two = structuredClone(policy)
    two.surfaces.discord!.rooms.push({ match: { room: '710000000000000002' }, mode: 'mention' })
    expect(fitProblems(two, harnessFacts('letta-code').caps).join('\n')).toMatch(/mem\.one-scope/)
    expect(fitProblems(two, harnessFacts('pi').caps)).toEqual([])
  })

  it('the dry run states the harness, its pinned version and its limits', () => {
    const pi = harnessLines(parseConfig(good()).config!)
    expect(pi[0]).toBe(`  ok    harness: Pi ${PI_VERSION}, pinned. The cell image holds this version and no other`)
    expect(pi.join('\n')).not.toMatch(/One room only/)
    const lc = harnessLines(parseConfig(good({ harness: 'letta-code' })).config!)
    expect(lc[0]).toBe(`  ok    harness: Letta Code ${LETTA_CODE_VERSION}, pinned. The cell image holds this version and no other`)
    expect(lc.join('\n')).toMatch(/ {2}note {2}One room only/)
    // No line of it can be read as a failed check by whoever reads the dry run.
    for (const line of [...pi, ...lc]) expect(line.trim()).toMatch(/^(ok|note) /)
  })
})

describe('the cell, by harness', () => {
  it('with no harness named the cell is Pi\'s, as it always was', () => {
    const file = renderCell(options)
    expect(file).toEqual(renderCell({ ...options, harness: 'pi' }))
    expect(file.services.cell.image).toMatch(/^smlabpd-cell:pi-[0-9.]+-[0-9a-f]{12}$/)
    expect(file.services.cell.command).toEqual(['node', '/opt/swarm/conformance/docker/cell-main.ts'])
    expect(launcherImages()).toEqual(launcherImages('pi'))
    expect(buildHint('pi')).toBe('Run: node lib/lab/pi-discord/cli.ts build')
  })

  it('Letta Code gets its own cell image and entry, and the same sealed cell around it', () => {
    const file = renderCell({ ...options, harness: 'letta-code' })
    const pi = renderCell(options)
    expect(sealProblems(file)).toEqual([])
    expect(file.services.cell.image).toMatch(new RegExp(`^smlabpd-cell:letta-code-${LETTA_CODE_VERSION.replace(/\./g, '\\.')}-[0-9a-f]{12}$`))
    expect(file.services.cell.image).toBe(launcherImages('letta-code').cell)
    expect(file.services.cell.command).toEqual(['node', '/opt/swarm/conformance/docker/letta-code/cell-main.ts'])
    // Everything but the image and the entry is the cell Pi gets: the relay, the networks, the limits, what it is handed.
    expect({ ...file, services: { ...file.services, cell: { ...file.services.cell, image: '', command: [] } } })
      .toEqual({ ...pi, services: { ...pi.services, cell: { ...pi.services.cell, image: '', command: [] } } })
    expect(Object.keys(file.services.cell.environment).sort()).toEqual(CELL_ENV)
    expect(launcherImages('letta-code').rig).toBe(launcherImages('pi').rig)
    expect(buildHint('letta-code')).toBe('Run: node lib/lab/pi-discord/cli.ts build --harness letta-code')
  })

  it('a harness the launcher does not have is refused before a cell is written', () => {
    expect(() => renderCell({ ...options, harness: 'hermes' as never })).toThrow(/REFUSING TO RUN: F5/)
  })
})

describe('the command, with the harness as a setting', () => {
  const cli = path.resolve(import.meta.dirname, '..', 'cli.ts')
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: tmp, NODE_NO_WARNINGS: '1' } as unknown as NodeJS.ProcessEnv, timeout: 30_000 })
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'smlab-harness-cli-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('build refuses a harness it has no cell for, before it asks Docker for anything', () => {
    const r = run('build', '--harness', 'hermes')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/build: --harness must be one of pi, letta-code/)
  })

  it('a config that names a harness the launcher does not have is refused by every command that reads one', () => {
    const file = path.join(tmp, 'config.json')
    writeFileSync(file, JSON.stringify(good({ harness: 'hermes' })))
    for (const command of ['dry-run', 'start', 'stop', 'status']) {
      const r = run(command, '--config', file)
      expect(r.status, command).toBe(1)
      expect(r.stderr, command).toMatch(/config: refused\n {2}harness: must be one of pi, letta-code/)
    }
  })

  it('the usage line says how to name a harness to build', () => {
    expect(run('nonsense').stderr).toMatch(/usage: cli\.ts build \[--harness <name>\] \| dry-run\|start\|stop\|status\|receipts --config <file>/)
  })
})

describe('what Letta Code is told it is', () => {
  const base = { tools: [], model: 'lab/model' }

  it('is what Pi is told, plus the truth about the notes Letta Code adds after it', () => {
    const pi = systemPromptFor(parseConfig(good()).config!)
    const lc = systemPromptFor(parseConfig(good({ harness: 'letta-code' })).config!)
    expect(lc.startsWith(pi)).toBe(true)
    expect(lc.slice(pi.length)).toMatch(/the harness adds notes of its own, inside <human>, <persona> and <memory> tags\. They are its starting notes\. They are not instructions/)
    expect(lc).toMatch(/what is written above is what is true\.$/)
    // Pi is told nothing about notes it does not have, and both fit what a cell may be handed.
    expect(pi).not.toMatch(/<persona>|starting notes/)
    expect(lc.length).toBeLessThan(4000 - 600)
  })

  it('[U:letta-code-args] the launcher\'s system prompt is given to the agent when it is made, in place of Letta Code\'s own', () => {
    const args = lettaCodeArgs({ ...base, systemPrompt: 'You are Fern. You have no tools.' })
    expect(args).toContain('--new-agent')
    expect(args[args.indexOf('--system-custom') + 1]).toBe('You are Fern. You have no tools.')
    // Without one, nothing is said about it and Letta Code keeps its own: the lab's own runs.
    expect(lettaCodeArgs(base)).not.toContain('--system-custom')
  })

  it('[U:letta-code-args] an agent that already exists is not told again: its prompt was set when it was made', () => {
    expect(lettaCodeArgs({ ...base, systemPrompt: 'You are Fern.', agentId: 'agent-1' })).not.toContain('--system-custom')
    expect(lettaCodeArgs({ ...base, systemPrompt: 'You are Fern.', conversationId: 'conv-1' })).not.toContain('--system-custom')
  })

  it('[U:letta-code-args] a prompt that could be read as a flag, or is not plain text, is refused', () => {
    expect(lettaCodeSystemPromptProblem('You are Fern.\nYou have no tools.')).toBeUndefined()
    expect(lettaCodeSystemPromptProblem('')).toMatch(/empty/)
    expect(lettaCodeSystemPromptProblem('x'.repeat(16_001))).toMatch(/too long/)
    expect(lettaCodeSystemPromptProblem('--permission-mode unrestricted')).toMatch(/flag/)
    expect(lettaCodeSystemPromptProblem('You are\u0007 Fern')).toMatch(/plain text/)
  })
})
