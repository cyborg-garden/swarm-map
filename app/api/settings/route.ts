import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

export async function GET() {
  return NextResponse.json(services.config.getSettings())
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null)
  try {
    const settings = services.config.updateSettings(body)
    // A new bot-role list reaches every Discord agent's .env at once (agents
    // read it on their next recreate), not at the next server start.
    if (body && typeof body === 'object' && 'discordAllowedBotRoles' in body && settings.discordAllowedBotRoles) {
      const { syncFleetDiscordAllowedBotRoles } = await import('@/lib/services/discord-allowed-bot-roles-fleet')
      syncFleetDiscordAllowedBotRoles()
    }
    return NextResponse.json(settings)
  } catch (err) {
    // validateSettingsPatch rejects unknown keys, wrong types, and injecting values.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'invalid settings' },
      { status: 400 },
    )
  }
}
