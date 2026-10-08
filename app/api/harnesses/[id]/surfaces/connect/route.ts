import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { buildConnectEnvVars, mergeEnvVars, ensurePolicyDefaults, getSignalDaemonUrl } from '@/lib/env-helpers'
import { setPlatformEnabled } from '@/lib/config-yaml-helpers'
import { services } from '@/lib/services'
import { expandSignalAllowlist, resolveTelegramAdmins, type ResolvedIdentity } from '@/lib/resolvers'
import { USERS_VARS } from '@/lib/surfaces/derive'
import { applyAllowedBotRolesSetting } from '@/lib/services/discord-allowed-bot-roles'

function agentDataDir(harnessId: string): string {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  if (name === 'personal') return path.join(os.homedir(), '.hermes')
  return path.join(os.homedir(), `.hermes-${name}`)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { platform, config } = body as { platform: string; config: Record<string, string> }

  if (!platform || !config) {
    return NextResponse.json({ error: 'Missing platform or config' }, { status: 400 })
  }

  // Pre-connect health check for Signal (uses JSON-RPC since daemon runs in native mode)
  if (platform === 'signal') {
    const signalUrl = getSignalDaemonUrl()
    try {
      const healthRes = await fetch(`${signalUrl}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'listAccounts', id: 'health' }),
        signal: AbortSignal.timeout(5000),
      })
      if (!healthRes.ok) {
        return NextResponse.json({ error: 'Signal daemon not reachable. Deploy it first via Settings or run: cd ~/.hermes-swarm && docker compose -f docker-compose.signal.yml up -d' }, { status: 503 })
      }
    } catch {
      return NextResponse.json({ error: 'Signal daemon not reachable. Deploy it first via Settings or run: cd ~/.hermes-swarm && docker compose -f docker-compose.signal.yml up -d' }, { status: 503 })
    }

    // Default the bot's Signal profile name to the harness name, so an agent
    // shows up under the name it was created with — including when an
    // already-registered number is reused (fresh registration already sets this
    // via the wizard, but reused numbers keep their old/generic profile).
    // Best-effort: never fail the bond if the profile update doesn't land.
    if (config.phone) {
      const givenName = id.replace(/^h_/, '').replace(/_/g, '-')
      try {
        await fetch(`${signalUrl}/api/v1/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'updateProfile', params: { account: config.phone, givenName }, id: 'profile' }),
          signal: AbortSignal.timeout(8000),
        })
      } catch { /* best-effort */ }
    }
  }

  const envVars = buildConnectEnvVars(platform, config)
  if (Object.keys(envVars).length === 0) {
    return NextResponse.json({ error: `Unknown platform: ${platform}` }, { status: 400 })
  }

  // If adminUser is provided, set the platform's ALLOWED_USERS var
  // (comma-separated for multiple admins)
  let telegramAdmins: { ids: string[]; resolved: ResolvedIdentity[] } | undefined
  if (config.adminUser) {
    // Derived from the surface registry (lib/surfaces).
    const allowedUsersKey = USERS_VARS
    const key = allowedUsersKey[platform]
    if (key) {
      if (platform === 'signal') {
        // Store both the phone and its resolved UUID — sealed-sender DMs carry
        // only the UUID, so a phone-only allowlist silently rejects the admin.
        const expanded = await expandSignalAllowlist(id, config.adminUser.split(','))
        envVars[key] = expanded.join(',')
      } else if (platform === 'telegram') {
        // Resolve @usernames to numeric user IDs — the gateway matches inbound
        // sender IDs (always numeric) against TELEGRAM_ALLOWED_USERS verbatim,
        // so a raw @handle silently locks the admin out. STRICT: a handle that
        // fails to resolve is a 400 (surfaced inline in the connect dialog),
        // never stored raw. The token comes from the request payload because
        // TELEGRAM_BOT_TOKEN may not be in the agent .env yet at connect time.
        const resolution = await resolveTelegramAdmins(id, config.adminUser.split(','), config.token)
        if (!resolution.ok) {
          return NextResponse.json({ error: resolution.error }, { status: 400 })
        }
        envVars[key] = resolution.ids.join(',')
        telegramAdmins = resolution
      } else {
        envVars[key] = config.adminUser
      }
    }
  }

  const dataDir = agentDataDir(id)
  const envPath = path.join(dataDir, '.env')

  if (!fs.existsSync(envPath)) {
    return NextResponse.json({ error: `Agent .env not found at ${envPath}` }, { status: 404 })
  }

  let content = fs.readFileSync(envPath, 'utf-8')

  // Only write connection-specific vars (URL, token, account).
  // Never touch policy vars (ALLOWED_USERS, GROUP_ALLOWED_USERS) — unless adminUser was explicitly provided.
  content = mergeEnvVars(content, envVars)

  // Ensure policy defaults exist for new connections (empty = approved-only).
  content = ensurePolicyDefaults(content, platform)

  // A newly connected Discord agent joins the fleet bot-sender role gate now,
  // not at the next server start.
  if (platform === 'discord') {
    content = applyAllowedBotRolesSetting(content, services.config?.getSettings?.()?.discordAllowedBotRoles)
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 })

  // Enable the platform in config.yaml — the gateway only starts platforms
  // with `platforms.<p>.enabled: true` (gateway/run.py), so env vars alone
  // leave the surface silently dead. Surgical line edit; comments preserved.
  // Missing config.yaml = agent not yet deployed; the deploy template writes
  // the block itself, so skip gracefully.
  const configPath = path.join(dataDir, 'config.yaml')
  let configUpdated = false
  let configError: string | undefined
  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8')
      const updated = setPlatformEnabled(configContent, platform, true)
      if (updated !== configContent) {
        fs.writeFileSync(configPath, updated, 'utf-8')
      }
      configUpdated = true
    }
  } catch (err) {
    // Best-effort like the restart below: .env is already written, so don't
    // fail the connect — but surface the inconsistency instead of hiding it.
    configError = `config.yaml not updated (${err instanceof Error ? err.message : String(err)}); platform may need manual enabling`
  }

  if (telegramAdmins) {
    // Persist display names the same way the settings path does (merged, not
    // clobbered — connect only knows about telegram), so the settings UI can
    // show "@handle (Name)" next to the numeric ID.
    const resolvedPath = path.join(dataDir, 'resolved-identities.json')
    let resolvedMap: Record<string, ResolvedIdentity[]> = {}
    try {
      resolvedMap = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'))
    } catch {}
    resolvedMap.telegram = telegramAdmins.resolved
    try {
      fs.writeFileSync(resolvedPath, JSON.stringify(resolvedMap, null, 2), { mode: 0o600 })
    } catch {}

    // Keep the policy-plane admin overlay (SurfaceAdminService) converged with
    // the allowlist we just wrote — the two stores must never diverge.
    try {
      services.surfaceAdmins.syncFromAllowlist(id, 'telegram', telegramAdmins.ids)
    } catch {}
  }

  // Recreate the container so the new env_file actually takes effect. Writing
  // .env alone leaves the running gateway on the OLD environment (a stale
  // surface account/token), which silently keeps a broken connection alive.
  // force-recreate (no rebuild) is the minimal op to reload the env.
  let restarted = false
  try {
    services.harness.restart(id, 'recreate')
    restarted = true
  } catch {
    // Harness may have no compose file (e.g. not yet deployed) — env is still
    // written, so a later start/restart will pick it up. Don't fail the connect.
  }

  return NextResponse.json({ success: true, envVars: Object.keys(envVars), restarted, configUpdated, ...(configError ? { configError } : {}) })
}
