import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json({ tools: harness.tools })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const harness = services.harness.get(id)
  if (!harness) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  let body: { tools?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.tools)) {
    return NextResponse.json({ error: 'tools must be an array of strings' }, { status: 400 })
  }

  // Validate all tool IDs exist
  const allTools = services.tools.list()
  const validIds = new Set(allTools.map((t) => t.id))
  const invalid = body.tools.filter((tid) => !validIds.has(tid))
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Unknown tool IDs: ${invalid.join(', ')}` },
      { status: 400 }
    )
  }

  // Persist via harness overlay
  services.harness.updateConfig(id, { tools: body.tools })

  return NextResponse.json({ tools: body.tools })
}
