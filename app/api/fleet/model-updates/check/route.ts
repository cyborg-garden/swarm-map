import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { checkModelUpdates } from '@/lib/services/model-update-scheduler'

// POST /api/fleet/model-updates/check — run the freshness check now and
// return the report. Applies tracked successors only when the policy is
// enabled AND mode is 'apply' (same rule as the scheduled tick); pass
// { "apply": false } to force a report-only run.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  const settings = services.config.getModelAutoUpdate()
  const apply = body?.apply === false ? false : settings.enabled && settings.mode === 'apply'
  try {
    const report = await checkModelUpdates(undefined, { apply })
    services.audit.append({
      who: 'api',
      what: 'model-updates:check',
      target: 'fleet',
      meta: { apply, harnesses: report.harnesses.length },
    })
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'model update check failed' },
      { status: 500 },
    )
  }
}
