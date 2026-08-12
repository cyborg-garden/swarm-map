import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { toHarnessSlug } from '@/lib/services/harness'
import { installBaselineTemplates } from '@/lib/services/templates'
import { defaultEnabledPlugins } from '@/lib/services/artifacts-manifest'
import { getUseCaseTemplate, installUseCaseTemplate, templateEnabledPlugins } from '@/lib/services/usecase-templates'
import { generateDefaultConfig, type McpServerConfig } from '@/lib/templates/config-yaml'
import { generateEnvContent, generateAgentCompose } from '@/lib/services/agent-deploy-templates'
import { deployLettaAgent, serverKeyVarForModel, LETTA_DEFAULT_PORT } from '@/lib/services/letta-deploy-templates'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'

const BASE_PORT = 8642
const PORT_STEP = 10

function expandPath(p: string): string {
  return p.replace(/^~/, os.homedir())
}

function nextAvailablePort(): number {
  const usedPorts = new Set<number>()

  // Query Docker directly for all ports in use
  try {
    const output = execSync(
      `docker ps --format '{{.Ports}}'`,
      { stdio: 'pipe', timeout: 5000 }
    ).toString()
    // Parse port mappings like "0.0.0.0:8642->8642/tcp"
    const portMatches = output.matchAll(/0\.0\.0\.0:(\d+)/g)
    for (const m of portMatches) {
      usedPorts.add(parseInt(m[1]))
    }
  } catch {}

  // Find next available in the hermes range (8642+, step 10)
  let port = BASE_PORT
  while (usedPorts.has(port)) {
    port += PORT_STEP
  }
  return port
}

function generateConfigYaml(provider: string, primaryModel: string, fallbackModel?: string, browserEnabled?: boolean, mcpServers?: Record<string, McpServerConfig>, extraEnabledPlugins: string[] = [], enabledPlatforms: string[] = []): string {
  const enabledPlugins = Array.from(new Set([...defaultEnabledPlugins(), ...extraEnabledPlugins]))
  return generateDefaultConfig({ provider, primaryModel, fallbackModel, browserEnabled, mcpServers, enabledPlugins, enabledPlatforms })
}

export async function POST(request: Request) {
  // Tracks a freshly-created agent dir so a failed deploy can remove it along
  // with its .env (which holds the resolved API key). Only set after we create
  // the dir, so we never delete a pre-existing agent on failure.
  let createdAgentDir: string | undefined
  // Linked-pair deploy state — hoisted so the catch can clean up a brain
  // agent orphaned by a door-phase failure (see catch below).
  let lettaBrainResult: { brainAgentId: string; brainHarnessId: string; baseUrl: string } | undefined
  try {
    const body = await request.json()
    const { name, fallbackModel, persona, tier,
      mattermostEnabled, mattermostUrl, mattermostToken,
      telegramEnabled, telegramToken, discordEnabled, discordToken,
      slackEnabled, slackBotToken, slackAppToken, signalEnabled, signalPhone,
      githubToken, braveKey, notionKey, existingKeyId, saveKeyToRegistry } = body
    const bundledOllama = body.bundledOllama === true
    // Mutable: the Letta branch defaults these from `lettaModel` so the door's
    // .env / config.yaml generation below stays valid without wizard changes.
    let provider: string = body.provider
    let primaryModel: string = body.primaryModel

    // Optional use-case template (e.g. Matilde) — installs gated git artifacts +
    // seeds its SOUL. Resolved from the server-side registry; unknown id → 400.
    const templateId: string | undefined = body.template || undefined
    const useCaseTemplate = templateId ? getUseCaseTemplate(templateId) : undefined
    if (templateId && !useCaseTemplate) {
      return NextResponse.json({ ok: false, error: `Unknown use-case template "${templateId}".` }, { status: 400 })
    }

    // Letta deploys carry a single `lettaModel` handle instead of provider +
    // primaryModel; the model is validated inside deployLettaAgent below.
    if (!name || (body.runtime !== 'letta' && (!provider || !primaryModel))) {
      return NextResponse.json({ ok: false, error: 'name, provider, and primaryModel are required' }, { status: 400 })
    }

    const slug = toHarnessSlug(name)
    if (!slug) {
      return NextResponse.json({ ok: false, error: 'Invalid name — could not slugify' }, { status: 400 })
    }

    // ── Google MCP preflight ───────────────────────────────────────────────
    // Validated HERE, before any side effect, per the same rule the Letta
    // branch below states: return before a single door byte is written. An
    // earlier revision of this check sat after mkdirSync + the .env write, so
    // rejecting a deploy left a half-created agent dir containing the resolved
    // plaintext LLM key AND permanently 409'd every retry of that name.
    //
    // Probe both checkout names: the repo is cyborg-garden/google-multiplayer-mcp
    // but it is commonly cloned as `google-mcp`. Only checking the long name
    // meant googleMcpDir silently became undefined — the operator ticked Google
    // in the wizard and got no Google, with nothing reported anywhere.
    const googleEnabled = body.googleEnabled === true
    const googleIdentityRaw =
      typeof body.googleIdentity === 'string' ? body.googleIdentity.trim() : ''
    // Interpolated into YAML below; a colon or newline would either break the
    // parse (MCP exits 1 — the very failure this fixes) or inject permission
    // entries past the deny-by-default this is built around.
    if (googleIdentityRaw && !/^[A-Za-z0-9._-]+$/.test(googleIdentityRaw)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Invalid googleIdentity — only letters, digits, dot, underscore and hyphen are allowed.',
        },
        { status: 400 },
      )
    }
    const googleIdentity = googleIdentityRaw || slug

    const googleMcpCandidateDirs = (
      process.env.GOOGLE_MCP_DIR
        ? [expandPath(process.env.GOOGLE_MCP_DIR)]
        : [
            expandPath('~/Documents/GitHub/google-multiplayer-mcp'),
            expandPath('~/Documents/GitHub/google-mcp'),
          ]
      // A relative path passes existsSync (resolved against the server cwd) but
      // Docker reads a non-absolute volume source as a NAMED VOLUME, silently
      // mounting an empty dir over the bundle.
    ).filter((d) => path.isAbsolute(d))
    const googleMcpFoundDir = googleEnabled
      ? googleMcpCandidateDirs.find(
          (d) =>
            fs.existsSync(path.join(d, 'dist', 'index.js')) &&
            // The bundle is plain ESM importing bare `googleapis` / `js-yaml`,
            // which resolve only via the checkout's own node_modules. Without
            // this a pruned checkout passes the probe and exits 1 at runtime.
            fs.existsSync(path.join(d, 'node_modules')),
        )
      : undefined
    if (googleEnabled && !googleMcpFoundDir) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Google was enabled but no usable google-multiplayer-mcp checkout was found. ' +
            `Needs both dist/index.js and node_modules in one of: ${googleMcpCandidateDirs.join(', ') || '(no absolute path configured)'}. ` +
            'Clone it, run `npm install && npm run build`, or set GOOGLE_MCP_DIR to an absolute path.',
        },
        { status: 400 },
      )
    }
    // Declared with the preflight so it cannot be referenced above its own
    // initialisation — a TDZ throw here would 500 the entire deploy.
    const googleMcpDir = googleMcpFoundDir

    // Resolve the LLM credential. An `existingKeyId` selects a key already in the
    // registry — its value is resolved server-side so the secret never crosses the
    // API boundary. Otherwise the pasted `llmKey` (if any) is used verbatim.
    let llmKey: string | undefined = body.llmKey || undefined
    if (existingKeyId) {
      const resolved = services.keys.getDecryptedValue(existingKeyId)
      if (!resolved) {
        return NextResponse.json({ ok: false, error: `Selected key "${existingKeyId}" not found in the registry.` }, { status: 400 })
      }
      llmKey = resolved
    }

    // ── Letta runtime branch (design §3c + B2 linked pair) ─────────────────
    // Brain-first: bring the shared Letta server up once and create the BRAIN
    // agent over REST. Any brain failure returns unchanged, before a single
    // door byte is written (no dir/compose/overlay to clean up). On success we
    // FALL THROUGH into the Hermes block below, which deploys a gateway "door"
    // container whose .env carries the B1-contract LETTA_BRAIN_* vars — the
    // gateway detects them and forwards each turn to the brain. The pasted
    // `llmKey` is a SERVER-WIDE provider key here, not a per-agent secret.
    let lettaBrain: { url: string; agentId: string; apiKey?: string } | undefined
    if (body.runtime === 'letta') {
      const lettaSettings = services.config.getSettings()
      const swarmMapDataDir = lettaSettings.dataDir
        ? expandPath(lettaSettings.dataDir)
        : path.join(os.homedir(), '.hermes-swarm-map')
      const result = await deployLettaAgent({
        docker: services.docker,
        letta: services.letta,
        slug,
        model: body.lettaModel || primaryModel,
        persona,
        serverKey: llmKey,
        swarmMapDataDir,
      })
      if (result.status < 200 || result.status >= 300) {
        return NextResponse.json(result.body, { status: result.status })
      }
      const brainAgentId = String(result.body.agentId)
      const brainBaseUrl = String(result.body.baseUrl)
      // The door runs in a container; the brain server publishes on the host —
      // so the door reaches it via host.docker.internal, on whatever port the
      // server actually published (derived from its baseUrl so a non-default
      // C1 instance is honored; falls back to the default constant).
      let brainPort = String(LETTA_DEFAULT_PORT)
      try {
        brainPort = new URL(brainBaseUrl).port || brainPort
      } catch {
        // malformed baseUrl — keep the default
      }
      lettaBrain = { url: `http://host.docker.internal:${brainPort}`, agentId: brainAgentId }
      lettaBrainResult = {
        brainAgentId,
        brainHarnessId: String(result.body.harnessId),
        baseUrl: brainBaseUrl,
      }
      // Default the Hermes-side config from the Letta model handle so the
      // door's .env / config.yaml generation stays valid (the wizard sends no
      // provider/primaryModel for Letta deploys). serverKeyVarForModel knows
      // which providers the server maps; anything else falls back to anthropic.
      if (!provider) {
        provider = serverKeyVarForModel(body.lettaModel) === 'OPENAI_API_KEY' ? 'openai' : 'anthropic'
      }
      if (!primaryModel) primaryModel = body.lettaModel
    }

    // Check Docker is available
    if (!services.docker.isAvailable()) {
      return NextResponse.json({ ok: false, error: 'Docker is not available' }, { status: 500 })
    }

    // Load settings early — needed for image/build decision and directory resolution
    const settings = services.config.getSettings()

    // Determine whether to build from local source or use a pre-built image
    let imageOrBuild: { image: string } | { build: string }

    if (settings.useLocalBuild && settings.hermesDir) {
      const resolvedHermesDir = expandPath(settings.hermesDir)
      const dockerfilePath = path.join(resolvedHermesDir, 'Dockerfile')
      if (fs.existsSync(dockerfilePath)) {
        imageOrBuild = { build: resolvedHermesDir }
      } else {
        return NextResponse.json({ ok: false, error: `useLocalBuild enabled but no Dockerfile found at ${resolvedHermesDir}` }, { status: 400 })
      }
    } else {
      // Try pulling from Docker Hub first; if that fails (auth, network), check for local builds
      let hermesImage = settings.defaultImage || 'ghcr.io/cyborg-garden/hermes-agent-mt:latest'
      const pullResult = services.docker.pullImage(hermesImage)
      if (!pullResult.ok) {
        // Fallback: look for locally-built hermes images (from hermes-swarm build)
        // Prefer the most generic one (hermes-personal is the base build)
        try {
          const localOutput = execSync(
            'docker images --format "{{.Repository}}:{{.Tag}}" 2>/dev/null',
            { stdio: 'pipe', timeout: 5000 }
          ).toString()
          const hermesImages = localOutput.split('\n').filter(l => l.includes('hermes') && !l.includes('vertex') && !l.includes('litellm'))
          // Prefer images with "personal" (base build) or just any hermes image
          const preferred = hermesImages.find(i => i.includes('personal')) || hermesImages[0]
          if (preferred) {
            hermesImage = preferred.trim()
          } else {
            return NextResponse.json({ ok: false, error: `No Hermes image available. Pull failed: ${pullResult.error}` }, { status: 500 })
          }
        } catch {
          return NextResponse.json({ ok: false, error: `Image pull failed: ${pullResult.error}` }, { status: 500 })
        }
      }
      imageOrBuild = { image: hermesImage }
    }

    // Determine directories
    const swarmMapDataDir = settings.dataDir
      ? expandPath(settings.dataDir)
      : path.join(os.homedir(), '.hermes-swarm-map')
    const composeBaseDir = path.join(swarmMapDataDir, 'compose')

    const port = nextAvailablePort()

    const agentDataDir = path.join(os.homedir(), `.hermes-${slug}`)

    // Guard against clobbering an existing agent. Deploy is a CREATE-new flow and
    // every write below (.env with API keys, config.yaml, SOUL.md, BOOT.md) is
    // unconditional — re-deploying onto an existing slug would destroy its identity,
    // credentials, and config. Refuse instead (mirrors importFromDir). Manage an
    // existing agent from the dashboard.
    if (fs.existsSync(agentDataDir)) {
      return NextResponse.json(
        {
          error: `Agent "${slug}" already exists (${agentDataDir}). Pick a different name, or manage the existing agent from the dashboard.`,
        },
        { status: 409 },
      )
    }

    // Scaffold agent directory
    fs.mkdirSync(agentDataDir, { recursive: true })
    createdAgentDir = agentDataDir

    // Write .env
    const envContent = generateEnvContent({
      name: slug,
      port,
      provider,
      primaryModel,
      fallbackModel,
      llmKey,
      bundledOllama,
      mattermostUrl: mattermostEnabled ? mattermostUrl : undefined,
      mattermostToken: mattermostEnabled ? mattermostToken : undefined,
      telegramToken: telegramEnabled ? telegramToken : undefined,
      discordToken: discordEnabled ? discordToken : undefined,
      slackBotToken: slackEnabled ? slackBotToken : undefined,
      slackAppToken: slackEnabled ? slackAppToken : undefined,
      signalPhone: signalEnabled ? signalPhone : undefined,
      githubToken,
      braveKey,
      // Operator-level OAuth client, shared across agents. Taken from the
      // request when supplied, else inherited from HSM's own environment —
      // without it google-multiplayer-mcp's auth tools cannot run at all.
      googleClientId: googleMcpDir
        ? (typeof body.googleClientId === 'string' && body.googleClientId) || process.env.GOOGLE_CLIENT_ID || undefined
        : undefined,
      googleClientSecret: googleMcpDir
        ? (typeof body.googleClientSecret === 'string' && body.googleClientSecret) || process.env.GOOGLE_CLIENT_SECRET || undefined
        : undefined,
      notionKey,
      browserEnabled: body.browserEnabled === true,
      lettaBrain,
    })
    fs.writeFileSync(path.join(agentDataDir, '.env'), envContent, { mode: 0o600 })

    // Git auth is provisioned by the agent runtime at container boot (a
    // cont-init hook reads this .env). HSM no longer writes the credential
    // files — single source of truth in the runtime.


    // Build MCP servers config based on enabled integrations
    const githubMcpEnabled = body.githubMcpEnabled === true && !!githubToken
    const mcpServers: Record<string, McpServerConfig> = {}

    if (githubMcpEnabled) {
      mcpServers.github = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      }
    }

    // Notion: command-based server, same shape as github (npx works in-image).
    // The runtime resolves ${NOTION_TOKEN} from the process env, which the agent
    // .env supplies as a literal (see generateEnvContent).
    const notionMcpEnabled = body.notionEnabled === true && !!notionKey
    if (notionMcpEnabled) {
      mcpServers.notion = {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { NOTION_TOKEN: '${NOTION_API_KEY}' },
      }
    }

    if (googleMcpDir) {
      mcpServers.google = {
        command: 'node',
        // --config points into /opt/data (the agent data dir bind mount), NOT
        // /opt/google — only /opt/google/tokens is mounted, so the previous
        // /opt/google/config.yaml did not exist and the server exited 1 on
        // readFileSync. HSM writes this file below.
        args: [
          '/opt/google-multiplayer-mcp/dist/index.js',
          '--config',
          '/opt/data/google-permissions.yaml',
        ],
        env: {
          // Without this the server falls back to $HOME/.nimbleco-google/tokens
          // (auth.ts), and since the gateway exports HOME=/opt/data the tokens
          // land somewhere the compose file never mounts on purpose — making
          // the /opt/google/tokens mount dead weight. Pointing the server at
          // the mounted path is what makes token persistence intentional
          // rather than incidental.
          GOOGLE_TOKEN_DIR: '/opt/google/tokens',
          // OAuth client credentials. auth.ts reads these from the process env
          // before falling back to ~/.nimbleco-google/config.json, which HSM
          // never writes — so without them every auth tool fails and the agent
          // can never complete the flow, no matter how it is scoped.
          GOOGLE_CLIENT_ID: '${GOOGLE_CLIENT_ID}',
          GOOGLE_CLIENT_SECRET: '${GOOGLE_CLIENT_SECRET}',
        },
      }
    }

    // Write config.yaml (enable any plugins the chosen use-case template ships,
    // plus platforms.<p>.enabled for the surfaces chosen in the wizard — the
    // gateway won't start a surface without that flag, tokens in .env or not)
    const extraEnabledPlugins = useCaseTemplate ? templateEnabledPlugins(useCaseTemplate) : []
    const enabledPlatforms = [
      telegramEnabled && 'telegram',
      discordEnabled && 'discord',
      slackEnabled && 'slack',
      mattermostEnabled && 'mattermost',
      signalEnabled && 'signal',
    ].filter((p): p is string => typeof p === 'string')
    const configContent = generateConfigYaml(provider, primaryModel, fallbackModel, body.browserEnabled === true, Object.keys(mcpServers).length > 0 ? mcpServers : undefined, extraEnabledPlugins, enabledPlatforms)
    fs.writeFileSync(path.join(agentDataDir, 'config.yaml'), configContent, 'utf-8')

    // Write the Google permission config the MCP server reads via --config.
    // Nothing previously created this file, so google MCP exited 1 on startup
    // for every newly created agent.
    //
    // SECURITY: every service defaults to access: none. In
    // google-multiplayer-mcp an EMPTY `folders` list means NO RESTRICTION
    // (permissions.ts getAllowedFolders), so emitting e.g. `drive: {access:
    // write, folders: []}` would hand a brand-new agent unscoped read/write
    // over the whole Google account. The wizard collects no folder IDs, so the
    // only safe generated default is to grant nothing and let the operator
    // scope it deliberately.
    if (googleMcpDir) {
      const googleIdentity =
        typeof body.googleIdentity === 'string' && body.googleIdentity.trim()
          ? body.googleIdentity.trim()
          : slug
      const googlePermissionsYaml = `# Google permissions for ${slug} — generated by Swarm Map.
#
# Every service starts at "none" on purpose. An EMPTY "folders" list means
# UNRESTRICTED access to that service, so granting access without also listing
# folder IDs gives this agent the whole account.
#
# To grant scoped access, set access (read|write) AND list folder IDs:
#
#   drive:
#     access: write
#     folders:
#       - <drive-folder-id>
#
# Then restart the agent. Run the OAuth flow once before first use. Both env
# vars are required: the container is read_only, so GOOGLE_TOKEN_DIR must point
# at the mounted (writable) tokens dir, and the client credentials are not in
# the exec environment by default.
#   docker exec -it \\
#     -e GOOGLE_TOKEN_DIR=/opt/google/tokens \\
#     -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \\
#     hermes-${slug} node \\
#     /opt/google-multiplayer-mcp/dist/index.js auth-headless ${googleIdentity}
google:
  identity: ${googleIdentity}
  permissions:
    drive:
      access: none
      folders: []
    docs:
      access: none
      folders: []
    sheets:
      access: none
      folders: []
    calendar:
      access: none
      folders: []
    gmail:
      access: none
`
      fs.writeFileSync(
        path.join(agentDataDir, 'google-permissions.yaml'),
        googlePermissionsYaml,
        'utf-8',
      )
      // The compose file bind-mounts this to /opt/google/tokens. Create it here
      // so it exists with the invoking user's ownership; letting Docker create
      // the missing source path can leave it root-owned, and the OAuth flow
      // needs to write token JSON into it.
      fs.mkdirSync(path.join(agentDataDir, 'google-tokens'), { recursive: true })
    }

    // Write SOUL.md
    const personalitySection = persona
      ? `## Personality\n\n${persona}`
      : `## Personality\n\nCustomize this section to give ${name} a distinct voice, tone, and purpose.\nWhat kind of assistant should ${name} be? Formal? Casual? Technical? Creative?`
    const soulContent = `# ${name}

You are **${name}**, a Hermes agent in a multi-tenant deployment managed by Swarm Map.

## How You Work

**Multi-platform:** You serve users across Signal, Telegram, Mattermost, and other platforms simultaneously. Each platform connection is independent.

**Memory isolation:** Your memory is scoped per-context. What you learn in one group chat stays in that group. You maintain separate context for each conversation thread. If someone asks "what did we talk about last time?" — you recall only what happened in THAT specific chat.

**Session lifecycle:** Your conversations reset after 24 hours of inactivity or at 4 AM daily. This keeps you fast and prevents runaway costs. Important context is preserved in your per-context memory.

**Skills are global:** Skills you learn or create are available across all your conversations. A skill learned in one group benefits everyone.

**Group approval:** You only respond in groups that your admin has approved. If you're added to a new group, you'll check with HSM before engaging.

## Behavioral Defaults

- Be helpful, direct, and honest
- When you don't know something, say so clearly
- Never reference or leak information between different conversations
- You can share that you run on Hermes if asked about your system
- Use \\\`/model\\\` to check or switch your AI model
- Use \\\`/memory\\\` to review what you remember about this conversation
- If you're unsure whether something is appropriate to share across contexts, don't

## Your Admin

Your admin manages you through HSM. They can:
- Approve/deny groups you can participate in
- Monitor your usage and costs
- Update your configuration and model
- Manage your API keys and budget

${personalitySection}
`
    fs.writeFileSync(path.join(agentDataDir, 'SOUL.md'), soulContent, 'utf-8')

    // Write BOOT.md
    const bootContent = `# Boot Checklist

On startup, verify your operational readiness:

1. **Check HSM connection** — Can you reach your management server? If not, note it but continue.
2. **Review your memory** — Check if you have any persistent memories from previous sessions.
3. **Verify skills** — Run a quick skills check. Note any skills that failed to load.
4. **Status report** — If everything is nominal, reply with [SILENT]. Only report if something needs attention.

If this is your very first startup ever, introduce yourself briefly in your home channel (if configured).
`
    fs.writeFileSync(path.join(agentDataDir, 'BOOT.md'), bootContent, 'utf-8')

    // Create memories directory
    fs.mkdirSync(path.join(agentDataDir, 'memories'), { recursive: true })

    // Install baseline plugins and hooks from templates
    await installBaselineTemplates(agentDataDir)

    // Install the chosen use-case template (gated git artifacts + SOUL overlay).
    // Runs after the default SOUL.md write so a template SOUL takes precedence.
    // Throws (failing the create before the container starts) if the trust gate
    // refuses any fetched content — a poisoned template must never deploy.
    if (useCaseTemplate) {
      await installUseCaseTemplate(agentDataDir, useCaseTemplate)
    }

    // Generate standalone compose
    const agentComposeDir = path.join(composeBaseDir, slug)
    fs.mkdirSync(agentComposeDir, { recursive: true })
    const composePath = path.join(agentComposeDir, 'docker-compose.yml')
    fs.writeFileSync(composePath, generateAgentCompose(slug, port, agentDataDir, imageOrBuild, { googleMcpDir, githubMcpEnabled, bundledOllama }), 'utf-8')

    // Start the container.
    //
    // When building from local source (useLocalBuild), `up -d` triggers a cold
    // image build that takes minutes — far longer than a container start. Run
    // the build as a separate step with a build-appropriate timeout first, so
    // the subsequent `up -d` only has to *start* an already-built image and
    // stays fast. Otherwise a first-time/local-build deploy hits the short
    // start timeout (spawnSync /bin/sh ETIMEDOUT) while buildkit keeps building
    // detached behind the failed wizard. (The restart path is already async;
    // this gives the create path an equivalent build budget.)
    try {
      if ('build' in imageOrBuild) {
        execSync(`docker compose -f ${composePath} build`, { stdio: 'pipe', timeout: 1_800_000 }) // 30 min — cold builds
      }
      execSync(`docker compose -f ${composePath} up -d`, { stdio: 'pipe', timeout: 120000 })
    } catch (err) {
      if (createdAgentDir) fs.rmSync(createdAgentDir, { recursive: true, force: true })
      return NextResponse.json({
        ok: false,
        error: `Failed to start container: ${err instanceof Error ? err.message : String(err)}`,
      }, { status: 500 })
    }

    // Health check
    const healthy = services.docker.healthCheck(`http://localhost:${port}/health`, 30000)

    // Register overlay via harness service
    const overlay = await services.harness.createOverlay({
      name: slug,
      tier: tier ?? 'individual',
      platform: telegramEnabled ? 'telegram' : discordEnabled ? 'discord' : slackEnabled ? 'slack' : mattermostEnabled ? 'mattermost' : 'hermes',
      channel: `:${port}`,
      models: fallbackModel ? [primaryModel, fallbackModel] : [primaryModel],
    })

    // Key registry bookkeeping (best-effort — never fail an already-running deploy).
    // The agent's .env already carries the resolved value; this only records the
    // assignment / persists a freshly-pasted key for reuse by the next wizard run.
    try {
      const harnessId: string | undefined = overlay.id
      if (harnessId && existingKeyId) {
        const key = services.keys.list().find((k) => k.id === existingKeyId)
        const assignedTo = Array.from(new Set<string>([...(key?.assignedTo ?? []), harnessId]))
        // setAssignment (not update) so the reused key's value is written into the
        // new agent's .env, not just recorded in the registry.
        services.keys.setAssignment(existingKeyId, assignedTo)
      } else if (harnessId && saveKeyToRegistry && llmKey) {
        const value: string = llmKey
        services.keys.add({ provider, value, assignedTo: [harnessId] })
      }
    } catch (e) {
      console.error('key registry bookkeeping failed (agent is running):', e)
    }

    return NextResponse.json({
      ok: true,
      // Letta linked pair: door harness identity + brain identity (additive —
      // the wizard already branches on data.runtime === 'letta'). `agentId`
      // mirrors brainAgentId for compatibility with the wizard's pre-pair
      // success panel, which renders data.agentId.
      ...(lettaBrainResult ? { runtime: 'letta', agentId: lettaBrainResult.brainAgentId, ...lettaBrainResult } : {}),
      harnessId: overlay.id,
      port,
      healthy,
    })
  } catch (err) {
    if (createdAgentDir) fs.rmSync(createdAgentDir, { recursive: true, force: true })
    // Linked-pair deploy: the brain agent was created before the door phase
    // threw. Delete it (best-effort) so the orphaned name doesn't 409-block
    // a retry of the same deploy.
    if (lettaBrainResult) {
      try {
        await services.letta.deleteAgent(lettaBrainResult.brainAgentId)
      } catch (cleanupErr) {
        console.error('[deploy] failed to clean up orphaned Letta brain agent:', cleanupErr)
      }
    }
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
