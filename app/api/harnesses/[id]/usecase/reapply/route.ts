import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

// POST /api/harnesses/:id/usecase/reapply
// Body: { templateId: string }
//   Re-apply a use-case template to an already-deployed agent — update its
//   plugins/skills/SOUL from the template's pinned tag (trust-gated), enable new
//   plugins in config.yaml, and recreate the container. templateId is required
//   because it is not persisted at create time.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const templateId = typeof body?.templateId === 'string' ? body.templateId.trim() : ''
  if (!templateId) {
    return NextResponse.json({ error: 'templateId is required' }, { status: 400 })
  }
  try {
    const result = await services.harness.reapplyUseCaseTemplate(id, templateId)
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'usecase reapply failed'
    const status = /not found/i.test(msg)
      ? 404
      : /unknown use-case template/i.test(msg)
        ? 400
        : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
