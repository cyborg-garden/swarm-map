import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

export async function GET() {
  // Pass the live harness names so every existing harness is considered.
  // Without this, listSurfaces() falls back to the configured default list and
  // harnesses added later never render a surface.
  const harnessNames = services.harness.list().map((h) => h.name)
  return NextResponse.json(services.config.listSurfaces(harnessNames))
}
