import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isLettaHarnessId } from '@/lib/services/letta-agent-provider'
import { invalidHarnessId, requireHarness } from '@/lib/harness-ref'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const invalid = invalidHarnessId(id)
  if (invalid) return invalid
  // Letta agents/server aren't containers — resolve them over REST (design §1c),
  // not through the sync container discovery in HarnessService.get().
  if (isLettaHarnessId(id)) {
    const harness = await services.lettaAgents.get(id)
    if (!harness) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json(harness)
  }
  const { harness, refusal } = requireHarness(id)
  if (refusal) return refusal
  return NextResponse.json(harness)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { refusal } = requireHarness(id)
  if (refusal) return refusal
  const url = new URL(request.url)
  const deleteFiles = url.searchParams.get('deleteFiles') === 'true'

  const result = services.harness.remove(id, deleteFiles)
  if (!result.removed) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json(result)
}
