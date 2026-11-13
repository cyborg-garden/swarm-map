import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import type { MemoryScope, HabitatTier } from '@/lib/types'
import type { Storage } from './storage'
import { resolveStateDbPath } from './db-path'

const MEMORY_FILE = 'memory-scopes.json'

// Agent data directory mapping
function agentDataDir(harnessName: string): string {
  if (harnessName === 'personal') {
    return path.join(os.homedir(), '.hermes')
  }
  return path.join(os.homedir(), `.hermes-${harnessName}`)
}

// Heuristically map harness name to tier
function inferTier(harnessName: string): HabitatTier {
  if (harnessName === 'personal') return 'individual'
  if (harnessName.startsWith('seraph-')) return 'org'
  if (harnessName === 'egregore') return 'orgpublic'
  return 'team'
}

// Get directory size in MB using du
function dirSizeMb(dirPath: string): number {
  try {
    const output = execFileSync('du', ['-sm', dirPath], { stdio: 'pipe', timeout: 5000 }).toString()
    const match = output.match(/^(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

// Stable ID from harness name
function memoryId(harnessName: string): string {
  return 'm_' + crypto.createHash('sha1').update(harnessName).digest('hex').slice(0, 8)
}

// Discover memory scopes from agent data directories
function discoverMemoryScopes(harnessNames: string[]): MemoryScope[] {
  const scopes: MemoryScope[] = []

  for (const name of harnessNames) {
    const dataDir = agentDataDir(name)
    const memoriesDir = path.join(dataDir, 'memories')

    // Check if this agent has a memories directory or state.db. lstat-aware:
    // a migrated harness's state.db is a host-dangling symlink that existsSync
    // would misreport as absent — 'migrated-pending' still counts as having a DB.
    const hasMemories = fs.existsSync(memoriesDir)
    const hasStateDb = resolveStateDbPath(dataDir).kind !== 'none'

    if (!hasMemories && !hasStateDb) continue

    const sizeMb = hasMemories ? dirSizeMb(memoriesDir) : 0

    const id = `h_${name.replace(/-/g, '_')}`
    scopes.push({
      id: memoryId(name),
      name: name,
      strategy: 'siloed-runtime',
      members: [id],
      sizeMb,
      tier: inferTier(name),
    })
  }

  return scopes
}

export class MemoryService {
  constructor(private storage: Storage) {}

  private defaultHarnessNames(): string[] {
    return [
      'personal',
      'cryptids',
      'cyborg',
      'egregore',
      'osint',
      'seraph-doer',
      'seraph-generalist',
      'seraph-thinker',
    ]
  }

  list(harnessNames?: string[]): MemoryScope[] {
    const names = harnessNames ?? this.defaultHarnessNames()
    return discoverMemoryScopes(names)
  }

  // Kept for backward compat — reads stored data if discovery fails
  listStored(): MemoryScope[] {
    return this.storage.read<MemoryScope[]>(MEMORY_FILE, [])
  }
}
