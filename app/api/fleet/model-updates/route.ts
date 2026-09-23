import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { readModelUpdateReport } from '@/lib/services/model-update-scheduler'

// GET /api/fleet/model-updates — the last persisted freshness report
// (DATA_DIR/model-updates.json). Empty shape when no check has run yet.
export async function GET() {
  const report = readModelUpdateReport(services.storage)
  if (!report) {
    const settings = services.config.getModelAutoUpdate()
    return NextResponse.json({ checkedAt: null, enabled: settings.enabled, mode: settings.mode, harnesses: [] })
  }
  return NextResponse.json(report)
}
