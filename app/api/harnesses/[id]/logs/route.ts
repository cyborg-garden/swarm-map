import { NextResponse } from 'next/server'
import path from 'path'
import { services } from '@/lib/services'
import { guessDataDir, tailLogFile } from '@/lib/services/harness'

// Map the `?source=` query param to the file written inside the agent
// container under /opt/data/logs (host bind-mount <dataDir>/logs). The
// container logs INFO-level detail to these files; `docker logs` only carries
// the startup banner, so the file sources are the useful default.
const LOG_FILES = {
  gateway: 'gateway.log',
  agent: 'agent.log',
  errors: 'errors.log',
} as const

type LogSource = keyof typeof LOG_FILES | 'docker'

function parseSource(raw: string | null): LogSource {
  if (raw === 'docker' || raw === 'agent' || raw === 'errors' || raw === 'gateway') {
    return raw
  }
  return 'gateway'
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(_request.url)
  const lines = parseInt(url.searchParams.get('lines') ?? '200', 10)
  const source = parseSource(url.searchParams.get('source'))

  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  const composeFile = harness.composeFile
  const serviceName = harness.serviceName

  function dockerLogs() {
    if (!composeFile || !serviceName) {
      return NextResponse.json(
        { error: 'No compose config for this harness' },
        { status: 400 }
      )
    }
    const logs = services.docker.getLogs(composeFile, serviceName, lines)
    return NextResponse.json({ logs, lines, source: 'docker' })
  }

  // Explicit docker request → preserve the original behaviour.
  if (source === 'docker') {
    return dockerLogs()
  }

  // File-backed sources. The filename is whitelisted via the LOG_FILES enum,
  // and the directory is resolved strictly from the harness→dataDir mapping —
  // user input never forms any path segment, so there is no traversal surface.
  const containerName = serviceName
    ? harness.name === 'personal'
      ? 'hermes-personal'
      : `hermes-${harness.name}`
    : harness.name
  const dataDir = guessDataDir(serviceName ?? harness.name, containerName)
  const logPath = path.join(dataDir, 'logs', LOG_FILES[source])

  const logs = tailLogFile(logPath, lines)

  // Fall back to docker logs when the file is missing/empty so nothing regresses.
  if (!logs) {
    return dockerLogs()
  }

  return NextResponse.json({ logs, lines, source, path: logPath })
}
