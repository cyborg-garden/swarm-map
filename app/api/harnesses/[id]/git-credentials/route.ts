import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

/**
 * Refresh an agent's git credentials.
 *
 * Provisioning now lives in the agent runtime: a cont-init boot hook reads the
 * agent's own .env token and writes ~/.git-credentials + ~/.gitconfig into its
 * tool HOME. That hook is apply-if-absent, so after a token rotation the stale
 * files would survive. This endpoint forces a refresh by deleting those files
 * and recreating the container, so the boot hook regenerates them from the
 * current token — keeping the runtime as the single source of truth (HSM no
 * longer writes credential files itself).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const result = services.harness.refreshGitCredentials(id)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'git credential refresh failed' },
      { status: 500 },
    )
  }
}
