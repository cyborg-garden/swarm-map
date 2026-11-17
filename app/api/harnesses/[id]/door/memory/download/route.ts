import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse, requireDoorAgent } from '@/lib/harness-ref'

/** Every room's notes as one Markdown file, redacted, as a download. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  try {
    const { name, text } = services.doorAgents.memoryMarkdown(id)
    return new NextResponse(text, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        // The name is the agent's, which is lower-case letters, digits and dashes.
        'Content-Disposition': `attachment; filename="${name.replace(/[^a-z0-9.-]/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return doorErrorResponse(err)
  }
}
