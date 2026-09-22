import { Storage } from './storage'
import { DockerService } from './docker'
import { AuditService } from './audit'
import { HarnessService } from './harness'
import { KeysService } from './keys'
import { ToolsService } from './tools'
import { MemoryService } from './memory'
import { ConfigService } from './config'
import { SignalPinService } from './signal-pin'
import { SurfaceAdminService } from './surface-admins'
import { LettaService } from './letta'
import { LettaAgentProvider } from './letta-agent-provider'
import { CascadeLibraryService } from './cascades'
import { ModelFreshnessService } from './model-freshness'
import { AnalyticsService } from './analytics'
import { agentDataDirForName } from './harness'
import path from 'path'
import os from 'os'

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace('~', os.homedir())
  : path.join(os.homedir(), '.hermes-swarm-map')

const storage = new Storage(DATA_DIR)
const docker = new DockerService()
const audit = new AuditService(storage)

const config = new ConfigService(storage)

const harness = new HarnessService(storage, docker, audit, config)
const tools = new ToolsService(storage)

const keysService = new KeysService(storage, audit, DATA_DIR)

// Live provider model lists (cached under DATA_DIR/model-lists/, fail-soft).
// Keys are looked up through KeysService per request and never persisted here.
const modelFreshness = new ModelFreshnessService(storage, keysService)

// Agents-as-API-resources layer (design §1c). Maps Letta agents → Harness so
// the fleet list/detail render them uniformly, gated by harness.runtime.
const lettaService = new LettaService()
const lettaAgents = new LettaAgentProvider(lettaService)

// Wire ToolsService into HarnessService for auto-discovery of tools
harness.setToolsService(tools)

// Analytics (#206): reads state.db per harness on its own endpoints with a
// server-side cache — never from discover()/list(), which the dashboard polls.
// Letta rows have no state.db (same skip as the snapshot scheduler).
const analytics = new AnalyticsService({
  listTargets: () => harness
    .list()
    .filter((h) => h.runtime !== 'letta' && h.runtime !== 'letta-server')
    .map((h) => ({ harnessId: h.id, name: h.name, dataDir: agentDataDirForName(h.name) })),
})

export const services = {
  storage,
  docker,
  audit,
  config,
  harness,
  keys: keysService,
  modelFreshness,
  tools,
  memory: new MemoryService(storage),
  signalPin: new SignalPinService(keysService, process.env.SIGNAL_API_URL || 'http://localhost:8080'),
  surfaceAdmins: new SurfaceAdminService(storage, audit),
  // Named cascade library: saved fallback_providers shapes, portable across harnesses.
  cascades: new CascadeLibraryService(storage, audit),
  // SPIKE (Path 1): agents-as-API-resources layer, distinct from the container
  // model. Base URL from LETTA_BASE_URL, defaults to the compose-published :8283.
  letta: lettaService,
  // Provider that maps Letta agents → Harness objects for the fleet UI (slice 1).
  lettaAgents,
  analytics,
}
