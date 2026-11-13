import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { Tool, HabitatTier } from '@/lib/types'
import type { Storage } from './storage'

const TOOLS_FILE = 'tools.json'

// Tool overrides stored by user (risk levels, allowed tiers)
type ToolOverride = Pick<Tool, 'id' | 'risk' | 'allowedTiers' | 'reviewed'>

// Agent data directory: ~/.hermes-{name}/ or ~/.hermes/ for "personal"
function agentDataDir(harnessName: string): string {
  if (harnessName === 'personal') {
    return path.join(os.homedir(), '.hermes')
  }
  return path.join(os.homedir(), `.hermes-${harnessName}`)
}

// Parse mcp_servers section from a config.yaml string — returns server names
function parseMcpServers(yaml: string): string[] {
  const names: string[] = []
  let inMcp = false
  for (const line of yaml.split('\n')) {
    if (/^mcp_servers:/.test(line)) {
      inMcp = true
      continue
    }
    if (inMcp) {
      const m = line.match(/^  ([\w][\w-]+):/)
      if (m) {
        names.push(m[1])
      } else if (line.length > 0 && !/^\s/.test(line)) {
        inMcp = false
      }
    }
  }
  return names
}

// Parse toolsets[] from a config.yaml string
function parseToolsets(yaml: string): string[] {
  const names: string[] = []
  let inToolsets = false
  for (const line of yaml.split('\n')) {
    if (/^toolsets:/.test(line)) {
      inToolsets = true
      continue
    }
    if (inToolsets) {
      const m = line.match(/^- (.+)$/)
      if (m) {
        names.push(m[1].trim())
      } else if (line.length > 0 && !/^-/.test(line.trim())) {
        inToolsets = false
      }
    }
  }
  return names
}

// Parse the platform_toolsets: block from a config.yaml string.
// Each line maps a platform to an inline array of toolset names, e.g.
//   platform_toolsets:
//     cli: [hermes-cli]
//     signal: [hermes-signal]
// Returns the flattened, de-duplicated list of toolset names across platforms.
function parsePlatformToolsets(yaml: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  let inBlock = false
  for (const line of yaml.split('\n')) {
    if (/^platform_toolsets:/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      // An indented `key: [a, b]` entry belongs to the block.
      const m = line.match(/^\s+[\w-]+:\s*\[(.*)\]\s*$/)
      if (m) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().replace(/^["']|["']$/g, '')
          if (name && !seen.has(name)) {
            seen.add(name)
            names.push(name)
          }
        }
      } else if (line.trim().length > 0 && !/^\s/.test(line)) {
        // A non-indented, non-blank line ends the block.
        inBlock = false
      }
    }
  }
  return names
}

// List installed skill directories for a harness
function listSkills(dataDir: string): string[] {
  try {
    const skillsDir = path.join(dataDir, 'skills')
    return fs.readdirSync(skillsDir).filter((entry) => {
      try {
        return fs.statSync(path.join(skillsDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// Stable ID from a tool name
function toolId(name: string): string {
  return 't_' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 8)
}

// Infer source type from name
function inferSource(name: string): Tool['source'] {
  if (name.startsWith('mcp:') || name.includes('_workspace') || name.includes('relay')) {
    return 'mcp'
  }
  return 'builtin'
}

// Default risk level — MCP tools slightly higher
function defaultRisk(source: Tool['source']): Tool['risk'] {
  return source === 'mcp' ? 2 : 1
}

// Discover tools from all harness data directories
function discoverTools(harnessNames: string[]): Map<string, { tool: Tool; harnesses: string[] }> {
  const registry = new Map<string, { tool: Tool; harnesses: string[] }>()

  for (const name of harnessNames) {
    const dataDir = agentDataDir(name)

    // Read config.yaml for this agent
    let yamlContent = ''
    try {
      yamlContent = fs.readFileSync(path.join(dataDir, 'config.yaml'), 'utf-8')
    } catch {
      // no config
    }

    const toolNames: string[] = []

    // Collect MCP server names (prefixed as mcp:name)
    for (const mcp of parseMcpServers(yamlContent)) {
      toolNames.push(`mcp:${mcp}`)
    }

    // Collect toolsets
    for (const ts of parseToolsets(yamlContent)) {
      toolNames.push(`toolset:${ts}`)
    }

    // Collect platform toolsets (the default block a freshly-generated
    // config.yaml ships — without this, a plain agent surfaces no tools).
    for (const ts of parsePlatformToolsets(yamlContent)) {
      toolNames.push(`toolset:${ts}`)
    }

    // Collect installed skill directories
    for (const skill of listSkills(dataDir)) {
      toolNames.push(`skill:${skill}`)
    }

    for (const rawName of toolNames) {
      const id = toolId(rawName)
      const existing = registry.get(id)
      if (existing) {
        if (!existing.harnesses.includes(name)) {
          existing.harnesses.push(name)
        }
      } else {
        const source = rawName.startsWith('mcp:') ? 'mcp' : 'builtin'
        const tool: Tool = {
          id,
          name: rawName,
          source,
          risk: defaultRisk(source),
          allowedTiers: ['individual', 'team', 'org', 'orgpublic', 'public'] as HabitatTier[],
          reviewed: true,
          description: `Discovered from agent: ${name}`,
        }
        registry.set(id, { tool, harnesses: [name] })
      }
    }
  }

  return registry
}

// Maximum risk level allowed per tier for default tool assignment
const TIER_MAX_RISK: Record<HabitatTier, number> = {
  individual: 2,  // safe + low
  team: 3,        // safe + low + medium
  org: 5,         // all risk levels
  orgpublic: 2,   // conservative (public-facing)
  public: 1,      // minimal (safe only)
}

/**
 * Returns tool IDs that should be assigned by default for a given tier.
 * A tool is included if:
 *   1. Its risk level is within the tier's max risk threshold
 *   2. Its allowedTiers includes this tier
 */
export function getDefaultToolsForTier(tier: HabitatTier, allTools: Tool[]): string[] {
  const maxRisk = TIER_MAX_RISK[tier] ?? 2
  return allTools
    .filter((t) => t.risk <= maxRisk && t.allowedTiers.includes(tier))
    .map((t) => t.id)
}

export class ToolsService {
  constructor(private storage: Storage) {}

  // Load user overrides for specific tool IDs
  private loadOverrides(): Map<string, ToolOverride> {
    const stored = this.storage.read<ToolOverride[]>(TOOLS_FILE, [])
    const map = new Map<string, ToolOverride>()
    for (const o of stored) {
      map.set(o.id, o)
    }
    return map
  }

  discover(harnessNames: string[]): Tool[] {
    const registry = discoverTools(harnessNames)
    const overrides = this.loadOverrides()

    const tools: Tool[] = []
    for (const [id, { tool }] of registry) {
      const override = overrides.get(id)
      tools.push(override ? { ...tool, ...override } : tool)
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Discover tool IDs for a single harness by scanning its config.yaml and skills dir.
   * Returns an array of tool IDs (e.g. ['t_abc12345', ...]).
   */
  discoverForHarness(harnessName: string): string[] {
    const registry = discoverTools([harnessName])
    return Array.from(registry.keys())
  }

  list(harnessNames?: string[]): Tool[] {
    const names = harnessNames ?? this.defaultHarnessNames()
    return this.discover(names)
  }

  update(id: string, partial: Partial<Tool>): Tool | undefined {
    const overrides = this.storage.read<ToolOverride[]>(TOOLS_FILE, [])
    const index = overrides.findIndex((t) => t.id === id)
    const safePartial: ToolOverride = {
      id,
      risk: (partial.risk as Tool['risk']) ?? 1,
      allowedTiers: partial.allowedTiers ?? ['individual'],
      reviewed: partial.reviewed ?? false,
    }
    if (index !== -1) {
      overrides[index] = { ...overrides[index], ...safePartial }
    } else {
      overrides.push(safePartial)
    }
    this.storage.write(TOOLS_FILE, overrides)

    // Return merged tool
    const allTools = this.list()
    return allTools.find((t) => t.id === id)
  }

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
}
