import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

type DockerHealth =
  | { available: true; version: string; serverVersion: string }
  | { available: false; error: string }

// This route is ungated (the setup wizard calls it before login), so anything
// that can reach the API — including agent containers — can hit it. Two guards:
//  - async exec: execSync blocked the whole server's event loop for up to 10s
//    per call when the engine was wedged.
//  - short TTL cache + in-flight dedupe: bounds `docker info` calls to one per
//    TTL no matter how many tabs poll or how hard a caller loops. Failures are
//    cached too, so a dead daemon isn't re-probed on every request.
const TTL_MS = 5000
let cache: { ts: number; data: DockerHealth } | null = null
let inflight: Promise<DockerHealth> | null = null

async function probe(): Promise<DockerHealth> {
  try {
    const { stdout: version } = await execFileAsync('docker', ['--version'], { timeout: 5000 })
    const { stdout: serverVersion } = await execFileAsync(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeout: 5000 },
    )
    return { available: true, version: version.trim(), serverVersion: serverVersion.trim() }
  } catch {
    return { available: false, error: 'Docker not found or not running' }
  }
}

export async function GET() {
  if (cache && Date.now() - cache.ts < TTL_MS) return NextResponse.json(cache.data)
  if (!inflight) {
    inflight = probe()
      .then((data) => {
        cache = { ts: Date.now(), data }
        return data
      })
      .finally(() => {
        inflight = null
      })
  }
  return NextResponse.json(await inflight)
}
