import { Storage } from './storage'
import { DockerService } from './docker'
import { AuditService } from './audit'
import { HarnessService, agentDataDirForName } from './harness'
import { AnalyticsService } from './analytics'
import { KeysService } from './keys'
import { ToolsService } from './tools'
import { MemoryService } from './memory'
import { ConfigService } from './config'
import { SignalPinService } from './signal-pin'
import { SurfaceAdminService } from './surface-admins'
import { CascadeLibraryService } from './cascades'
import { ModelFreshnessService } from './model-freshness'
import { DATA_DIR } from './data-dir'


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

// Wire ToolsService into HarnessService for auto-discovery of tools
harness.setToolsService(tools)

// Analytics (#206): reads state.db per harness on its own endpoints with a
// server-side cache — never from discover()/list(), which the dashboard polls.
const analytics = new AnalyticsService({
  listTargets: () => harness
    .list()
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
  surfaceAdmins: new SurfaceAdminService(storage, audit, harness),
  // Named cascade library: saved fallback_providers shapes, portable across harnesses.
  cascades: new CascadeLibraryService(storage, audit),
  analytics,
}
