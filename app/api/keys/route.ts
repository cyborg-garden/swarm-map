import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { refuseUnknownHarnesses } from '@/lib/harness-ref'

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
  if (body.assignedTo?.length && body.value) {
    for (const harnessId of body.assignedTo) {
      services.keys.writeKeyToEnv(harnessId, body.provider, body.value, { name: body.name, envVar: body.envVar, identifier: body.identifier })
      try { services.harness.restart(harnessId, 'recreate') } catch {}
    }
  }

  return NextResponse.json(key, { status: 201 })
}
