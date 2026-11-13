import { NextResponse } from 'next/server'
import fs from 'fs'
import { MODEL_CATALOG, ENV_TO_PROVIDER } from '@/lib/model-catalog'
import { services } from '@/lib/services'
import { guessDataDir } from '@/lib/services/harness'
import path from 'path'

function detectProviders(envPath: string): string[] {
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    const providers = new Set<string>()
    for (const [envVar, provider] of Object.entries(ENV_TO_PROVIDER)) {
      const regex = new RegExp(`^${envVar}=.+$`, 'm')
      if (regex.test(content)) {
        providers.add(provider)
      }
    }
    // Detect ollama by port hint even if OLLAMA_BASE_URL isn't set
    if (content.includes('11434')) {
      providers.add('ollama')
    }
    return [...providers]
  } catch {
    return []
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(harness.serviceName ?? harness.name, containerName)
  const envPath = path.join(dataDir, '.env')

  if (!fs.existsSync(envPath)) {
    return NextResponse.json({ error: 'Agent .env not found' }, { status: 404 })
  }

  const providers = detectProviders(envPath)

  // Build suggested cascade: primary models first, then fallbacks, then local
  const suggested: Array<{
    provider: string
    model: string
    name: string
    tier: string
    base_url?: string
  }> = []

  for (const provider of providers) {
    const models = MODEL_CATALOG[provider] ?? []
    for (const model of models) {
      const entry: (typeof suggested)[number] = {
        provider,
        model: model.id,
        name: model.name,
        tier: model.tier,
      }
      if (provider === 'ollama') {
        entry.base_url = 'http://host.docker.internal:11434/v1'
      }
      suggested.push(entry)
    }
  }

  // Sort: primary first, fallback second, local last
  const tierOrder: Record<string, number> = { primary: 0, fallback: 1, local: 2 }
  suggested.sort((a, b) => (tierOrder[a.tier] ?? 1) - (tierOrder[b.tier] ?? 1))

  return NextResponse.json({
    providers,
    suggested,
    catalog: MODEL_CATALOG,
  })
}
