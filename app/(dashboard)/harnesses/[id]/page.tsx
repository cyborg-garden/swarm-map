'use client'

import { use, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useApi } from '@/lib/hooks/use-api'
import { StatusDot } from '@/components/shared/status-dot'
import { TierBadge } from '@/components/shared/tier-badge'
import { TierSelect } from '@/components/shared/tier-select'
import { CacheStatePill } from '@/components/shared/cache-state-pill'
import { DbHealthBadge, type DbIntegritySummary, type DbWriteFailureSummary } from '@/components/shared/db-health-badge'
import { Button } from '@/components/ui/button'
import { SplitButton } from '@/components/shared/split-button'
import { RiskBar } from '@/components/shared/risk-bar'
import { TierMix } from '@/components/shared/tier-mix'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Harness, HabitatTier, Tool, Key, MemoryScope, Surface } from '@/lib/types'
import { providerOptions } from '@/lib/key-providers'
import { SignalSetupDialog } from '@/components/surfaces/signal-setup-dialog'
import { TelegramSetupDialog } from '@/components/surfaces/telegram-setup-dialog'
import { MattermostSetupDialog } from '@/components/surfaces/mattermost-setup-dialog'
import { DiscordSetupDialog } from '@/components/surfaces/discord-setup-dialog'
import { SlackSetupDialog } from '@/components/surfaces/slack-setup-dialog'
import { EditSurfaceDialog } from '@/components/surfaces/edit-surface-dialog'
import { SignalPinManager } from '@/components/surfaces/signal-pin-manager'
import { SettingsTab } from '@/components/harness/settings-tab'
import { AnalyticsTab } from '@/components/harness/analytics-tab'
import { toast } from 'sonner'
import { Globe, Bot, Pencil, ChevronDown, ChevronRight, Shield, Loader2, Save, RotateCw, Users, X } from 'lucide-react'
import { SURFACE_SLUGS } from '@/lib/surfaces/registry'
import { ADMISSION_FIELD_LABELS, SURFACE_LIST_ICONS } from '@/components/surfaces/platform-ui'
import { TagInput } from '@/components/ui/tag-input'
import { Switch } from '@/components/ui/switch'
import { TIER_LABELS } from '@/lib/constants'
import { LettaAgentDetail } from '@/components/harness/letta-agent-detail'
import { ModelsTab, cascadeSaveConflict, type ModelConfig } from '@/components/harness/models-tab'

type PairingUser = {
  userId: string
  userName: string
  approvedAt: number
  platform: string
}

type SurfaceSettings = {
  allowedUsers: string[]
  allowedGroups: string[]
  adminUsers: string[]
  allowAll: boolean
}

type Settings = {
  dmPolicy: 'approved-only' | 'allow-all'
  surfaces: Record<string, SurfaceSettings>
  // Optimistic-concurrency token from GET; round-tripped in PUT, refreshed
  // from the PUT response. A stale token gets a 409 instead of a lost update.
  version?: string
}

// Derived from the surface registry + platform-ui metadata; widened to string
// indexes because this page also renders non-surface platforms (web, api).
const PLATFORM_LABELS: Record<string, { users: string; groups: string }> = {
  ...ADMISSION_FIELD_LABELS,
}

const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  ...Object.fromEntries(
    SURFACE_SLUGS.map((p) => {
      const Icon = SURFACE_LIST_ICONS[p]
      return [p, <Icon key={p} className="h-4 w-4" />]
    }),
  ),
  // Non-registry surfaces keep their page-local icons.
  web: <Globe className="h-4 w-4" />,
  api: <Bot className="h-4 w-4" />,
}

const SURFACE_STATUS_STYLES: Record<Surface['status'], string> = {
  connected: 'bg-[var(--success)]/10 text-[var(--success)]',
  available: 'bg-muted text-muted-foreground',
  planned: 'bg-[var(--warning)]/10 text-[var(--warning)]',
}


type LogsResponse = { logs: string; lines: number }

type HealthResponse = {
  status: 'healthy' | 'starting' | 'unhealthy'
  running: boolean
  restartCount: number
  uptimeSec: number | null
  db?: {
    integrity: DbIntegritySummary | null
    writeFailures: DbWriteFailureSummary | null
  }
}

type UsageByModel = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  cost: number
  sessionCount: number
  costStatus: 'estimated' | 'unknown'
}

type UsageSession = {
  sessionId: string
  model: string
  startedAt: number
  endedAt: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number
  costStatus: 'estimated' | 'unknown'
}

type UsageData = {
  costToday: number
  costWeek: number
  costMonth: number
  totalTokensToday: number
  sessionCountToday: number
  costStatus: 'estimated' | 'partial' | 'unknown'
  byModel: UsageByModel[]
  recentSessions: UsageSession[]
}

/**
 * Render a cost, honoring the number|null "never $0 when unknown" contract
 * (#204 PR2): null/undefined (migrated harness whose snapshot hasn't exported
 * yet, or usage still loading) renders '—', matching harness-card — a
 * confident $0.00 here is exactly the misread the contract exists to prevent.
 */
function fmtUsd(v: number | null | undefined, costStatus?: 'estimated' | 'partial' | 'unknown'): string {
  if (v == null) return '—'
  return `${costStatus === 'estimated' ? '~' : ''}$${v.toFixed(2)}`
}

// Runtime-branching wrapper (design §4a). Letta harnesses have no container, so
// their detail view is a dedicated read-only component rather than a thicket of
// `runtime === 'letta'` branches through the container-shaped Hermes page below.
// Fetching harness here (before branching) keeps rules-of-hooks intact — each
// child owns its own hooks.
export default function HarnessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { data: harness, loading } = useApi<Harness>(`/api/harnesses/${id}`)

  if (loading && !harness) {
    return <p className="text-muted-foreground">Loading...</p>
  }
  if (harness && (harness.runtime === 'letta' || harness.runtime === 'letta-server')) {
    return <LettaAgentDetail harness={harness} />
  }
  return <HermesHarnessDetail params={params} />
}

function HermesHarnessDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const { data: harness, loading, refetch } = useApi<Harness>(`/api/harnesses/${id}`)
  const { data: tools } = useApi<Tool[]>('/api/tools')
  const { data: keys, refetch: refetchKeys } = useApi<Key[]>('/api/keys')
  const { data: memoryScopes } = useApi<MemoryScope[]>('/api/memory-scopes')
  const { data: surfaces, refetch: refetchSurfaces } = useApi<Surface[]>('/api/surfaces')
  const { data: modelConfig, refetch: refetchModels } = useApi<ModelConfig>(`/api/harnesses/${id}/models`)
  const { data: usageData } = useApi<UsageData>(`/api/harnesses/${id}/usage`)
  // DB integrity + write-failure signal (#204) — server-side cached.
  const { data: healthData } = useApi<HealthResponse>(`/api/harnesses/${id}/health`, 30000)

  const [connectDialog, setConnectDialog] = useState<string | null>(null)
  const [editSurface, setEditSurface] = useState<Surface | null>(null)
  const [tierOverride, setTierOverride] = useState<HabitatTier | null>(null)

  // Model edit state
  const [modelProvider, setModelProvider] = useState('')
  const [modelName, setModelName] = useState('')
  const [modelSaving, setModelSaving] = useState(false)
  // Bumped after a 409 so the editor remounts on the freshly fetched rows.
  const [cascadeEditorGen, setCascadeEditorGen] = useState(0)

  // Surface settings state
  const [surfaceSettings, setSurfaceSettings] = useState<Settings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [settingsRestarting, setSettingsRestarting] = useState(false)
  const [discovering, setDiscovering] = useState<string | null>(null)
  const [discoveredGroups, setDiscoveredGroups] = useState<Array<{id: string; name: string}>>([])
  const [pairedUsers, setPairedUsers] = useState<PairingUser[]>([])
  const [expandedSettings, setExpandedSettings] = useState<Record<string, boolean>>({})
  const [pinStatus, setPinStatus] = useState<Record<string, string>>({})
  const [profileNameDraft, setProfileNameDraft] = useState<Record<string, string>>({})
  const [profileNameSaving, setProfileNameSaving] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch('/api/surfaces/signal')
      .then(r => r.json())
      .then(data => { if (data.pinStatus) setPinStatus(data.pinStatus) })
      .catch(() => {})
  }, [])

  // Tool toggle state
  const [toolsSaving, setToolsSaving] = useState(false)

  // Key management state
  const [showAddKey, setShowAddKey] = useState(false)
  const [newKeyProvider, setNewKeyProvider] = useState('')
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [newKeyBudget, setNewKeyBudget] = useState('')
  const [newKeyEnvVar, setNewKeyEnvVar] = useState('')
  const [keySaving, setKeySaving] = useState(false)
  const [showAssignKey, setShowAssignKey] = useState(false)

  async function toggleTool(toolId: string, enabled: boolean) {
    if (!harness) return
    const current = new Set(harness.tools)
    if (enabled) {
      current.add(toolId)
    } else {
      current.delete(toolId)
    }
    const newTools = Array.from(current)
    setToolsSaving(true)
    try {
      const res = await fetch(`/api/harnesses/${id}/tools`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: newTools }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to update tools')
        return
      }
      refetch()
      toast.success(enabled ? 'Tool enabled' : 'Tool disabled')
    } catch {
      toast.error('Failed to update tools')
    } finally {
      setToolsSaving(false)
    }
  }

  async function addKeyToHarness() {
    if (!harness || !newKeyProvider || !newKeyValue) return
    setKeySaving(true)
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: newKeyProvider,
          value: newKeyValue,
          assignedTo: [harness.id],
          ...(newKeyName ? { name: newKeyName } : {}),
          // Only meaningful for custom/unknown providers — resolveEnvVar ignores
          // the hint for mapped ones, but don't send a stale value regardless.
          ...(newKeyEnvVar && newKeyProvider === 'custom' ? { envVar: newKeyEnvVar } : {}),
          ...(newKeyBudget ? { budgetUsd: parseFloat(newKeyBudget) } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to add key')
        return
      }
      toast.success(`${newKeyProvider} key added`)
      setShowAddKey(false)
      setNewKeyProvider('')
      setNewKeyName('')
      setNewKeyValue('')
      setNewKeyBudget('')
      setNewKeyEnvVar('')
      // Recreate (not 'quick') so the new env_file value actually loads — a plain
      // restart keeps the old creation-time env. (POST /api/keys also recreates
      // server-side; this is the belt-and-suspenders client trigger.)
      await fetch(`/api/harnesses/${id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'recreate' }),
      })
      toast.success('Restarting agent to apply key...')
      refetch()
      window.location.reload()
    } catch {
      toast.error('Failed to add key')
    } finally {
      setKeySaving(false)
    }
  }

  async function assignExistingKey(keyId: string) {
    if (!harness) return
    const key = keys?.find((k) => k.id === keyId)
    if (!key) return
    // Warn on duplicate provider
    const currentHarnessKeys = keys?.filter((k) => k.assignedTo.includes(harness.id)) ?? []
    const existingProviderKey = currentHarnessKeys.find((k) => k.provider === key.provider && k.id !== keyId)
    if (existingProviderKey) {
      toast.warning(`Warning: this harness already has a ${key.provider} key — the new one will overwrite it in .env`)
    }
    setKeySaving(true)
    try {
      const res = await fetch(`/api/keys/${keyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedTo: [...key.assignedTo, harness.id],
        }),
      })
      if (!res.ok) {
        toast.error('Failed to assign key')
        return
      }
      toast.success(`${key.provider} key assigned`)
      setShowAssignKey(false)
      // Recreate (not 'quick') so the newly-assigned env_file value actually
      // loads — a plain restart keeps the old creation-time env, so the key
      // would appear assigned but never reach the running process (D3).
      await fetch(`/api/harnesses/${id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'recreate' }),
      })
      toast.success('Restarting agent to apply key...')
      refetch()
      window.location.reload()
    } catch {
      toast.error('Failed to assign key')
    } finally {
      setKeySaving(false)
    }
  }

  useEffect(() => {
    fetch(`/api/harnesses/${id}/settings`)
      .then(res => res.json())
      .then(data => {
        if (!data.error) setSurfaceSettings(data)
        setSettingsLoading(false)
      })
      .catch(() => setSettingsLoading(false))
  }, [id])

  useEffect(() => {
    fetch(`/api/harnesses/${id}/pairing`)
      .then(res => res.json())
      .then(data => { if (data.users) setPairedUsers(data.users) })
      .catch(() => {})
  }, [id])

  function updateSurfaceSetting(platform: string, field: keyof SurfaceSettings, value: string[] | boolean) {
    if (!surfaceSettings) return
    setSurfaceSettings({
      ...surfaceSettings,
      surfaces: {
        ...surfaceSettings.surfaces,
        [platform]: { ...surfaceSettings.surfaces[platform], [field]: value },
      },
    })
    setSettingsDirty(true)
    setSettingsSaved(false)
  }

  function updateDmPolicy(policy: 'approved-only' | 'allow-all') {
    if (!surfaceSettings) return
    setSurfaceSettings({ ...surfaceSettings, dmPolicy: policy })
    setSettingsDirty(true)
    setSettingsSaved(false)
  }

  async function handleSettingsSave() {
    if (!surfaceSettings) return
    setSettingsSaving(true)
    try {
      const res = await fetch(`/api/harnesses/${id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(surfaceSettings),
      })
      const data = await res.json()
      if (res.status === 409) {
        // Someone else saved since this snapshot was loaded (another tab, the
        // Settings tab, a policy write). Re-fetch rather than overwrite them.
        toast.error(data.error || 'Settings changed since you loaded them — reloaded, re-apply your edit.')
        const fresh = await fetch(`/api/harnesses/${id}/settings`).then(r => r.json()).catch(() => null)
        if (fresh && !fresh.error) {
          setSurfaceSettings(fresh)
          setSettingsDirty(false)
        }
      } else if (data.success) {
        setSettingsDirty(false)
        // Carry the fresh version token so the next save doesn't 409 against
        // our own write.
        if (data.version) {
          setSurfaceSettings(prev => (prev ? { ...prev, version: data.version } : prev))
        }
        if (data.restarted) {
          // The PUT handler already recreated the container — no second restart needed.
          // A second POST /restart would hit the recreate's lock and return 409,
          // which the old code surfaced as "restart failed — restart manually".
          toast.success('Settings saved. Agent restarting...')
          setSettingsSaved(false)
          refetch()
        } else {
          toast.success(data.unchanged ? 'No changes — agent left running.' : 'Settings saved')
          // A no-op save needs no "restart to apply" affordance.
          setSettingsSaved(!data.unchanged)
        }
      } else {
        toast.error(data.error || 'Failed to save')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setSettingsSaving(false)
    }
  }

  async function handleSettingsRestart() {
    setSettingsRestarting(true)
    try {
      const res = await fetch(`/api/harnesses/${id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'rebuild' }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Harness restarted')
        setSettingsSaved(false)
        refetch()
      } else {
        toast.error(data.error || 'Restart failed')
      }
    } catch {
      toast.error('Restart failed')
    } finally {
      setSettingsRestarting(false)
    }
  }

  async function revokePairing(platform: string, userId: string) {
    if (!window.confirm(`Revoke access for ${userId}?`)) return
    try {
      const res = await fetch(`/api/harnesses/${id}/pairing`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, userId }),
      })
      if (res.ok) {
        setPairedUsers(prev => prev.filter(u => !(u.platform === platform && u.userId === userId)))
        toast.success('Access revoked')
      } else {
        toast.error('Failed to revoke')
      }
    } catch {
      toast.error('Network error')
    }
  }

  async function discoverGroups(platform: string, connSurfaces: Surface[]) {
    setDiscovering(platform)
    setDiscoveredGroups([])
    try {
      let url = ''
      if (platform === 'signal') {
        const surfaceInfo = connSurfaces.find(s => s.platform.toLowerCase() === 'signal')
        const phone = surfaceInfo?.config?.phone
        if (!phone) { toast.error('No Signal phone configured'); return }
        url = `/api/surfaces/signal/groups?phone=${encodeURIComponent(phone)}`
      } else if (platform === 'mattermost') {
        const surfaceInfo = connSurfaces.find(s => s.platform.toLowerCase() === 'mattermost')
        const mmUrl = surfaceInfo?.config?.url
        if (!mmUrl) { toast.error('No Mattermost URL configured'); return }
        url = `/api/surfaces/mattermost/channels?url=${encodeURIComponent(mmUrl)}&token=from-env`
      }
      const res = await fetch(url)
      const data = await res.json()
      setDiscoveredGroups(data.groups || data.channels || [])
    } catch {
      toast.error('Failed to discover groups')
    } finally {
      setDiscovering(null)
    }
  }

  const [logLines, setLogLines] = useState(100)
  const { data: logsData, loading: logsLoading, refetch: refetchLogs } = useApi<LogsResponse>(
    `/api/harnesses/${id}/logs?lines=${logLines}`
  )

  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const ACTION_LABELS: Record<string, { loading: string; success: string }> = {
    quick: { loading: 'Restarting…', success: 'Harness restarted' },
    rebuild: { loading: 'Rebuilding…', success: 'Harness rebuilt and restarted' },
    purge: { loading: 'Purging…', success: 'Cache purged and harness restarted' },
  }

  async function doRestart(mode: string) {
    const labels = ACTION_LABELS[mode] ?? { loading: 'Restarting…', success: `Harness restarted (${mode})` }
    const toastId = toast.loading(labels.loading)
    setActionLoading(mode)
    try {
      const res = await fetch(`/api/harnesses/${id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(labels.success, { id: toastId })
      refetch()
    } catch {
      toast.error('Restart failed', { id: toastId })
    } finally {
      setActionLoading(null)
    }
  }

  async function doStop() {
    setActionLoading('stop')
    try {
      const res = await fetch(`/api/harnesses/${id}/stop`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success('Harness stopped')
      refetch()
    } catch {
      toast.error('Stop failed')
    } finally {
      setActionLoading(null)
    }
  }

  async function doStart() {
    setActionLoading('start')
    try {
      const res = await fetch(`/api/harnesses/${id}/start`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success('Harness started')
      refetch()
    } catch {
      toast.error('Start failed')
    } finally {
      setActionLoading(null)
    }
  }

  async function doDuplicate() {
    const newName = window.prompt('Name for the duplicate harness:')
    if (!newName) return
    try {
      const res = await fetch(`/api/harnesses/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Duplicate failed')
        return
      }
      toast.success(`Duplicated as "${newName}"`)
      router.push('/harnesses')
    } catch {
      toast.error('Duplicate failed')
    }
  }

  async function doRemove() {
    const name = harness?.name ?? id
    const confirmed = window.confirm(
      `Remove "${name}" from HSM?\n\nThis will stop the container and unregister it.`
    )
    if (!confirmed) return

    const deleteFiles = window.confirm(
      `Also delete all data files for "${name}"?\n\nClick OK to delete files, or Cancel to keep them.`
    )

    try {
      const res = await fetch(`/api/harnesses/${id}?deleteFiles=${deleteFiles}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Remove failed')
        return
      }
      toast.success(`Removed "${name}"`)
      router.push('/harnesses')
    } catch {
      toast.error('Remove failed')
    }
  }

  async function saveModelConfig() {
    const provider = modelProvider || modelConfig?.provider || ''
    const model = modelName || modelConfig?.primary || ''
    if (!provider || !model) {
      toast.error('Provider and model are required')
      return
    }
    setModelSaving(true)
    try {
      const res = await fetch(`/api/harnesses/${id}/models`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to save model config')
        return
      }
      toast.success('Model config saved')
      setModelProvider('')
      setModelName('')
      refetchModels()
      // Auto-restart to pick up model changes
      await fetch(`/api/harnesses/${id}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'quick' }),
      })
      toast.success('Restarting agent to apply model changes...')
    } catch {
      toast.error('Failed to save model config')
    } finally {
      setModelSaving(false)
    }
  }

  if (loading) return <p className="text-muted-foreground">Loading...</p>
  if (!harness) return <p className="text-destructive">Harness not found.</p>

  const allToolsEnabled = harness.tools.length === 0
  const harnessTools = allToolsEnabled ? (tools ?? []) : tools?.filter((t) => harness.tools.includes(t.id)) ?? []
  const allTools = tools ?? []
  const harnessKeys = keys?.filter((k) => k.assignedTo.includes(harness.id)) ?? []
  const harnessMemory = memoryScopes?.filter((m) => m.members.includes(harness.id)) ?? []
  const connectedSurfaces = surfaces?.filter((s) => s.harnessIds.includes(harness.id)) ?? []
  const connectedPlatforms = new Set(connectedSurfaces.map((s) => s.platform))
  const otherSurfaces = surfaces?.filter((s) =>
    !s.harnessIds.includes(harness.id) &&
    (s.status === 'available' || s.status === 'planned') &&
    !connectedPlatforms.has(s.platform)
  ) ?? []

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <StatusDot status={harness.status} />
          <div>
            <h2 className="text-2xl font-semibold">{harness.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <TierSelect
                harnessId={harness.id}
                currentTier={tierOverride ?? harness.tier}
                tools={harnessTools}
                onTierChanged={(newTier) => setTierOverride(newTier)}
              />
              <span className="text-sm text-muted-foreground">{harness.persona}</span>
              {harness.cacheState && (
                <CacheStatePill state={harness.cacheState} age={harness.cacheAge} />
              )}
              <DbHealthBadge
                integrity={healthData?.db?.integrity}
                writeFailures={healthData?.db?.writeFailures}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={doDuplicate}>
            Duplicate
          </Button>
          <Button variant="outline" size="sm" onClick={doRemove} className="text-destructive border-destructive/30 hover:bg-destructive/10">
            Remove
          </Button>
          <SplitButton
            label="Quick Restart"
            loadingLabel={
              actionLoading === 'rebuild' ? 'Rebuilding…' :
              actionLoading === 'purge' ? 'Purging…' :
              'Restarting…'
            }
            onClick={() => doRestart('quick')}
            disabled={harness.status === 'stopped'}
            loading={!!actionLoading && actionLoading !== 'stop' && actionLoading !== 'start'}
            items={[
              { label: 'Rebuild', description: 'Rebuild container', onClick: () => doRestart('rebuild') },
              { label: 'Purge & Restart', description: 'Clear cache and restart', onClick: () => doRestart('purge') },
            ]}
          />
          {harness.status === 'stopped' ? (
            <Button variant="outline" size="sm" onClick={doStart} disabled={actionLoading === 'start'}>
              {actionLoading === 'start' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Starting…</>
              ) : 'Start'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={doStop} disabled={actionLoading === 'stop'}>
              {actionLoading === 'stop' ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Stopping…</>
              ) : 'Stop'}
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="tools">Tools ({allToolsEnabled ? allTools.length : harnessTools.length}/{allTools.length})</TabsTrigger>
          <TabsTrigger value="surfaces">Surfaces ({connectedSurfaces.length})</TabsTrigger>
          <TabsTrigger value="keys">Keys ({harnessKeys.length})</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
              <h3 className="font-medium text-sm">Runtime</h3>
              <Row label="Runtime" value={harness.runtime} />
              <Row label="Platform" value={`${harness.platform} / ${harness.channel}`} />
              <Row label="Status" value={harness.status} />
              <Row label="Models" value={harness.models.join(', ')} />
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
              <h3 className="font-medium text-sm">Usage</h3>
              {/* null/absent usage = unknown (migrated harness, snapshot pending) —
                  render '—' like harness-card, never a confident $0.00 */}
              <Row label="Sessions today" value={usageData?.sessionCountToday ?? '—'} />
              <Row label="Cost today" value={fmtUsd(usageData?.costToday ?? harness.costToday, usageData?.costStatus)} />
              <Row label="Cost this week" value={fmtUsd(usageData?.costWeek, usageData?.costStatus)} />
              <Row label="Cost this month" value={fmtUsd(usageData?.costMonth, usageData?.costStatus)} />
              <Row label="CPU" value={`${harness.cpu}%`} />
              <Row label="Memory" value={`${harness.mem} MiB`} />
            </div>
            {harness.health.errors > 0 && (
              <div className="col-span-2 rounded-xl border border-[var(--danger)] bg-[var(--danger)]/5 p-4">
                <p className="text-sm font-medium text-destructive">{harness.health.errors} error(s)</p>
                {harness.health.errorMsg && (
                  <p className="text-xs text-muted-foreground mt-1 font-mono">{harness.health.errorMsg}</p>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <div className="space-y-4">
            {/* Cost summary cards */}
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Today</p>
                <p className="text-2xl font-semibold mt-1">
                  {fmtUsd(usageData?.costToday, usageData?.costStatus)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{usageData?.sessionCountToday ?? '—'} sessions</p>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">This Week</p>
                <p className="text-2xl font-semibold mt-1">
                  {fmtUsd(usageData?.costWeek, usageData?.costStatus)}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">This Month</p>
                <p className="text-2xl font-semibold mt-1">
                  {fmtUsd(usageData?.costMonth, usageData?.costStatus)}
                </p>
              </div>
            </div>

            {/* Per-model breakdown */}
            {usageData && usageData.byModel.length > 0 && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="p-4 border-b border-[var(--border)]">
                  <h3 className="font-medium text-sm">Cost by Model (Today)</h3>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                      <th className="text-left px-4 py-2">Model</th>
                      <th className="text-right px-4 py-2">Input</th>
                      <th className="text-right px-4 py-2">Output</th>
                      <th className="text-right px-4 py-2">Cache R</th>
                      <th className="text-right px-4 py-2">Cache W</th>
                      <th className="text-right px-4 py-2">Sessions</th>
                      <th className="text-right px-4 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageData.byModel.map((m) => (
                      <tr key={m.model} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-4 py-2 font-mono text-xs">{m.model}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatTokens(m.inputTokens)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatTokens(m.outputTokens)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatTokens(m.cacheReadTokens)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{formatTokens(m.cacheWriteTokens)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{m.sessionCount}</td>
                        <td className="px-4 py-2 text-right font-medium">
                          {m.costStatus === 'estimated' ? '~' : ''}${m.cost.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* Recent sessions */}
            {usageData && usageData.recentSessions.length > 0 && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                <div className="p-4 border-b border-[var(--border)]">
                  <h3 className="font-medium text-sm">Recent Sessions</h3>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                      <th className="text-left px-4 py-2">Time</th>
                      <th className="text-left px-4 py-2">Model</th>
                      <th className="text-right px-4 py-2">Tokens</th>
                      <th className="text-right px-4 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageData.recentSessions.map((s) => (
                      <tr key={s.sessionId} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {new Date(s.startedAt * 1000).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">{s.model}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {formatTokens(s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens + s.reasoningTokens)}
                        </td>
                        <td className="px-4 py-2 text-right font-medium">
                          {s.costStatus === 'estimated' ? '~' : ''}${s.estimatedCostUsd.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {!usageData && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
                <p className="text-sm text-muted-foreground">No usage data available. The agent may not have a state.db yet.</p>
              </div>
            )}

            {usageData?.costStatus && (
              <p className="text-xs text-muted-foreground">
                {usageData.costStatus === 'estimated' && 'Costs are estimates based on published model pricing.'}
                {usageData.costStatus === 'partial' && 'Some models have unknown pricing. Costs are partially estimated.'}
                {usageData.costStatus === 'unknown' && 'Model pricing not available. Token counts are shown but costs cannot be estimated.'}
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <AnalyticsTab harnessId={harness.id} />
        </TabsContent>

        <TabsContent value="models" className="mt-4">
          {/* Only mount the editor once GET /models has resolved. Mounting it
              earlier seeded rows from harness.models with no provider and no
              base_url, and a save then wrote that guess over the real chain
              (issue #149). */}
          {!modelConfig ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading model cascade...
              </p>
            </div>
          ) : (
          <ModelsTab
            harnessId={id}
            modelConfig={{ ...modelConfig, models: modelConfig.models ?? harness.models ?? [] }}
            modelTracking={harness.modelTracking}
            // editorKey forces a remount per harness — the editor seeds its
            // cascade into local state once, so without this an in-app A→B nav
            // keeps A's cascade and saving B's Models tab could persist A's
            // cascade (D6). The generation bumps after a 409 reload.
            editorKey={`${id}:${cascadeEditorGen}`}
            // A saved-cascade apply or a successor update rewrote config.yaml
            // (and restarted) server-side — reload rows + tracking, remount.
            onCascadeChanged={() => {
              refetchModels()
              refetch()
              setCascadeEditorGen((g) => g + 1)
            }}
            onSave={async (chain, opts) => {
              setModelSaving(true)
              try {
                const res = await fetch(`/api/harnesses/${id}/models`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  // The edited chain (row 1 = primary → model:, the rest →
                  // fallback_providers) plus what this editor was seeded
                  // from. The server refuses (409) when the chain on disk no
                  // longer matches — the model-update scheduler or another
                  // tab wrote since — so a stale save cannot silently undo
                  // an applied update.
                  // set_primary: the editor passes it only from the state
                  // where the file had no primary and the operator saw the
                  // note — without it the server refuses to promote a
                  // fallback into model.default (no-primary-in-file).
                  body: JSON.stringify({
                    chain,
                    expected_chain: modelConfig.chain ?? [],
                    ...(opts?.setPrimary ? { set_primary: true } : {}),
                  }),
                })
                if (res.status === 409) {
                  // Two conflicts share the status. duplicate-sections
                  // (hand-edit config.yaml) is the operator's to fix — show
                  // the writer's message and keep the edit. Only the stale
                  // conflict reloads and remounts.
                  const conflict = cascadeSaveConflict(await res.json().catch(() => null))
                  if (conflict.kind !== 'stale') {
                    toast.error(conflict.message)
                    return
                  }
                  toast.error('The cascade changed since you opened it — reloaded; please re-apply your edit')
                  await refetchModels()
                  setCascadeEditorGen((g) => g + 1)
                  return
                }
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}))
                  toast.error(err.error ?? 'Failed to save')
                  return
                }
                toast.success('Model cascade saved')
                refetchModels()
                // Auto-restart to pick up cascade changes
                await fetch(`/api/harnesses/${id}/restart`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mode: 'quick' }),
                })
                toast.success('Restarting agent to apply model changes...')
              } catch { toast.error('Failed to save') }
              finally { setModelSaving(false) }
            }}
            saving={modelSaving}
          />
          )}
        </TabsContent>

        <TabsContent value="surfaces" className="mt-4">
          <div className="space-y-4">
            {/* Connected surfaces with inline settings */}
            {connectedSurfaces.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Connected</h3>
                {connectedSurfaces.map((s) => {
                  const platform = s.platform.toLowerCase()
                  const surf = surfaceSettings?.surfaces[platform]
                  const labels = PLATFORM_LABELS[platform] || { users: 'Users', groups: 'Groups' }
                  const isExpanded = expandedSettings[s.id] ?? false
                  const platformPairedUsers = pairedUsers.filter(u => u.platform === platform)

                  return (
                    <div key={s.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
                      {/* Surface header row */}
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground">
                            {PLATFORM_ICONS[platform] ?? <Globe className="h-4 w-4" />}
                          </span>
                          <div>
                            <p className="font-medium text-sm">{s.name}</p>
                            <p className="text-xs text-muted-foreground capitalize">{s.platform}</p>
                            {s.config.url && (
                              <p className="text-xs font-mono text-muted-foreground">{s.config.url}</p>
                            )}
                            {s.config.phone && (
                              <p className="text-xs font-mono text-muted-foreground">{s.config.phone}</p>
                            )}
                            {s.config.profileName && (
                              <p className="text-xs text-muted-foreground italic">{s.config.profileName}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SURFACE_STATUS_STYLES[s.status]}`}>
                            {s.status}
                          </span>
                          {surf && (
                            <button
                              onClick={() => setExpandedSettings(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                              className="text-xs px-2 py-1 rounded-md border border-[var(--border)] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex items-center gap-1"
                              title="Surface settings"
                            >
                              {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              <span>Settings</span>
                            </button>
                          )}
                          <button
                            onClick={() => setEditSurface(s)}
                            className="text-xs px-2 py-1 rounded-md border border-[var(--border)] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Edit config"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={async () => {
                              if (!window.confirm(`Disconnect ${s.name}? This will remove its configuration.`)) return
                              try {
                                const res = await fetch(`/api/harnesses/${id}/surfaces/disconnect`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ platform }),
                                })
                                if (!res.ok) throw new Error('Failed')
                                toast.success(`${s.name} disconnected`)
                                refetchSurfaces()
                              } catch {
                                toast.error(`Failed to disconnect ${s.name}`)
                              }
                            }}
                            className="text-xs px-2 py-1 rounded-md border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white transition-colors"
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>

                      {/* Expandable settings section */}
                      {isExpanded && surf && (
                        <div className="border-t border-[var(--border)] p-4 space-y-4 bg-[var(--bg)]/50">
                          {platform === 'signal' && s.config.phone && (
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-muted-foreground">Signal profile name</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={profileNameDraft[s.id] ?? s.config.profileName ?? ''}
                                  onChange={(e) => setProfileNameDraft(prev => ({ ...prev, [s.id]: e.target.value }))}
                                  placeholder="Display name shown to Signal contacts"
                                  className="flex-1 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
                                />
                                <button
                                  disabled={profileNameSaving[s.id] || !(profileNameDraft[s.id] ?? s.config.profileName ?? '').trim()}
                                  onClick={async () => {
                                    setProfileNameSaving(prev => ({ ...prev, [s.id]: true }))
                                    try {
                                      const res = await fetch('/api/surfaces/signal/profile', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                          phone: s.config.phone,
                                          displayName: (profileNameDraft[s.id] ?? s.config.profileName ?? '').trim(),
                                        }),
                                      })
                                      const data = await res.json()
                                      if (data.success) {
                                        toast.success('Signal profile name updated')
                                        refetchSurfaces()
                                      } else {
                                        toast.error(data.error || 'Failed to update profile name')
                                      }
                                    } catch {
                                      toast.error('Failed to update profile name')
                                    } finally {
                                      setProfileNameSaving(prev => ({ ...prev, [s.id]: false }))
                                    }
                                  }}
                                  className="text-xs px-3 py-2 rounded-md border border-[var(--border)] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                                >
                                  {profileNameSaving[s.id] ? 'Saving…' : 'Update'}
                                </button>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                The name contacts see when they DM this number. Written to the Signal daemon.
                              </p>
                            </div>
                          )}
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              {/* One label on every platform, because it is one concept on
                                  every platform: this field renders to
                                  {PLATFORM}_ALLOWED_USERS — ADMISSION (who the bot answers).
                                  Admin PRIVILEGE is the separate surfaceAdmins overlay, which
                                  merely BOOTSTRAPS from this list until an explicit admin
                                  list is set. Labeling admission "Admins" caused a real
                                  incident (approved Discord channel, silent bot). */}
                              Allowed users ({labels.users})
                            </label>
                            <TagInput
                              values={surf.allowedUsers}
                              onChange={(v) => updateSurfaceSetting(platform, 'allowedUsers', v)}
                              placeholder={`Add ${labels.users.toLowerCase()}...`}
                              renderTag={(value) => {
                                const resolved = (surf as { resolvedUsers?: Array<{ display: string; nativeId: string; profileName?: string }> }).resolvedUsers?.find(
                                  (r) => r.display === value || r.nativeId === value
                                )
                                return resolved?.profileName
                                  ? `${value} (${resolved.profileName})`
                                  : value
                              }}
                            />
                            <p className="text-xs text-muted-foreground">
                              The user allowlist: who the bot answers. Until an explicit
                              per-surface admin list is set, these users also act as the
                              surface&apos;s admins (DM, add to groups, approve commands, global
                              memory).
                              {platform === 'discord' && (
                                <> Everyone else is only answered in Approved Channels, and only
                                when channel-scoped access (DISCORD_CHANNEL_SCOPED_ACCESS) is
                                enabled on the agent. Usernames are resolved to IDs
                                automatically.</>
                              )}
                              {platform === 'telegram' && (
                                <> Entries may be numeric Telegram user IDs or @usernames — @usernames are resolved to IDs automatically.</>
                              )}
                            </p>
                          </div>

                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Approved {labels.groups}</label>
                            <TagInput
                              values={surf.allowedGroups}
                              onChange={(v) => updateSurfaceSetting(platform, 'allowedGroups', v)}
                              placeholder={`Add ${labels.groups.toLowerCase()}...`}
                            />
                            <p className="text-xs text-muted-foreground">Leave empty + use * for all groups</p>
                            {(platform === 'signal' || platform === 'mattermost') && (
                              <div className="space-y-2 pt-1">
                                <button
                                  onClick={() => discoverGroups(platform, connectedSurfaces)}
                                  disabled={discovering === platform}
                                  className="text-xs text-[var(--accent)] hover:underline disabled:opacity-50"
                                >
                                  {discovering === platform ? 'Discovering...' : 'Discover existing groups \u2192'}
                                </button>
                                {discoveredGroups.length > 0 && discovering === null && (
                                  <div className="flex flex-wrap gap-1">
                                    {discoveredGroups
                                      .filter(g => !surf.allowedGroups.includes(g.id))
                                      .map(g => (
                                        <button
                                          key={g.id}
                                          onClick={() => {
                                            updateSurfaceSetting(platform, 'allowedGroups', [...surf.allowedGroups, g.id])
                                            setDiscoveredGroups(prev => prev.filter(x => x.id !== g.id))
                                          }}
                                          className="text-xs px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20"
                                        >
                                          + {g.name}
                                        </button>
                                      ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Paired users (dynamic approvals) */}
                          {platformPairedUsers.length > 0 && (
                            <div className="space-y-2 pt-2 border-t border-[var(--border)]">
                              <div className="flex items-center gap-2">
                                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="text-xs font-medium text-muted-foreground">Dynamically paired users</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {platformPairedUsers.map(u => (
                                  <span
                                    key={u.userId}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                                  >
                                    {u.userName || u.userId}
                                    <button
                                      onClick={() => revokePairing(platform, u.userId)}
                                      className="hover:text-red-500 transition-colors"
                                      title="Revoke access"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                These users were approved via pairing. Click x to revoke.
                              </p>
                            </div>
                          )}

                          {/* Signal Registration Lock */}
                          {platform === 'signal' && s.config.phone && (
                            <div className="pt-2 border-t border-[var(--border)]">
                              <SignalPinManager
                                phone={s.config.phone}
                                harnessId={id}
                                status={(pinStatus[s.config.phone] as 'locked' | 'expired' | 'not-set') || 'not-set'}
                                onStatusChange={() => {
                                  fetch('/api/surfaces/signal')
                                    .then(r => r.json())
                                    .then(data => { if (data.pinStatus) setPinStatus(data.pinStatus) })
                                    .catch(() => {})
                                }}
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Other surfaces (grayed out) */}
            {otherSurfaces.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Available</h3>
                {otherSurfaces.map((s) => (
                  <div key={s.id} className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] opacity-60 hover:opacity-100 transition-opacity">
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground">
                        {PLATFORM_ICONS[s.platform.toLowerCase()] ?? <Globe className="h-4 w-4" />}
                      </span>
                      <div>
                        <p className="font-medium text-sm">{s.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{s.platform}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setConnectDialog(s.platform.toLowerCase())}
                      className="text-xs px-2 py-1 rounded-md border border-[var(--accent)] text-[var(--accent)] opacity-100 hover:bg-[var(--accent)] hover:text-white transition-colors"
                    >
                      Connect
                    </button>
                  </div>
                ))}
              </div>
            )}

            {connectedSurfaces.length === 0 && otherSurfaces.length === 0 && (
              <p className="text-sm text-muted-foreground">No surfaces found.</p>
            )}

            {/* Save + Restart buttons */}
            {(settingsDirty || settingsSaved) && (
              <div className="flex justify-end gap-2">
                {settingsDirty && (
                  <button
                    onClick={handleSettingsSave}
                    disabled={settingsSaving}
                    className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {settingsSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save Settings
                  </button>
                )}
                {settingsSaved && !settingsDirty && (
                  <button
                    onClick={handleSettingsRestart}
                    disabled={settingsRestarting}
                    className="flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50"
                  >
                    {settingsRestarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                    Restart to apply
                  </button>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="tools" className="mt-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="w-12 px-4 py-3">On</th>
                  <th className="text-left px-4 py-3">Tool</th>
                  <th className="text-left px-4 py-3">Source</th>
                  <th className="text-left px-4 py-3">Risk</th>
                  <th className="text-left px-4 py-3">Tiers</th>
                  <th className="text-left px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {allTools.map((t) => {
                  const enabled = allToolsEnabled || harness.tools.includes(t.id)
                  const tierAllowed = t.allowedTiers.includes(harness.tier)
                  return (
                    <tr key={t.id} className={`border-b border-[var(--border)] last:border-0 ${!tierAllowed ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3">
                        <Switch
                          checked={enabled}
                          onCheckedChange={(checked) => toggleTool(t.id, checked)}
                          disabled={toolsSaving || !tierAllowed}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{t.name}</div>
                        <div className="text-xs text-muted-foreground">{t.description}</div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{t.source}</td>
                      <td className="px-4 py-3"><RiskBar level={t.risk} /></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {t.allowedTiers.map((tier) => (
                            <span key={tier} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {TIER_LABELS[tier]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[var(--success)]">✓</span>
                      </td>
                    </tr>
                  )
                })}
                {allTools.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground text-sm">No tools discovered.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="keys" className="mt-4">
          <div className="space-y-3">
            {/* Action buttons */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddKey(!showAddKey)}
              >
                + Add Key
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAssignKey(!showAssignKey)}
              >
                Assign Existing
              </Button>
            </div>

            {/* Add new key form */}
            {showAddKey && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
                <h4 className="text-sm font-medium">Add New Key</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground">Provider</label>
                    <select
                      value={newKeyProvider}
                      onChange={(e) => {
                        setNewKeyProvider(e.target.value)
                        if (e.target.value !== 'custom') setNewKeyEnvVar('')
                      }}
                      className="w-full mt-1 text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--surface)]"
                    >
                      <option value="">Select provider...</option>
                      {providerOptions(newKeyProvider).map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">Budget ($/mo)</label>
                    <input
                      type="number"
                      value={newKeyBudget}
                      onChange={(e) => setNewKeyBudget(e.target.value)}
                      placeholder="Optional"
                      className="w-full mt-1 text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--surface)]"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Name (optional)</label>
                  <input
                    type="text"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g. hermes-cryptids"
                    className="w-full mt-1 text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--surface)]"
                  />
                </div>
                {newKeyProvider === 'custom' && (
                  <div>
                    <label className="text-xs text-muted-foreground">Env var (optional)</label>
                    <input
                      type="text"
                      value={newKeyEnvVar}
                      onChange={(e) => setNewKeyEnvVar(e.target.value)}
                      placeholder="e.g. SANTIMENT_API_KEY — else derived from name"
                      className="w-full mt-1 text-sm font-mono border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--surface)]"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs text-muted-foreground">API Key</label>
                  <input
                    type="password" autoComplete="off"
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="sk-ant-..., secret_..., etc."
                    className="w-full mt-1 text-sm font-mono border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--surface)]"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={addKeyToHarness}
                    disabled={!newKeyProvider || !newKeyValue || keySaving}
                  >
                    {keySaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                    Add & Restart
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setShowAddKey(false); setNewKeyProvider(''); setNewKeyName(''); setNewKeyValue(''); setNewKeyBudget(''); setNewKeyEnvVar('') }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Assign existing key dropdown */}
            {showAssignKey && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
                <h4 className="text-sm font-medium">Assign Existing Key</h4>
                {(() => {
                  const unassigned = keys?.filter((k) => !k.assignedTo.includes(harness.id)) ?? []
                  if (unassigned.length === 0) {
                    return <p className="text-sm text-muted-foreground">No unassigned keys available.</p>
                  }
                  return (
                    <div className="space-y-2">
                      {unassigned.map((k) => (
                        <div key={k.id} className="flex items-center justify-between p-2 rounded border border-[var(--border)]">
                          <div>
                            <span className="text-sm font-medium">{k.provider}{k.name ? <span className="text-muted-foreground font-normal"> — {k.name}</span> : null}</span>
                            <span className="text-xs font-mono text-muted-foreground ml-2">{k.maskedValue}</span>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => assignExistingKey(k.id)} disabled={keySaving}>
                            Assign
                          </Button>
                        </div>
                      ))}
                    </div>
                  )
                })()}
                <Button variant="ghost" size="sm" onClick={() => setShowAssignKey(false)}>Cancel</Button>
              </div>
            )}

            {/* Current keys list */}
            {harnessKeys.map((k) => (
              <HarnessKeyRow key={k.id} keyData={k} harnessId={harness.id} harnessName={harness.name} onUpdate={() => { refetch(); refetchKeys() }} />
            ))}
            {harnessKeys.length === 0 && !showAddKey && !showAssignKey && (
              <p className="text-sm text-muted-foreground">No keys assigned.</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <select
                value={logLines}
                onChange={(e) => setLogLines(Number(e.target.value))}
                className="text-sm border border-[var(--border)] rounded-md px-2 py-1 bg-[var(--surface)]"
              >
                <option value={50}>50 lines</option>
                <option value={100}>100 lines</option>
                <option value={250}>250 lines</option>
              </select>
              <button
                onClick={() => refetchLogs()}
                disabled={logsLoading}
                className="text-sm px-3 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-muted disabled:opacity-50"
              >
                {logsLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-black/90 overflow-auto max-h-[500px]">
              <pre className="text-xs font-mono text-green-400 p-4 whitespace-pre-wrap">
                {logsData?.logs || (logsLoading ? 'Fetching logs…' : 'No logs available.')}
              </pre>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <SettingsTab harnessId={harness.id} connectedSurfaces={connectedSurfaces} />
        </TabsContent>
      </Tabs>

      {/* Runtime Info — collapsed from former Memory & Environment tabs */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 mt-6">
        <h3 className="font-medium text-sm text-muted-foreground">Runtime Info</h3>
        <div className="space-y-2">
          {harness.composeFile && <Row label="Compose file" value={harness.composeFile} mono />}
          {harness.serviceName && <Row label="Service name" value={harness.serviceName} mono />}
          {harnessMemory.length > 0 && harnessMemory.map((m) => (
            <div key={m.id} className="flex justify-between text-sm">
              <span className="text-muted-foreground">Memory: {m.name}</span>
              <span className="text-xs">
                <span className="mr-2">{m.strategy}</span>
                <span className="mr-2">{m.sizeMb.toFixed(1)} MB</span>
                <TierBadge tier={m.tier} />
              </span>
            </div>
          ))}
          {!harness.composeFile && !harness.serviceName && harnessMemory.length === 0 && (
            <p className="text-sm text-muted-foreground">No runtime info configured.</p>
          )}
        </div>
      </div>

      <SignalSetupDialog
        open={connectDialog === 'signal'}
        onClose={() => setConnectDialog(null)}
        harnessId={harness.id}
        harnessName={harness.name}
        onConnected={() => refetchSurfaces()}
      />
      <TelegramSetupDialog
        open={connectDialog === 'telegram'}
        onClose={() => setConnectDialog(null)}
        harnessId={harness.id}
        onConnected={() => refetchSurfaces()}
      />
      <MattermostSetupDialog
        open={connectDialog === 'mattermost'}
        onClose={() => setConnectDialog(null)}
        harnessId={harness.id}
        onConnected={() => refetchSurfaces()}
      />
      <DiscordSetupDialog
        open={connectDialog === 'discord'}
        onClose={() => setConnectDialog(null)}
        harnessId={harness.id}
        onConnected={() => refetchSurfaces()}
      />
      <SlackSetupDialog
        open={connectDialog === 'slack'}
        onClose={() => setConnectDialog(null)}
        harnessId={harness.id}
        onConnected={() => refetchSurfaces()}
      />
      {editSurface && (
        <EditSurfaceDialog
          platform={editSurface.platform}
          harnessId={harness.id}
          currentConfig={editSurface.config}
          open={!!editSurface}
          onClose={() => setEditSurface(null)}
          onSaved={() => refetchSurfaces()}
        />
      )}
    </div>
  )
}

function HarnessKeyRow({ keyData, harnessId, harnessName, onUpdate }: { keyData: Key; harnessId: string; harnessName: string; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false)
  const [budget, setBudget] = useState(keyData.budgetUsd != null ? String(keyData.budgetUsd) : '')
  const [name, setName] = useState(keyData.name ?? '')
  const [newValue, setNewValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function saveKey() {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        budgetUsd: budget ? parseFloat(budget) : null,
        name: name || undefined,
      }
      // If new value provided (min 8 chars to avoid accidental autofill), also rotate
      if (newValue && newValue.trim().length >= 8) payload.value = newValue.trim()

      const res = await fetch(`/api/keys/${keyData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Failed')
      toast.success(newValue ? 'Key rotated across all harnesses' : 'Key updated')
      setEditing(false)
      setNewValue('')
      onUpdate()
    } catch { toast.error('Failed to update key') }
    finally { setSaving(false) }
  }

  async function unassign() {
    setSaving(true)
    try {
      const newAssigned = keyData.assignedTo.filter((h) => h !== harnessId)
      const res = await fetch(`/api/keys/${keyData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedTo: newAssigned }),
      })
      if (!res.ok) throw new Error('Failed')
      // Never say "removed" for the non-destructive path — name the scope so the
      // operator knows the key survived (issue #191).
      const remaining = newAssigned.length
      toast.success(
        `${keyData.provider} key unassigned from ${harnessName}` +
        (remaining > 0
          ? ` — still assigned to ${remaining} other agent${remaining === 1 ? '' : 's'}`
          : ' — key kept, now assigned nowhere')
      )
      onUpdate()
    } catch { toast.error('Failed to unassign key') }
    finally { setSaving(false) }
  }

  async function deleteKey() {
    setSaving(true)
    const affected = keyData.assignedTo.length
    try {
      const res = await fetch(`/api/keys/${keyData.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
      toast.success(`${keyData.provider} key deleted everywhere — secret destroyed, stripped from ${affected} agent${affected === 1 ? '' : 's'}`)
      onUpdate()
    } catch { toast.error('Failed to delete key') }
    finally { setSaving(false); setConfirmDelete(false) }
  }

  if (editing) {
    return (
      <div className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-sm">{keyData.provider}</p>
            <p className="text-xs font-mono text-muted-foreground">{keyData.maskedValue}</p>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground w-20">Name:</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional display name"
              className="flex-1 text-sm border border-[var(--border)] rounded px-2 py-1 bg-[var(--bg)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground w-20">New value:</label>
            <input
              type="password" autoComplete="off"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Paste new key to rotate (leave empty to keep current)"
              className="flex-1 text-sm font-mono border border-[var(--border)] rounded px-2 py-1 bg-[var(--bg)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground w-20" title="Informational only — not enforced">Budget (not enforced):</label>
            <input
              type="number"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="$/mo"
              className="w-24 text-sm border border-[var(--border)] rounded px-2 py-1 bg-[var(--bg)]"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={saveKey} disabled={saving}>
            {newValue ? 'Rotate & Save' : 'Save'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setNewValue('') }}>Cancel</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div>
        <p className="font-medium text-sm">{keyData.provider}{keyData.name ? <span className="text-muted-foreground font-normal"> — {keyData.name}</span> : null}</p>
        <p className="text-xs font-mono text-muted-foreground">{keyData.maskedValue}</p>
        {keyData.assignedTo.length > 1 && (
          <p className="text-xs text-[var(--warning)]">
            Shared with {keyData.assignedTo.length - 1} other agent{keyData.assignedTo.length === 2 ? '' : 's'}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {keyData.budgetUsd != null && (
          <span className="text-xs text-muted-foreground">${keyData.budgetUsd}/mo</span>
        )}
        <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
        {/* Unassign (safe, per-agent) and Delete (destructive, global) must be
            visually distinct — a bare X here read as "delete" (issue #191). */}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => unassign()}
          title="Detach from this agent only — the key survives and stays on any other agents"
          disabled={saving}
        >
          Unassign
        </Button>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-muted-foreground hover:text-[var(--destructive)] transition-colors"
            title="Destroy this key everywhere — not just this agent"
          >
            Delete
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs text-[var(--destructive)]">
              Destroys the secret, strips it from {keyData.assignedTo.length} agent{keyData.assignedTo.length === 1 ? '' : 's'}. Cannot be undone.
            </span>
            <Button size="xs" variant="destructive" onClick={deleteKey} disabled={saving}>
              Delete everywhere
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Cancel
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Row({ label, value, mono }: { label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
    </div>
  )
}
