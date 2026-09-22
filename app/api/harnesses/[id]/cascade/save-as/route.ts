import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { CascadeLibraryError } from '@/lib/services/cascades'
import { guessDataDir, readFallbackProviders } from '@/lib/services/harness'

// POST /api/harnesses/:id/cascade/save-as { name, overwrite? }
//
// Snapshots the harness's CURRENT fallback_providers (from config.yaml) into
// the named cascade library, with sourceHarness = this harness. api_key
// values present in config.yaml are stripped by the library. 400 when the
// harness has no fallback_providers block to save; 409 on an existing name
// unless overwrite:true.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  let body: { name?: string; overwrite?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const containerName = harness.serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(harness.serviceName ?? harness.name, containerName)

  const entries = readFallbackProviders(dataDir)
  if (entries.length === 0) {
    return NextResponse.json(
      { error: 'This harness has no fallback_providers cascade to save' },
      { status: 400 }
    )
  }

  try {
    const record = services.cascades.save(
      { name: body.name ?? '', entries, sourceHarness: id },
      { overwrite: body.overwrite === true }
    )
    return NextResponse.json(record, { status: 201 })
  } catch (err) {
    if (err instanceof CascadeLibraryError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }
}
