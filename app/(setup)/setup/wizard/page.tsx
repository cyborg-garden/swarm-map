'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StepIndicator } from '@/components/wizard/step-indicator'
import { SurfaceConnectDialog } from '@/components/surfaces/surface-connect-dialog'
import type { SignalCapturedConfig, CapturedConfig } from '@/hooks/useSurfaceRegister'
import type { Key } from '@/lib/types'

const STEP_LABELS = ['Identity', 'Model', 'Platforms', 'Keys', 'Deploy']
const TOTAL_STEPS = 5

type UseCaseTemplateInfo = {
  id: string
  name: string
  description: string
  recommends?: {
    provider?: string
    primaryModel?: string
    fallbackModel?: string
    platforms?: string[]
    browser?: boolean
  }
}

type WizardState = {
  // Step 1
  name: string
  persona: string
  tier: string
  template: string
  runtime: 'hermes' | 'letta'
  // Step 2
  provider: string
  primaryModel: string
  fallbackModel: string
  bundledOllama: boolean
  // Step 2 (Letta): a single model handle, e.g. anthropic/claude-3-5-sonnet
  lettaModel: string
  // Step 3
  mattermostEnabled: boolean
  mattermostUrl: string
  mattermostToken: string
  telegramEnabled: boolean
  telegramToken: string
  discordEnabled: boolean
  discordToken: string
  slackEnabled: boolean
  slackBotToken: string
  slackAppToken: string
  signalEnabled: boolean
  signalPhone: string
  googleEnabled: boolean
  githubMcpEnabled: boolean
  notionEnabled: boolean
  notionKey: string
  browserEnabled: boolean
  // Step 4
  llmKey: string
  useExistingKey: boolean
  existingKeyId: string
  saveKeyToRegistry: boolean
  githubToken: string
  braveKey: string
}

const INITIAL_STATE: WizardState = {
  name: '',
  persona: '',
  tier: 'individual',
  template: '',
  runtime: 'hermes',
  provider: 'anthropic',
  primaryModel: '',
  fallbackModel: '',
  bundledOllama: false,
  lettaModel: '',
  mattermostEnabled: false,
  mattermostUrl: '',
  mattermostToken: '',
  telegramEnabled: false,
  telegramToken: '',
  discordEnabled: false,
  discordToken: '',
  slackEnabled: false,
  slackBotToken: '',
  slackAppToken: '',
  signalEnabled: false,
  signalPhone: '',
  googleEnabled: false,
  githubMcpEnabled: false,
  notionEnabled: false,
  notionKey: '',
  browserEnabled: false,
  llmKey: '',
  useExistingKey: false,
  existingKeyId: '',
  saveKeyToRegistry: false,
  githubToken: '',
  braveKey: '',
}

const TIER_OPTIONS = [
  { value: 'individual', label: 'Individual', desc: 'Personal agent' },
  { value: 'team', label: 'Team', desc: 'Shared with your team' },
  { value: 'org', label: 'Org', desc: 'Organization-wide' },
]

const PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'zai', label: 'Z.ai (GLM)' },
  { value: 'google', label: 'Google' },
  { value: 'bedrock', label: 'AWS Bedrock' },
]

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
  openrouter: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-6', 'openai/gpt-4o'],
  ollama: ['qwen2.5:0.5b', 'qwen3:8b', 'glm4:9b', 'qwen3:32b', 'llama3.3:70b'],
  zai: ['glm-5.2', 'glm-4.6', 'glm-4.5-flash'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  bedrock: ['anthropic.claude-sonnet-4-6-v1', 'anthropic.claude-haiku-4-5-v1'],
}

// Letta uses provider-independent model handles (provider/model). These map to
// the SERVER-WIDE provider key the Letta compose expects (anthropic → OPENAI etc.).
const LETTA_MODEL_SUGGESTIONS = [
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-3-5-sonnet',
  'openai/gpt-4o',
]

const PROVIDER_KEY_MAP: Record<string, string | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
  bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
  ollama: null,
  zai: 'GLM_API_KEY',
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm font-medium mb-1">{children}</label>
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>
}

export default function WizardPage() {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [state, setState] = useState<WizardState>(INITIAL_STATE)
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{ ok: boolean; error?: string; port?: number; healthy?: boolean; harnessId?: string; agentId?: string; runtime?: string } | null>(null)
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null)
  const [dockerChecking, setDockerChecking] = useState(true)
  const [availableKeys, setAvailableKeys] = useState<Key[]>([])
  const [templates, setTemplates] = useState<UseCaseTemplateInfo[]>([])
  const [signalDialogOpen, setSignalDialogOpen] = useState(false)
  const [signalCaptured, setSignalCaptured] = useState<SignalCapturedConfig | null>(null)
  const [signalConnectFailed, setSignalConnectFailed] = useState(false)

  async function checkDocker() {
    setDockerChecking(true)
    try {
      const res = await fetch('/api/health/docker')
      const data = await res.json()
      setDockerAvailable(data.available === true)
    } catch {
      setDockerAvailable(false)
    } finally {
      setDockerChecking(false)
    }
  }

  useEffect(() => {
    checkDocker()
    fetch('/api/keys')
      .then((res) => (res.ok ? res.json() : []))
      .then((keys: Key[]) => setAvailableKeys(Array.isArray(keys) ? keys : []))
      .catch(() => setAvailableKeys([]))
    fetch('/api/usecase-templates')
      .then((res) => (res.ok ? res.json() : []))
      .then((t: UseCaseTemplateInfo[]) => setTemplates(Array.isArray(t) ? t : []))
      .catch(() => setTemplates([]))
  }, [])

  // Select a use-case package: records the id and prefills the recommended
  // model/provider/browser so the following steps start from the template's
  // defaults (the user can still override). Empty id = "Base (blank)".
  function selectTemplate(id: string) {
    const t = templates.find((x) => x.id === id)
    if (!t) {
      update({ template: '' })
      return
    }
    const r = t.recommends ?? {}
    update({
      template: id,
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.primaryModel ? { primaryModel: r.primaryModel } : {}),
      ...(r.fallbackModel ? { fallbackModel: r.fallbackModel } : {}),
      ...(r.browser !== undefined ? { browserEnabled: r.browser } : {}),
    })
  }

  // Keys in the registry matching the selected provider — offered for reuse.
  const matchingKeys = availableKeys.filter((k) => k.provider === state.provider)

  function update(partial: Partial<WizardState>) {
    setState((prev) => ({ ...prev, ...partial }))
  }

  // Switching runtime must reset the Hermes-only state that would otherwise leak
  // into a Letta deploy payload: a stale `useExistingKey`/`existingKeyId` would
  // inject a Hermes registry key into the Letta server, and a captured Signal
  // registration would fire a bogus post-deploy connect against the
  // (non-container) Letta agent. Switching back to Hermes needs no reset — the
  // Letta-only `lettaModel` is never sent on a Hermes deploy.
  function selectRuntime(runtime: 'hermes' | 'letta') {
    if (runtime === 'letta') {
      setState((prev) => ({
        ...prev,
        runtime,
        // Hermes-only key selection
        useExistingKey: false,
        existingKeyId: '',
        // Hermes-only messaging surfaces (Letta has none in v1)
        mattermostEnabled: false,
        telegramEnabled: false,
        discordEnabled: false,
        slackEnabled: false,
        signalEnabled: false,
        googleEnabled: false,
        githubMcpEnabled: false,
        notionEnabled: false,
        browserEnabled: false,
        // Hermes-only template (Librarian packaging is Phase 5)
        template: '',
      }))
      // Drop any captured Signal registration so the post-deploy connect can't fire.
      setSignalCaptured(null)
      setSignalConnectFailed(false)
    } else {
      update({ runtime })
    }
  }

  const slug = slugify(state.name)

  const isLetta = state.runtime === 'letta'

  function canAdvance(): boolean {
    switch (step) {
      case 1: return state.name.trim().length > 0 && slug.length > 0
      case 2: return isLetta
        ? state.lettaModel.trim().length > 0
        : state.provider.length > 0 && state.primaryModel.trim().length > 0
      case 3: return true
      case 4: return true
      default: return false
    }
  }

  // The server-wide provider key var a Letta model handle implies (for the Keys step copy).
  const lettaKeyVar = state.lettaModel.startsWith('openai/')
    ? 'OPENAI_API_KEY'
    : state.lettaModel.startsWith('anthropic/')
      ? 'ANTHROPIC_API_KEY'
      : null

  async function handleDeploy() {
    setDeploying(true)
    setDeployResult(null)
    try {
      const res = await fetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: slug,
          runtime: state.runtime,
          // Letta: a single provider/model handle; the server-wide key rides llmKey below.
          lettaModel: isLetta ? state.lettaModel : undefined,
          provider: state.provider,
          primaryModel: state.primaryModel,
          fallbackModel: state.fallbackModel || undefined,
          template: state.template || undefined,
          bundledOllama: state.provider === 'ollama' ? state.bundledOllama : false,
          persona: state.persona,
          tier: state.tier,
          mattermostEnabled: state.mattermostEnabled,
          mattermostUrl: state.mattermostUrl,
          mattermostToken: state.mattermostToken,
          telegramEnabled: state.telegramEnabled,
          telegramToken: state.telegramToken,
          discordEnabled: state.discordEnabled,
          discordToken: state.discordToken,
          slackEnabled: state.slackEnabled,
          slackBotToken: state.slackBotToken,
          slackAppToken: state.slackAppToken,
          signalEnabled: state.signalEnabled,
          signalPhone: signalCaptured?.phone || state.signalPhone,
          googleEnabled: state.googleEnabled,
          githubMcpEnabled: state.githubMcpEnabled,
          notionEnabled: state.notionEnabled,
          notionKey: state.notionEnabled ? (state.notionKey || undefined) : undefined,
          // Key: reuse an existing registry key by id, or pass a new key (and
          // optionally persist it for reuse). The pasted value never includes a
          // resolved existing key — that resolution happens server-side. For
          // Letta the key is a server-wide provider key pasted directly; the
          // registry "use existing" path is Hermes-only, so never forward a
          // (possibly stale) existingKeyId on a Letta deploy.
          existingKeyId: !isLetta && state.useExistingKey ? state.existingKeyId || undefined : undefined,
          llmKey: isLetta ? (state.llmKey || undefined) : (state.useExistingKey ? undefined : (state.llmKey || undefined)),
          saveKeyToRegistry: !isLetta && !state.useExistingKey && state.saveKeyToRegistry,
          githubToken: state.githubToken || undefined,
          braveKey: state.braveKey || undefined,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        // Mark onboarded
        await fetch('/api/setup/complete', { method: 'POST' })
        // Deferred surface connect: Signal was registered in the wizard (pending
        // mode) before the harness existed — bind it now that we have an id.
        // Hermes-only: a Letta agent has no messaging surface and its harnessId
        // (h_letta_*) isn't a connectable Hermes overlay, so never fire this for
        // a Letta deploy even if stale Signal state somehow survived.
        if (data.runtime !== 'letta' && signalCaptured && data.harnessId) {
          try {
            const connectRes = await fetch(`/api/harnesses/${data.harnessId}/surfaces/connect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform: 'signal', config: signalCaptured }),
            })
            if (!connectRes.ok) setSignalConnectFailed(true)
          } catch {
            // Agent is up; connect can be retried from the Surfaces tab.
            setSignalConnectFailed(true)
          }
        }
      }
      setDeployResult(data)
    } catch (err) {
      setDeployResult({ ok: false, error: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setDeploying(false)
    }
  }

  const providerKeyVar = PROVIDER_KEY_MAP[state.provider]
  const suggestions = MODEL_SUGGESTIONS[state.provider] ?? []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <button
          onClick={() => router.push('/setup')}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to setup
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Create Your First Agent</h1>
      </div>

      {/* Step indicator */}
      <StepIndicator currentStep={step} totalSteps={TOTAL_STEPS} labels={STEP_LABELS} />

      {/* Step content */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">

        {/* Docker check gate */}
        {dockerAvailable === false && (
          <div className="space-y-4">
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-4 space-y-2">
              <p className="font-semibold text-destructive">Docker is required but not detected.</p>
              <p className="text-sm text-muted-foreground">
                Install Docker Desktop from{' '}
                <a href="https://docker.com/products/docker-desktop" target="_blank" rel="noopener" className="underline text-[var(--accent)]">
                  docker.com/products/docker-desktop
                </a>{' '}
                and make sure it&apos;s running before continuing.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={checkDocker}
              disabled={dockerChecking}
            >
              {dockerChecking ? 'Checking...' : 'Check again'}
            </Button>
          </div>
        )}

        {dockerChecking && dockerAvailable === null && (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">Checking Docker availability...</span>
          </div>
        )}

        {/* Step 1: Identity */}
        {dockerAvailable && step === 1 && (
          <Section>
            <div>
              <FieldLabel>Runtime</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className={`flex flex-col gap-1 p-3 rounded-lg border cursor-pointer transition-colors ${
                    !isLetta ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="runtime"
                      checked={!isLetta}
                      onChange={() => selectRuntime('hermes')}
                      className="accent-[var(--accent)]"
                    />
                    <span className="font-medium text-sm">Hermes agent</span>
                  </div>
                  <span className="text-xs text-muted-foreground">One container per agent. Messaging surfaces, per-agent keys, full lifecycle.</span>
                </label>
                <label
                  className={`flex flex-col gap-1 p-3 rounded-lg border cursor-pointer transition-colors ${
                    isLetta ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="runtime"
                      checked={isLetta}
                      onChange={() => selectRuntime('letta')}
                      className="accent-[var(--accent)]"
                    />
                    <span className="font-medium text-sm">Letta swarm</span>
                  </div>
                  <span className="text-xs text-muted-foreground">A memory-first agent on the shared Letta server — a row, not a container of its own. Read-only in Swarm Map after deploy, plus sending a message; messaging surfaces come later via a Hermes front.</span>
                </label>
              </div>
            </div>

            <div>
              <FieldLabel>Agent Name</FieldLabel>
              <Input
                value={state.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="e.g. My Assistant"
                autoFocus
              />
              {slug && (
                <p className="text-xs text-muted-foreground mt-1">
                  Slug: <span className="font-mono">{slug}</span>
                </p>
              )}
            </div>

            <div>
              <FieldLabel>Persona (optional)</FieldLabel>
              <textarea
                value={state.persona}
                onChange={(e) => update({ persona: e.target.value })}
                placeholder="Describe this agent's purpose and personality…"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div>
              <FieldLabel>Tier</FieldLabel>
              <div className="space-y-2">
                {TIER_OPTIONS.map((t) => (
                  <label
                    key={t.value}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      state.tier === t.value
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                        : 'border-[var(--border)] hover:bg-muted/30'
                    }`}
                  >
                    <input
                      type="radio"
                      name="tier"
                      value={t.value}
                      checked={state.tier === t.value}
                      onChange={() => update({ tier: t.value })}
                      className="accent-[var(--accent)]"
                    />
                    <div>
                      <div className="font-medium text-sm">{t.label}</div>
                      <div className="text-xs text-muted-foreground">{t.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {!isLetta && templates.length > 0 && (
              <div>
                <FieldLabel>Use-case package (optional)</FieldLabel>
                <p className="text-xs text-muted-foreground mb-2">
                  Start from an opinionated public package — it pre-fills the recommended model and installs its skills/tools (each scanned before install). You can still change everything in the next steps.
                </p>
                <div className="space-y-2">
                  <label
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      !state.template ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'
                    }`}
                  >
                    <input
                      type="radio"
                      name="template"
                      checked={!state.template}
                      onChange={() => selectTemplate('')}
                      className="accent-[var(--accent)] mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-sm">Base (blank agent)</div>
                      <div className="text-xs text-muted-foreground">A general-purpose agent with the default baseline plugins.</div>
                    </div>
                  </label>
                  {templates.map((t) => (
                    <label
                      key={t.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        state.template === t.id ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'
                      }`}
                    >
                      <input
                        type="radio"
                        name="template"
                        checked={state.template === t.id}
                        onChange={() => selectTemplate(t.id)}
                        className="accent-[var(--accent)] mt-0.5"
                      />
                      <div>
                        <div className="font-medium text-sm">{t.name}</div>
                        <div className="text-xs text-muted-foreground">{t.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </Section>
        )}

        {/* Step 2: Model — Letta (single handle) */}
        {dockerAvailable && step === 2 && isLetta && (
          <Section>
            <div>
              <FieldLabel>Model handle</FieldLabel>
              <Input
                value={state.lettaModel}
                onChange={(e) => update({ lettaModel: e.target.value })}
                placeholder="anthropic/claude-sonnet-4-5"
              />
              <p className="text-xs text-muted-foreground mt-1">
                A Letta <span className="font-mono">provider/model</span> handle. The provider key is configured once on the Letta server (next step), not per agent.
              </p>
              <div className="flex flex-wrap gap-1 mt-2">
                {LETTA_MODEL_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => update({ lettaModel: s })}
                    className="text-xs px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors font-mono"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg bg-muted/30 border border-[var(--border)] p-3">
              <p className="text-xs text-muted-foreground">
                Letta agents keep their memory in <span className="font-medium">core-memory blocks</span> on the shared server. Letta&apos;s git-backed memory files (<span className="font-medium">memfs</span>) are <span className="font-medium">not enabled</span> on this deploy path yet, so the context-files view will be empty. Letta agents also have no per-agent fallback model and no bundled Ollama — those are Hermes-only.
              </p>
            </div>
          </Section>
        )}

        {/* Step 2: Model — Hermes */}
        {dockerAvailable && step === 2 && !isLetta && (
          <Section>
            <div>
              <FieldLabel>Provider</FieldLabel>
              <select
                value={state.provider}
                onChange={(e) => update({ provider: e.target.value, primaryModel: '' })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PROVIDER_OPTIONS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {state.provider === 'ollama' && (
              <div>
                <FieldLabel>Ollama runtime</FieldLabel>
                <div className="space-y-2">
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${!state.bundledOllama ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'}`}>
                    <input
                      type="radio"
                      name="ollamaMode"
                      checked={!state.bundledOllama}
                      onChange={() => update({ bundledOllama: false })}
                      className="accent-[var(--accent)] mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-sm">Host GPU (recommended)</div>
                      <div className="text-xs text-muted-foreground">
                        Uses Ollama running on this machine (<code className="text-xs">host.docker.internal:11434</code>) — gets full GPU/Metal acceleration. Make sure Ollama is running and the model is pulled.
                      </div>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${state.bundledOllama ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)] hover:bg-muted/30'}`}>
                    <input
                      type="radio"
                      name="ollamaMode"
                      checked={state.bundledOllama}
                      onChange={() => update({ bundledOllama: true, primaryModel: state.primaryModel || 'qwen2.5:0.5b' })}
                      className="accent-[var(--accent)] mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-sm">Bundled tiny model (CPU, zero setup)</div>
                      <div className="text-xs text-muted-foreground">
                        Ships a small <code className="text-xs">qwen2.5:0.5b</code> model in a sidecar container, CPU-only. Works out of the box with no host setup — great for a first run.
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            <div>
              <FieldLabel>Primary Model</FieldLabel>
              <Input
                value={state.primaryModel}
                onChange={(e) => update({ primaryModel: e.target.value })}
                placeholder={suggestions[0] ?? 'model name'}
              />
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => update({ primaryModel: s })}
                      className="text-xs px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors font-mono"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <FieldLabel>Fallback Model (optional)</FieldLabel>
              <Input
                value={state.fallbackModel}
                onChange={(e) => update({ fallbackModel: e.target.value })}
                placeholder="Leave empty to skip"
              />
            </div>
          </Section>
        )}

        {/* Step 3: Platforms — Letta has no messaging surface in v1 */}
        {dockerAvailable && step === 3 && isLetta && (
          <Section>
            <div className="rounded-lg bg-muted/30 border border-[var(--border)] p-4 space-y-2">
              <p className="font-medium text-sm">No messaging surface for Letta agents (yet)</p>
              <p className="text-sm text-muted-foreground">
                A Letta agent is a stateful brain on the shared server — it&apos;s reached over REST, not Signal/Telegram/Slack directly. Multiplayer messaging arrives via a separate <span className="font-medium">Hermes front</span> that proxies a group conversation to this agent (v1 bridge). Nothing to configure here.
              </p>
              <p className="text-sm text-muted-foreground">
                Through that front, group approval and the audit trail carry over — they gate the turn before it runs. <span className="font-medium">Budget enforcement does not carry over at all.</span> The spend check sums the token columns an agent writes to its own state DB, and the Letta bridge never writes them, so proxied turns count as zero spend on every path. Do not rely on the front&apos;s budget cap to bound a Letta agent.
              </p>
            </div>
          </Section>
        )}

        {/* Step 3: Platforms — Hermes */}
        {dockerAvailable && step === 3 && !isLetta && (
          <Section>
            <p className="text-sm text-muted-foreground">
              Connect your agent to messaging platforms. You can skip this and configure later.
            </p>

            {/* Mattermost */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.mattermostEnabled}
                  onChange={(e) => update({ mattermostEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Mattermost</div>
                  <div className="text-xs text-muted-foreground">Connect to a Mattermost workspace</div>
                </div>
              </label>

              {state.mattermostEnabled && (
                <div className="space-y-2 pl-7">
                  <div>
                    <FieldLabel>Server URL</FieldLabel>
                    <Input
                      value={state.mattermostUrl}
                      onChange={(e) => update({ mattermostUrl: e.target.value })}
                      placeholder="https://mattermost.example.com"
                    />
                  </div>
                  <div>
                    <FieldLabel>Bot Token</FieldLabel>
                    <Input
                      type="password"
                      value={state.mattermostToken}
                      onChange={(e) => update({ mattermostToken: e.target.value })}
                      placeholder="your-bot-token"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Telegram */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.telegramEnabled}
                  onChange={(e) => update({ telegramEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Telegram</div>
                  <div className="text-xs text-muted-foreground">Connect via a Telegram bot token</div>
                </div>
              </label>

              {state.telegramEnabled && (
                <div className="pl-7">
                  <FieldLabel>Bot Token</FieldLabel>
                  <Input
                    type="password"
                    value={state.telegramToken}
                    onChange={(e) => update({ telegramToken: e.target.value })}
                    placeholder="123456:ABC-..."
                  />
                </div>
              )}
            </div>

            {/* Discord */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.discordEnabled}
                  onChange={(e) => update({ discordEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Discord</div>
                  <div className="text-xs text-muted-foreground">Connect via a Discord bot token</div>
                </div>
              </label>

              {state.discordEnabled && (
                <div className="pl-7">
                  <FieldLabel>Bot Token</FieldLabel>
                  <Input
                    type="password"
                    value={state.discordToken}
                    onChange={(e) => update({ discordToken: e.target.value })}
                    placeholder="MTAx...xxxx.xxxxxx.xxxx"
                  />
                </div>
              )}
            </div>

            {/* Slack */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.slackEnabled}
                  onChange={(e) => update({ slackEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Slack</div>
                  <div className="text-xs text-muted-foreground">Connect via Socket Mode (bot + app token)</div>
                </div>
              </label>

              {state.slackEnabled && (
                <div className="pl-7 space-y-2">
                  <div>
                    <FieldLabel>Bot Token</FieldLabel>
                    <Input
                      type="password"
                      value={state.slackBotToken}
                      onChange={(e) => update({ slackBotToken: e.target.value })}
                      placeholder="xoxb-..."
                    />
                  </div>
                  <div>
                    <FieldLabel>App Token</FieldLabel>
                    <Input
                      type="password"
                      value={state.slackAppToken}
                      onChange={(e) => update({ slackAppToken: e.target.value })}
                      placeholder="xapp-..."
                    />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    New Slack agents start locked down — approve channels in the agent&apos;s settings to activate, or the bot stays silent.
                  </div>
                </div>
              )}
            </div>

            {/* Signal */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.signalEnabled}
                  onChange={(e) => update({ signalEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Signal</div>
                  <div className="text-xs text-muted-foreground">Connect via a registered Signal number</div>
                </div>
              </label>

              {state.signalEnabled && (
                <div className="pl-7 space-y-2">
                  {signalCaptured ? (
                    <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm">
                      <p className="font-medium text-green-700 dark:text-green-400">
                        Signal registered: <span className="font-mono">{signalCaptured.phone}</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Will be connected to this agent automatically after deploy.
                      </p>
                      <button
                        type="button"
                        onClick={() => { setSignalCaptured(null); setSignalDialogOpen(true) }}
                        className="text-xs underline mt-1 hover:text-foreground"
                      >
                        Redo registration
                      </button>
                    </div>
                  ) : (
                    <>
                      <Button variant="outline" type="button" onClick={() => setSignalDialogOpen(true)}>
                        Register / connect a Signal number
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Runs the same registration as the harness Surfaces tab (register → verify → profile), including an “already have a registered number” option — enter the number once, in there.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Google Workspace */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.googleEnabled}
                  onChange={(e) => update({ googleEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Google Workspace</div>
                  <div className="text-xs text-muted-foreground">Calendar, Drive, Gmail via NimbleCo Google MCP (requires OAuth setup)</div>
                </div>
              </label>

              {state.googleEnabled && (
                <div className="pl-7">
                  <p className="text-xs text-muted-foreground">
                    Google Workspace integration uses OAuth for authentication. After deployment,
                    visit the agent&apos;s OAuth callback URL to complete setup.
                    See <a href="https://github.com/cyborg-garden/google-multiplayer-mcp" target="_blank" rel="noopener" className="underline">cyborg-garden/google-multiplayer-mcp</a> for setup.
                  </p>
                </div>
              )}
            </div>

            {/* GitHub */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.githubMcpEnabled}
                  onChange={(e) => update({ githubMcpEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">GitHub Tools</div>
                  <div className="text-xs text-muted-foreground">Repos, issues, PRs via official GitHub MCP server (requires GitHub token in Keys step)</div>
                </div>
              </label>

              {state.githubMcpEnabled && !state.githubToken && (
                <div className="pl-7">
                  <p className="text-xs text-amber-500">
                    Add a GitHub token in the Keys step for this to work. Fine-grained PATs are recommended for per-agent scoping.
                  </p>
                </div>
              )}
            </div>

            {/* Notion */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.notionEnabled}
                  onChange={(e) => update({ notionEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Notion</div>
                  <div className="text-xs text-muted-foreground">Pages, databases, search via official Notion MCP server (requires an integration token)</div>
                </div>
              </label>

              {state.notionEnabled && (
                <div className="pl-7 space-y-2">
                  <FieldLabel>Notion integration token</FieldLabel>
                  <Input
                    type="password"
                    value={state.notionKey}
                    onChange={(e) => update({ notionKey: e.target.value })}
                    placeholder="ntn_..."
                  />
                  <p className="text-xs text-muted-foreground">
                    Create an internal integration at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener" className="underline">notion.so/my-integrations</a> and share the pages it should access.
                  </p>
                </div>
              )}
            </div>

            {/* Browser (Camofox) */}
            <div className="rounded-lg border border-[var(--border)] p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.browserEnabled}
                  onChange={(e) => update({ browserEnabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                <div>
                  <div className="font-medium text-sm">Browser Tools</div>
                  <div className="text-xs text-muted-foreground">Web browsing via Camofox (requires Camofox container running on host)</div>
                </div>
              </label>

              {state.browserEnabled && (
                <div className="pl-7">
                  <p className="text-xs text-muted-foreground">
                    Requires a Camofox browser container on the host. Agent connects via <code className="text-xs">host.docker.internal:9377</code>.
                  </p>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Step 4: Keys — Letta (server-wide provider key) */}
        {dockerAvailable && step === 4 && isLetta && (
          <Section>
            {lettaKeyVar ? (
              <div>
                <FieldLabel>{lettaKeyVar} (Letta server key)</FieldLabel>
                <Input
                  type="password"
                  value={state.llmKey}
                  onChange={(e) => update({ llmKey: e.target.value })}
                  placeholder="Paste your provider API key"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Configured <span className="font-medium">once on the Letta server</span> (shared by every agent it hosts), stored in{' '}
                  <span className="font-mono">~/.hermes-swarm-map/letta/.env</span>. If the server is already running with a key, you can leave this blank.
                </p>
              </div>
            ) : (
              <div className="rounded-lg bg-muted/30 border border-[var(--border)] p-4">
                <p className="text-sm font-medium">Provider key set on the server</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Pick a model handle in the previous step to see which provider key the server needs. Anthropic and OpenAI handles are wired; others assume the key is already configured on the Letta server.
                </p>
              </div>
            )}
          </Section>
        )}

        {/* Step 4: Keys — Hermes */}
        {dockerAvailable && step === 4 && !isLetta && (
          <Section>
            {/* Required key */}
            {providerKeyVar ? (
              <div className="space-y-3">
                {matchingKeys.length > 0 && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => update({ useExistingKey: true, existingKeyId: state.existingKeyId || matchingKeys[0].id })}
                      className={`flex-1 text-sm px-3 py-2 rounded-md border transition-colors ${state.useExistingKey ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-foreground' : 'border-[var(--border)] text-muted-foreground hover:bg-muted/30'}`}
                    >
                      Use existing key
                    </button>
                    <button
                      type="button"
                      onClick={() => update({ useExistingKey: false })}
                      className={`flex-1 text-sm px-3 py-2 rounded-md border transition-colors ${!state.useExistingKey ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-foreground' : 'border-[var(--border)] text-muted-foreground hover:bg-muted/30'}`}
                    >
                      Enter new key
                    </button>
                  </div>
                )}

                {state.useExistingKey && matchingKeys.length > 0 ? (
                  <div>
                    <FieldLabel>Existing {state.provider} key</FieldLabel>
                    <select
                      value={state.existingKeyId}
                      onChange={(e) => update({ existingKeyId: e.target.value })}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <option value="">Select a key…</option>
                      {matchingKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {(k.name || k.provider)} · {k.maskedValue} · {k.health}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Reuses a key already configured on this machine. The value is applied server-side — never shown here or sent to the browser.
                    </p>
                  </div>
                ) : (
                  <div>
                    <FieldLabel>{providerKeyVar} (required for {state.provider})</FieldLabel>
                    <Input
                      type="password"
                      value={state.llmKey}
                      onChange={(e) => update({ llmKey: e.target.value })}
                      placeholder="Paste your API key"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Stored in <span className="font-mono">~/.hermes-{slug}/.env</span> — never leaves your machine.
                    </p>
                    <label className="flex items-center gap-2 mt-2 text-xs text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state.saveKeyToRegistry}
                        onChange={(e) => update({ saveKeyToRegistry: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      Save this key for reuse in future agents
                    </label>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg bg-muted/30 border border-[var(--border)] p-4">
                <p className="text-sm font-medium">Ollama runs locally</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {state.bundledOllama
                    ? 'Bundled mode — a tiny qwen2.5:0.5b model ships in a sidecar container. No API key or host setup needed.'
                    : 'Host GPU mode — no API key needed. Make sure Ollama is running on this machine and the model is pulled.'}
                </p>
              </div>
            )}

            {/* Optional keys */}
            <details className="group">
              <summary className="text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors list-none flex items-center gap-2">
                <svg className="w-3.5 h-3.5 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Optional integrations
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <FieldLabel>GitHub Token (optional)</FieldLabel>
                  <Input
                    type="password"
                    value={state.githubToken}
                    onChange={(e) => update({ githubToken: e.target.value })}
                    placeholder="ghp_..."
                  />
                </div>
                <div>
                  <FieldLabel>Brave Search API Key (optional)</FieldLabel>
                  <Input
                    type="password"
                    value={state.braveKey}
                    onChange={(e) => update({ braveKey: e.target.value })}
                    placeholder="BSA..."
                  />
                </div>
              </div>
            </details>
          </Section>
        )}

        {/* Step 5: Summary + Deploy */}
        {dockerAvailable && step === 5 && !deployResult && (
          <Section>
            <h3 className="font-semibold">Review &amp; Deploy</h3>

            <div className="rounded-lg bg-muted/30 border border-[var(--border)] p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Name</span>
                <span className="font-medium">{state.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Slug</span>
                <span className="font-mono">{slug}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Runtime</span>
                <span>{isLetta ? 'Letta swarm' : 'Hermes agent'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tier</span>
                <span>{state.tier}</span>
              </div>
              {isLetta ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model handle</span>
                  <span className="font-mono">{state.lettaModel}</span>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Provider</span>
                    <span>{state.provider}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Primary model</span>
                    <span className="font-mono">{state.primaryModel}</span>
                  </div>
                </>
              )}
              {!isLetta && state.fallbackModel && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fallback model</span>
                  <span className="font-mono">{state.fallbackModel}</span>
                </div>
              )}
              {state.mattermostEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mattermost</span>
                  <span>{state.mattermostUrl || 'configured'}</span>
                </div>
              )}
              {state.telegramEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Telegram</span>
                  <span>configured</span>
                </div>
              )}
              {state.slackEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Slack</span>
                  <span>configured</span>
                </div>
              )}
              {state.discordEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Discord</span>
                  <span>configured</span>
                </div>
              )}
              {state.signalEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Signal</span>
                  <span>{signalCaptured?.phone ?? (signalCaptured ? 'registered' : 'not registered')}</span>
                </div>
              )}
              {state.googleEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Google Workspace</span>
                  <span>enabled (OAuth setup after deploy)</span>
                </div>
              )}
              {state.githubMcpEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GitHub Tools</span>
                  <span>{state.githubToken ? 'enabled' : 'enabled (needs token)'}</span>
                </div>
              )}
              {state.notionEnabled && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Notion</span>
                  <span>{state.notionKey ? 'configured' : 'enabled (needs token)'}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">{isLetta ? 'Hosted on' : 'Data dir'}</span>
                <span className="font-mono">{isLetta ? 'Letta server (:8283)' : `~/.hermes-${slug}/`}</span>
              </div>
            </div>

            {state.persona && (
              <div className="rounded-lg border border-[var(--border)] p-3">
                <p className="text-xs text-muted-foreground mb-1">Persona</p>
                <p className="text-sm">{state.persona}</p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {isLetta ? (
                <>This will ensure the Letta server is running (<span className="font-mono">docker/letta-compose.yml</span>) and create the agent <span className="font-mono">{slug}</span> on it via the REST API.</>
              ) : (
                <>This will pull <span className="font-mono">ghcr.io/cyborg-garden/hermes-agent-mt:latest</span>, scaffold{' '}
                <span className="font-mono">~/.hermes-{slug}/</span>, and start the container.</>
              )}
            </p>
          </Section>
        )}

        {/* Deploy success */}
        {dockerAvailable && step === 5 && deployResult?.ok && (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-500/10 border border-green-500/30 p-4">
              <p className="font-semibold text-green-700 dark:text-green-400">Agent deployed!</p>
              {deployResult.runtime === 'letta' ? (
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-mono">{slug}</span> was created on the Letta server
                  {deployResult.agentId && <> (agent <span className="font-mono">{deployResult.agentId}</span>)</>}.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-mono">{slug}</span> is running on port{' '}
                  <span className="font-mono">{deployResult.port}</span>.{' '}
                  {deployResult.healthy ? 'Health check passed.' : 'Health check timed out — agent may still be starting.'}
                </p>
              )}
            </div>
            {signalConnectFailed && (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Signal was registered, but binding it to the agent didn&apos;t complete. Finish connecting it from the agent&apos;s <span className="font-medium">Surfaces</span> tab.
                </p>
              </div>
            )}
            <Button className="w-full" onClick={() => router.push('/')}>
              Go to Dashboard
            </Button>
          </div>
        )}

        {/* Deploy error */}
        {dockerAvailable && step === 5 && deployResult && !deployResult.ok && (
          <div className="space-y-4">
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-4">
              <p className="font-semibold text-destructive">Deployment failed</p>
              <p className="text-sm text-muted-foreground mt-1 font-mono">{deployResult.error}</p>
            </div>
            <Button variant="outline" className="w-full" onClick={() => setDeployResult(null)}>
              Try Again
            </Button>
          </div>
        )}
      </div>

      {/* Navigation */}
      {!(step === 5 && deployResult?.ok) && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            disabled={step === 1 || deploying}
          >
            Back
          </Button>

          {step < 5 ? (
            <Button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance()}
            >
              Continue
            </Button>
          ) : (
            !deployResult && (
              <Button
                onClick={handleDeploy}
                disabled={deploying}
              >
                {deploying ? 'Deploying...' : 'Deploy Agent'}
              </Button>
            )
          )}
        </div>
      )}

      {/* Signal registration (shared with the harness Surfaces tab) — pending mode:
          captures config now, connect happens after the harness is deployed. */}
      <SurfaceConnectDialog
        platform="signal"
        target={{ kind: 'pending' }}
        open={signalDialogOpen}
        onClose={() => setSignalDialogOpen(false)}
        harnessName={state.name || slug}
        onCaptured={(config: CapturedConfig) => {
          const c = config as SignalCapturedConfig
          setSignalCaptured(c)
          update({ signalEnabled: true, signalPhone: c.phone })
          setSignalDialogOpen(false)
        }}
      />
    </div>
  )
}
