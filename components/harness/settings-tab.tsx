// components/harness/settings-tab.tsx
'use client'

import { useState, useEffect } from 'react'
import { Shield, Loader2, Save, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { Surface } from '@/lib/types'
import { TuningCard } from './tuning-card'

type SurfaceSettings = {
  allowedUsers: string[]
  allowedGroups: string[]
  adminUsers: string[]
  allowAll: boolean
}

type Settings = {
  dmPolicy: 'approved-only' | 'allow-all'
  groupInvitePolicy: 'approved-only' | 'allow-all'
  mentionGating: boolean
  observeUnmentioned: boolean
  commandApprovalAdminOnly: boolean
  memoryScope: 'channel' | 'global'
  vpnEnabled: boolean
  capsolverConfigured: boolean
  resources?: { memory?: string; cpus?: string }
  surfaces: Record<string, SurfaceSettings>
  // Optimistic-concurrency token from GET; round-tripped in PUT.
  version?: string
  // Discord agents only (absent otherwise): @mention required inside threads.
  discordThreadMentionGating?: boolean
  discordThreadMentionSource?: string // read-only: which config layer decided it
}

type Props = {
  harnessId: string
  connectedSurfaces: Surface[]
}

export function SettingsTab({ harnessId, connectedSurfaces }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)

useEffect(() => {
    fetch(`/api/harnesses/${harnessId}/settings`)
      .then(res => res.json())
      .then(data => {
        if (!data.error) setSettings(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [harnessId])

function updateDmPolicy(policy: 'approved-only' | 'allow-all') {
    if (!settings) return
    setSettings({ ...settings, dmPolicy: policy })
    setDirty(true)
    setSaved(false)
  }

  function updateGroupInvitePolicy(policy: 'approved-only' | 'allow-all') {
    if (!settings) return
    setSettings({ ...settings, groupInvitePolicy: policy })
    setDirty(true)
    setSaved(false)
  }

  function updateMentionGating(enabled: boolean) {
    if (!settings) return
    setSettings({ ...settings, mentionGating: enabled })
    setDirty(true)
    setSaved(false)
  }

  function updateThreadMentionGating(enabled: boolean) {
    if (!settings) return
    setSettings({ ...settings, discordThreadMentionGating: enabled })
    setDirty(true)
    setSaved(false)
  }

  function updateObserveUnmentioned(enabled: boolean) {
    if (!settings) return
    setSettings({ ...settings, observeUnmentioned: enabled })
    setDirty(true)
    setSaved(false)
  }

  function updateCommandApproval(adminOnly: boolean) {
    if (!settings) return
    setSettings({ ...settings, commandApprovalAdminOnly: adminOnly })
    setDirty(true)
    setSaved(false)
  }

  function updateMemoryScope(scope: 'channel' | 'global') {
    if (!settings) return
    setSettings({ ...settings, memoryScope: scope })
    setDirty(true)
    setSaved(false)
  }

  function updateVpnEnabled(enabled: boolean) {
    if (!settings) return
    setSettings({ ...settings, vpnEnabled: enabled })
    setDirty(true)
    setSaved(false)
  }

  function updateResources(field: 'memory' | 'cpus', value: string) {
    if (!settings) return
    const trimmed = value.trim()
    const next = { ...(settings.resources ?? {}), [field]: trimmed || undefined }
    setSettings({ ...settings, resources: next })
    setDirty(true)
    setSaved(false)
  }

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    try {
      // Policy-only PUT: this tab has no surface controls, so it must not send
      // `surfaces` at all. Sending the whole document made a save here silently
      // revert any allowlist edit made in the Surfaces tab since this tab's
      // GET — the two tabs mount together and each held its own stale copy.
      // An omitted platform is preserved verbatim by the PUT handler.
      const { surfaces: _omitted, capsolverConfigured: _ro, discordThreadMentionSource: _src, ...policyOnly } = settings
      const res = await fetch(`/api/harnesses/${harnessId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policyOnly),
      })
      const data = await res.json()
      if (res.status === 409) {
        toast.error(data.error || 'Settings changed since you loaded them — reloaded, re-apply your edit.')
        const fresh = await fetch(`/api/harnesses/${harnessId}/settings`).then(r => r.json()).catch(() => null)
        if (fresh && !fresh.error) {
          setSettings(fresh)
          setDirty(false)
        }
      } else if (data.success) {
        setDirty(false)
        if (data.version) {
          setSettings(prev => (prev ? { ...prev, version: data.version } : prev))
        }
        // The PUT handler already recreated the container when anything
        // requiring it changed (restarted:true) — a second POST /restart here
        // hit the recreate's lock, returned 409, and surfaced as "restart
        // failed — restart manually".
        if (data.restarted) {
          toast.success('Settings saved. Agent restarting...')
          setSaved(false)
        } else {
          toast.success(data.unchanged ? 'No changes — agent left running.' : 'Settings saved')
          // A no-op save needs no "restart to apply" affordance.
          setSaved(!data.unchanged)
        }
      } else {
        toast.error(data.error || 'Failed to save')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestart() {
    setRestarting(true)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'rebuild' }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Harness restarted')
        setSaved(false)
      } else {
        toast.error(data.error || 'Restart failed')
      }
    } catch {
      toast.error('Restart failed')
    } finally {
      setRestarting(false)
    }
  }

if (loading) {
    return <p className="text-sm text-muted-foreground">Loading settings...</p>
  }

  if (!settings) {
    return <p className="text-sm text-muted-foreground">No .env found for this harness.</p>
  }

  return (
    <div className="space-y-6">
      {/* DM Policy */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">DM Access Policy</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="dmPolicy"
              checked={settings.dmPolicy === 'approved-only'}
              onChange={() => updateDmPolicy('approved-only')}
              className="accent-[var(--accent)]"
            />
            Approved users only
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="dmPolicy"
              checked={settings.dmPolicy === 'allow-all'}
              onChange={() => updateDmPolicy('allow-all')}
              className="accent-[var(--accent)]"
            />
            Allow all
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.dmPolicy === 'approved-only'
            ? 'Only users in the approved list below can DM this agent.'
            : 'Anyone can DM this agent. Approved users list still controls who can add this agent to groups.'}
        </p>
      </div>

      {/* Group Invite Policy */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Group Invite Policy</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="groupInvitePolicy"
              checked={settings.groupInvitePolicy === 'approved-only'}
              onChange={() => updateGroupInvitePolicy('approved-only')}
              className="accent-[var(--accent)]"
            />
            Approved users only
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="groupInvitePolicy"
              checked={settings.groupInvitePolicy === 'allow-all'}
              onChange={() => updateGroupInvitePolicy('allow-all')}
              className="accent-[var(--accent)]"
            />
            Allow all
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.groupInvitePolicy === 'approved-only'
            ? 'Only approved users can add this agent to groups. On Slack, the agent responds only in approved channels.'
            : 'Anyone can add this agent to groups. On Slack, the agent responds in every channel.'}
        </p>
      </div>

      {/* Mention-Gating */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Group Mention-Gating</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="mentionGating"
              checked={settings.mentionGating === true}
              onChange={() => updateMentionGating(true)}
              className="accent-[var(--accent)]"
            />
            Require @mention
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="mentionGating"
              checked={settings.mentionGating === false}
              onChange={() => updateMentionGating(false)}
              className="accent-[var(--accent)]"
            />
            Respond to all messages
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.mentionGating
            ? 'Agent only responds when @mentioned, replied to, or a /command is used in groups.'
            : 'Agent responds to all messages in approved groups.'}
        </p>
      </div>

      {/* Discord thread mention-gating — only for agents with a Discord surface */}
      {settings.discordThreadMentionGating !== undefined && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">Discord Threads</h3>
          </div>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="discordThreadMentionGating"
                checked={settings.discordThreadMentionGating === true}
                onChange={() => updateThreadMentionGating(true)}
                className="accent-[var(--accent)]"
              />
              Require @mention in threads
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="discordThreadMentionGating"
                checked={settings.discordThreadMentionGating === false}
                onChange={() => updateThreadMentionGating(false)}
                className="accent-[var(--accent)]"
              />
              Answer everything in threads it joined
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {settings.discordThreadMentionGating
              ? 'Agent needs an @mention inside threads too (fleet default).'
              : 'Once the agent has joined a thread it answers every message there, mentioned or not. Add it to the opt-out list in global settings, or the posture check will flag it.'}
          </p>
          {settings.discordThreadMentionSource === 'platforms.discord.extra' && (
            <p className="text-xs text-[var(--warning)]">
              config.yaml sets platforms.discord.extra.thread_require_mention, which overrides this setting. Remove it there for this toggle to take effect.
            </p>
          )}
        </div>
      )}

      {/* Observe-Unmentioned */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Observe Unmentioned Messages</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="observeUnmentioned"
              checked={settings.observeUnmentioned === true}
              onChange={() => updateObserveUnmentioned(true)}
              className="accent-[var(--accent)]"
            />
            Observe (read context)
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="observeUnmentioned"
              checked={settings.observeUnmentioned === false}
              onChange={() => updateObserveUnmentioned(false)}
              className="accent-[var(--accent)]"
            />
            Ignore
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.observeUnmentioned
            ? 'Agent reads group messages it isn’t addressed in for context — it still only responds per the mention-gating setting above. Independent of whether it replies.'
            : 'Messages that don’t address the agent are dropped entirely (not even read for context).'}
        </p>
      </div>

      {/* Command Approval */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Command Approval</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="commandApproval"
              checked={settings.commandApprovalAdminOnly === true}
              onChange={() => updateCommandApproval(true)}
              className="accent-[var(--accent)]"
            />
            Admins only
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="commandApproval"
              checked={settings.commandApprovalAdminOnly === false}
              onChange={() => updateCommandApproval(false)}
              className="accent-[var(--accent)]"
            />
            Any user
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.commandApprovalAdminOnly
            ? 'Only admin users can /approve or /deny dangerous commands.'
            : 'Any user can approve or deny commands. Use with caution.'}
        </p>
      </div>

      {/* Memory Scope */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Memory Scope (Groups)</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="memoryScope"
              checked={settings.memoryScope === 'channel'}
              onChange={() => updateMemoryScope('channel')}
              className="accent-[var(--accent)]"
            />
            Per-channel
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="memoryScope"
              checked={settings.memoryScope === 'global'}
              onChange={() => updateMemoryScope('global')}
              className="accent-[var(--accent)]"
            />
            Global
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.memoryScope === 'channel'
            ? 'Memory writes in groups are scoped to that channel. Users can\'t see memories from other groups. Admins can use scope="global" explicitly.'
            : 'All memory is shared globally across channels. Any user in any group can read/write the same memory pool.'}
        </p>
      </div>

      {/* Memory length, turn budget, compression (config.yaml) */}
      <TuningCard harnessId={harnessId} />

      {/* VPN (WireGuard Sidecar) */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">VPN (WireGuard Sidecar)</h3>
        </div>
        <div className="flex gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="vpnEnabled"
              checked={settings.vpnEnabled === true}
              onChange={() => updateVpnEnabled(true)}
              className="accent-[var(--accent)]"
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="vpnEnabled"
              checked={settings.vpnEnabled === false}
              onChange={() => updateVpnEnabled(false)}
              className="accent-[var(--accent)]"
            />
            Disabled
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.vpnEnabled
            ? 'Browser traffic is routed through a WireGuard VPN sidecar. Requires a WireGuard config in the agent data directory.'
            : 'Browser traffic uses the host network directly.'}
        </p>
        {settings.capsolverConfigured && (
          <p className="text-xs text-green-500">CapSolver API key configured — automatic CAPTCHA solving enabled.</p>
        )}
      </div>

      {/* Resource Limits (memory / cpu) */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Resource Limits</h3>
        </div>
        <div className="flex gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Memory</span>
            <input
              type="text"
              value={settings.resources?.memory ?? ''}
              placeholder="2G"
              onChange={(e) => updateResources('memory', e.target.value)}
              className="w-28 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">CPUs</span>
            <input
              type="text"
              value={settings.resources?.cpus ?? ''}
              placeholder="2.0"
              onChange={(e) => updateResources('cpus', e.target.value)}
              className="w-28 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Docker compose limits for this agent&apos;s container (e.g. memory <code>6G</code>, CPUs <code>4.0</code>).
          Defaults to 2G / 2.0 when blank. Memory-heavy agents OOM-kill under the default — raise memory to fit the job.
          Saving regenerates the compose and recreates the container (in-progress context persists via the data-dir mount).
        </p>
      </div>

      {/* Admin note */}
      <p className="text-xs text-muted-foreground px-1">
        Admin users are managed per-surface in the Surfaces tab.
      </p>


      {/* Save + Restart buttons */}
      {(dirty || saved) && (
        <div className="flex justify-end gap-2">
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Settings
            </button>
          )}
          {saved && !dirty && (
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50"
            >
              {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              Restart to apply
            </button>
          )}
        </div>
      )}
    </div>
  )
}
