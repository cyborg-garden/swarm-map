import { isDoorRuntime } from '@/lib/services/runtime-adapter'

const LABELS: Record<string, string> = { pi: 'Pi', 'letta-code': 'Letta Code' }

/**
 * Says which harness an agent runs on, for agents that run behind a door.
 * A Hermes agent gets no badge: its row is drawn exactly as it always was.
 */
export function RuntimeBadge({ runtime }: { runtime?: string | null }) {
  if (!isDoorRuntime(runtime)) return null
  return (
    <span
      title="This agent runs in a sealed cell, behind a door that holds its chat connection, keys and rules"
      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap"
    >
      {LABELS[runtime]} · door
    </span>
  )
}
