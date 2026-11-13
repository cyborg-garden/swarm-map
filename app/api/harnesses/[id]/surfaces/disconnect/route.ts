import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { services } from '@/lib/services'
import { setPlatformEnabled } from '@/lib/config-yaml-helpers'
import { PLATFORM_ENV_KEYS as DERIVED_PLATFORM_ENV_KEYS } from '@/lib/surfaces/derive'

function agentDataDir(harnessId: string): string {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  if (name === 'personal') return path.join(os.homedir(), '.hermes')
  return path.join(os.homedir(), `.hermes-${name}`)
}

// The strip-on-disconnect set is derived from the surface registry
// (lib/surfaces): credentials + every admission var, and NEVER a behavioral
// preference. Behavioral vars (REQUIRE_MENTION, ALLOW_BOTS,
// CHANNEL_SCOPED_ACCESS, invite/observe policy) are KEPT — they are harmless
// without a token and are not reseeded on reconnect, so stripping them silently
// changed agent behavior across a disconnect/reconnect cycle. The registry's
// class rule (registry.test.ts) enforces this; the duplicate-agent path
// (harness.ts) now derives the same set, so the two can no longer disagree.
const PLATFORM_ENV_KEYS = DERIVED_PLATFORM_ENV_KEYS

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { platform } = body as { platform: string }

  if (!platform) {
    return NextResponse.json({ error: 'Missing platform' }, { status: 400 })
  }

  const keys = PLATFORM_ENV_KEYS[platform]
  if (!keys) {
    return NextResponse.json({ error: `Unknown platform: ${platform}` }, { status: 400 })
  }

  const dataDir = agentDataDir(id)
  const envPath = path.join(dataDir, '.env')

  if (!fs.existsSync(envPath)) {
    return NextResponse.json({ error: `Agent .env not found at ${envPath}` }, { status: 404 })
  }

  let content = fs.readFileSync(envPath, 'utf-8')

  for (const key of keys) {
    content = content.replace(new RegExp(`^${key}=.*\n?`, 'm'), '')
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 })

  // Flip the platform to enabled: false in config.yaml so the gateway stops
  // starting it (gateway/run.py gates on platforms.<p>.enabled). Surgical
  // line edit — other keys under the platform entry are preserved so a
  // reconnect gets its old settings back. Missing config.yaml or missing
  // entry = already disabled; setPlatformEnabled no-ops.
  const configPath = path.join(dataDir, 'config.yaml')
  let configUpdated = false
  let configError: string | undefined
  try {
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8')
      const updated = setPlatformEnabled(configContent, platform, false)
      if (updated !== configContent) {
        fs.writeFileSync(configPath, updated, 'utf-8')
      }
      configUpdated = true
    }
  } catch (err) {
    // .env vars are already stripped; a failed disable here would leave the
    // platform enabled with no credentials (crash-loop on next boot) — report
    // it rather than pretending the disconnect was clean.
    configError = `config.yaml not updated (${err instanceof Error ? err.message : String(err)}); platform may still be enabled`
  }

  // Recreate so the gateway actually drops the surface. Stripping vars from
  // .env without recreating leaves the live connection running on stale env.
  let restarted = false
  try {
    services.harness.restart(id, 'recreate')
    restarted = true
  } catch {
    // No compose file — env is stripped; nothing live to recreate.
  }

  return NextResponse.json({ ok: true, restarted, configUpdated, ...(configError ? { configError } : {}) })
}
