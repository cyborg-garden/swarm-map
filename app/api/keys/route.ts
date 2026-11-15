import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { refuseUnknownHarnesses } from '@/lib/harness-ref'
import { restartEach, type RestartOutcome } from '@/lib/restart-outcome'

export async function GET() {
  return NextResponse.json(services.keys.list())
}

export async function POST(request: Request) {
  const body = await request.json()
  // Every agent the key is assigned to is resolved before the key is stored
  // or any .env is written.
  const refusal = refuseUnknownHarnesses(body.assignedTo)
  if (refusal) return refusal
  const key = services.keys.add(body)

  // Write key to assigned harnesses' .env files, then recreate so the new
  // value actually loads (env_file is read at container creation, not restart).
  // The key is saved either way; `restarts` says whether each recreate started.
  const restarts: RestartOutcome[] = []
  if (body.assignedTo?.length && body.value) {
    for (const harnessId of body.assignedTo) {
      services.keys.writeKeyToEnv(harnessId, body.provider, body.value, { name: body.name, envVar: body.envVar, identifier: body.identifier })
      restarts.push(...restartEach([harnessId], 'recreate', (h, mode) => services.harness.restart(h, mode)))
    }
  }

  return NextResponse.json({ ...key, restarts }, { status: 201 })
}
