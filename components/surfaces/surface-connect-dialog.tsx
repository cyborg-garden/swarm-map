// components/surfaces/surface-connect-dialog.tsx
'use client'

import { useRef, useEffect } from 'react'
import {
  Phone,
  MessageSquare,
  Hash,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Rocket,
} from 'lucide-react'
import { SignalPinField } from './signal-pin-field'
import {
  useSurfaceRegister,
  type SurfacePlatform,
  type SurfaceTarget,
  type CapturedConfig,
} from '@/hooks/useSurfaceRegister'

type Props = {
  platform: SurfacePlatform
  target: SurfaceTarget
  open: boolean
  onClose: () => void
  /** Default display name for signal (e.g. harness name). */
  harnessName?: string
  /** Called when a harness connect succeeds (harness mode). */
  onConnected?: () => void
  /** Called with captured config (pending/wizard mode). */
  onCaptured?: (config: CapturedConfig) => void
}

export function SurfaceConnectDialog({
  platform,
  target,
  open,
  onClose,
  harnessName,
  onConnected,
  onCaptured,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const s = useSurfaceRegister({
    platform,
    target,
    defaultDisplayName: harnessName,
    onConnected,
    onCaptured,
  })

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal()
      s.onOpen()
    } else {
      dialogRef.current?.close()
      s.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="backdrop:bg-black/50 rounded-xl border border-[var(--border)] bg-[var(--background)] p-6 w-full max-w-md shadow-xl"
    >
      {platform === 'signal' && <SignalBody s={s} onClose={onClose} />}
      {platform === 'telegram' && <TelegramBody s={s} onClose={onClose} />}
      {platform === 'mattermost' && <MattermostBody s={s} onClose={onClose} />}
      {platform === 'discord' && <DiscordBody s={s} onClose={onClose} />}
      {platform === 'slack' && <SlackBody s={s} onClose={onClose} />}
    </dialog>
  )
}

type Hook = ReturnType<typeof useSurfaceRegister>

// ── Signal ────────────────────────────────────────────────────────────────

function SignalBody({ s, onClose }: { s: Hook; onClose: () => void }) {
  const { step, error, loading } = s
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Phone className="h-5 w-5 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold">Connect Signal</h2>
      </div>

      {/* DAEMON HEALTH CHECK */}
      {step === 'phone' && s.daemonHealthy === null && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Checking Signal daemon...</span>
        </div>
      )}

      {step === 'phone' && s.daemonHealthy === false && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/20">
            <AlertTriangle className="h-5 w-5 text-[var(--warning)] shrink-0 mt-0.5" />
            <div className="space-y-2 text-sm">
              <p className="font-medium">Signal daemon not detected</p>
              <p className="text-muted-foreground">
                HSM connects to Signal via signal-cli-rest-api running as a Docker container.
              </p>
              <p className="text-muted-foreground">To start it manually:</p>
              <code className="block text-xs bg-[var(--surface)] rounded p-2 font-mono">
                cd ~/.hermes-swarm && docker compose -f docker-compose.signal.yml up -d
              </code>
              <p className="text-xs text-muted-foreground">
                If the deploy also wrote <code>docker-compose.signal.override.yml</code> there (your per-agent mounts), add <code>-f docker-compose.signal.override.yml</code>.
                If you don&apos;t have the compose file yet, run the setup from <code>infra/signal-cli/</code> in the HSM repository.
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={s.checkHealth}
              disabled={s.healthChecking}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted inline-flex items-center gap-1.5"
            >
              {s.healthChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Check again
            </button>
            <button
              onClick={s.deploy}
              disabled={s.deploying}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {s.deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              Deploy automatically
            </button>
          </div>
        </div>
      )}

      {/* PHONE STEP */}
      {step === 'phone' && s.daemonHealthy === true && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.hasExistingNumber}
                onChange={(e) => s.setHasExistingNumber(e.target.checked)}
                className="rounded"
              />
              I already have a registered Signal number
            </label>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Phone Number (E.164)</label>
            <input
              type="text"
              value={s.phone}
              onChange={(e) => s.setPhone(e.target.value)}
              placeholder="+15551234567"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Admin User (optional)</label>
            <input
              type="text"
              value={s.adminUser}
              onChange={(e) => s.setAdminUser(e.target.value)}
              placeholder="+15559876543"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Phone number in E.164 format. If set, only this user can DM the agent.
            </p>
          </div>
          {s.hasExistingNumber && (
            <>
              <div className="space-y-1">
                <label className="text-sm font-medium">Bot Display Name</label>
                <input
                  type="text"
                  value={s.displayName}
                  onChange={(e) => s.setDisplayName(e.target.value)}
                  placeholder="Signal profile name for this bot"
                  className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Sets the Signal profile name shown to contacts.
                </p>
              </div>
              <SignalPinField value={s.pin} onChange={s.setPin} disabled={loading} />
            </>
          )}
          {!s.hasExistingNumber && (
            <p className="text-xs text-muted-foreground">
              You&apos;ll need to receive an SMS to this number for verification.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => s.hasExistingNumber ? s.connectExistingNumber() : s.register()}
              disabled={!s.phone || loading}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : s.hasExistingNumber ? 'Connect' : 'Register'}
            </button>
          </div>
        </div>
      )}

      {/* REGISTERING (loading) */}
      {step === 'registering' && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* CAPTCHA STEP */}
      {step === 'captcha' && (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/20 text-sm space-y-2">
            <p className="font-medium">Captcha required</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>
                <a href="https://signalcaptchas.org/registration/generate.html" target="_blank" rel="noopener"
                  className="text-[var(--accent)] underline inline-flex items-center gap-1">
                  Open captcha page <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>Solve the captcha</li>
              <li>Right-click &quot;Open Signal&quot; → Copy link address</li>
              <li>Paste the full URL below</li>
            </ol>
          </div>
          {error && (
            <p className="text-sm text-[var(--danger)] font-medium">{error}</p>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium">Captcha Token</label>
            <textarea
              value={s.captchaToken}
              onChange={(e) => s.setCaptchaToken(e.target.value)}
              placeholder="signalcaptcha://signal-hcaptcha..."
              rows={3}
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-xs font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => {
                // Strip signalcaptcha:// prefix — signal-cli expects the token without it
                const token = s.captchaToken.trim().replace(/^signalcaptcha:\/\//, '')
                s.register(token)
              }}
              disabled={!s.captchaToken || loading}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
            </button>
          </div>
        </div>
      )}

      {/* VERIFY STEP */}
      {step === 'verify' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A verification code was sent to <strong>{s.phone}</strong> via SMS.
          </p>
          <div className="space-y-1">
            <label className="text-sm font-medium">Verification Code</label>
            <input
              type="text"
              value={s.verifyCode}
              onChange={(e) => s.setVerifyCode(e.target.value)}
              placeholder="123456"
              maxLength={6}
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm font-mono text-center text-lg tracking-widest"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Display Name</label>
            <input
              type="text"
              value={s.displayName}
              onChange={(e) => s.setDisplayName(e.target.value)}
              placeholder="Signal profile name"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
            />
          </div>
          <SignalPinField value={s.pin} onChange={s.setPin} disabled={loading} />
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={s.verify}
              disabled={s.verifyCode.length < 6 || loading}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
            </button>
          </div>
        </div>
      )}

      {/* DONE STEP (harness) / CAPTURED STEP (wizard) */}
      {(step === 'done' || step === 'captured') && (
        <div className="space-y-4 text-center py-4">
          <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
          <p className="font-medium">{step === 'captured' ? 'Signal ready' : 'Signal connected!'}</p>
          <p className="text-sm text-muted-foreground">
            {step === 'captured'
              ? `${s.phone} will be linked when the agent is created.`
              : `${s.phone} is now linked to this agent.`}
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90"
          >
            Done
          </button>
        </div>
      )}

      {/* ERROR STEP */}
      {step === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/20">
            <XCircle className="h-5 w-5 text-[var(--danger)] shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => s.setStep('phone')}
              className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90"
            >
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Telegram ────────────────────────────────────────────────────────────────

function TelegramBody({ s, onClose }: { s: Hook; onClose: () => void }) {
  const { step, error, loading } = s
  const tokenValid = /^\d+:[A-Za-z0-9_-]+$/.test(s.token.trim())
  const isTerminal = step === 'done' || step === 'captured'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold">Connect Telegram</h2>
      </div>

      {!isTerminal ? (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-2">
            <p className="font-medium">Setup instructions:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Open Telegram and message <strong>@BotFather</strong></li>
              <li>Send <code>/newbot</code> and follow the prompts</li>
              <li>Copy the bot token (looks like <code>123456:ABC-DEF...</code>)</li>
            </ol>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Bot Token</label>
            <input
              type="text"
              value={s.token}
              onChange={(e) => { s.setToken(e.target.value); if (step === 'verified') s.setStep('input') }}
              placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-sm font-mono"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            {s.token && !tokenValid && (
              <p className="text-xs text-[var(--danger)]">Invalid token format (expected: number:alphanumeric)</p>
            )}
          </div>

          {step === 'verified' && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--success)]/10 border border-[var(--success)]/20">
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
              <span className="text-sm">Verified: <strong>@{s.botUsername}</strong></span>
            </div>
          )}

          {/* Non-blocking: with Group Privacy ON the bot still connects, it just
              won't see unaddressed group messages until privacy is disabled. */}
          {step !== 'input' && s.privacyModeOn === true && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/20">
              <AlertTriangle className="h-5 w-5 text-[var(--warning)] shrink-0 mt-0.5" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">Group Privacy is ON</p>
                <p className="text-muted-foreground">
                  The bot will not see regular group messages — only commands and @mentions.
                  To disable: message <strong>@BotFather</strong> &rarr; <code>/setprivacy</code> &rarr; <strong>Disable</strong>.
                </p>
                <p className="text-xs text-muted-foreground">
                  After changing it, the bot must be removed and re-added to any groups it is already in.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">Admins (optional)</label>
            <input
              type="text"
              value={s.adminUser}
              onChange={(e) => s.setAdminUser(e.target.value)}
              placeholder="123456789, @username"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            <p className="text-xs text-muted-foreground">
              Who can manage this bot. One or more entries, comma-separated — numeric
              Telegram user IDs or @usernames; @usernames are resolved to IDs automatically.
            </p>
          </div>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            {step === 'input' || step === 'verifying' ? (
              <button
                onClick={s.verify}
                disabled={!tokenValid || loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
              </button>
            ) : (
              <button
                onClick={s.connect}
                disabled={loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-center py-4">
          <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
          <p className="font-medium">{step === 'captured' ? 'Telegram ready' : 'Telegram connected!'}</p>
          {s.botUsername && <p className="text-sm text-muted-foreground">Bot: @{s.botUsername}</p>}
          <p className="text-sm text-muted-foreground">
            {step === 'captured' ? 'Will activate when the agent is created.' : 'Restart the agent to activate.'}
          </p>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90">
            Done
          </button>
        </div>
      )}
    </div>
  )
}

// ── Mattermost ──────────────────────────────────────────────────────────────

function MattermostBody({ s, onClose }: { s: Hook; onClose: () => void }) {
  const { step, error, loading } = s
  const urlValid = s.url.trim().startsWith('http')
  const formValid = urlValid && s.token.trim().length > 0
  const isTerminal = step === 'done' || step === 'captured'

  function handleFieldChange() {
    if (step === 'verified') s.setStep('input')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Hash className="h-5 w-5 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold">Connect Mattermost</h2>
      </div>

      {!isTerminal ? (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-2">
            <p className="font-medium">Setup instructions:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>In Mattermost, go to <strong>Integrations &rarr; Bot Accounts</strong></li>
              <li>Click <strong>Add Bot Account</strong> and configure it</li>
              <li>Copy the bot token after creation</li>
            </ol>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Server URL</label>
            <input
              type="url"
              value={s.url}
              onChange={(e) => { s.setUrl(e.target.value); handleFieldChange() }}
              placeholder="https://mattermost.example.com"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
              disabled={step === 'verifying' || step === 'connecting'}
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Bot Token</label>
            <input
              type="password"
              value={s.token}
              onChange={(e) => { s.setToken(e.target.value); handleFieldChange() }}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-sm font-mono"
              disabled={step === 'verifying' || step === 'connecting'}
            />
          </div>

          {step === 'verified' && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--success)]/10 border border-[var(--success)]/20">
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
              <span className="text-sm">Verified: <strong>{s.botUsername}</strong></span>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">Admin Username (optional)</label>
            <input
              type="text"
              value={s.adminUser}
              onChange={(e) => s.setAdminUser(e.target.value)}
              placeholder="Your Mattermost username"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            <p className="text-xs text-muted-foreground">
              Who can manage this bot.
            </p>
          </div>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            {step === 'input' || step === 'verifying' ? (
              <button
                onClick={s.verify}
                disabled={!formValid || loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
              </button>
            ) : (
              <button
                onClick={s.connect}
                disabled={loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-center py-4">
          <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
          <p className="font-medium">{step === 'captured' ? 'Mattermost ready' : 'Mattermost connected!'}</p>
          {s.botUsername && <p className="text-sm text-muted-foreground">Bot: {s.botUsername}</p>}
          <p className="text-sm text-muted-foreground">
            {step === 'captured' ? 'Will activate when the agent is created.' : 'Restart the agent to activate.'}
          </p>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90">
            Done
          </button>
        </div>
      )}
    </div>
  )
}

// ── Discord ──────────────────────────────────────────────────────────────────

function DiscordBody({ s, onClose }: { s: Hook; onClose: () => void }) {
  const { step, error, loading } = s
  // Discord bot tokens have no fixed shape (base64-ish, dot-separated) — just
  // require something non-trivial; the server-side /verify is the real check.
  const tokenValid = s.token.trim().length >= 20
  const isTerminal = step === 'done' || step === 'captured'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Hash className="h-5 w-5 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold">Connect Discord</h2>
      </div>

      {!isTerminal ? (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-2">
            <p className="font-medium">Setup instructions:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Open the <strong>Discord Developer Portal</strong> &rarr; <strong>Applications</strong></li>
              <li>Create an application, then add a <strong>Bot</strong></li>
              <li>Enable the <strong>Message Content</strong> privileged intent</li>
              <li>Copy the bot token and invite the bot to your server</li>
            </ol>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Bot Token</label>
            <input
              type="text"
              value={s.token}
              onChange={(e) => { s.setToken(e.target.value); if (step === 'verified') s.setStep('input') }}
              placeholder="MTAxxxxxxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-sm font-mono"
              disabled={step === 'verifying' || step === 'connecting'}
            />
          </div>

          {step === 'verified' && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--success)]/10 border border-[var(--success)]/20">
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
              <span className="text-sm">Verified: <strong>{s.botUsername}</strong></span>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">Admin (optional)</label>
            <input
              type="text"
              value={s.adminUser}
              onChange={(e) => s.setAdminUser(e.target.value)}
              placeholder="Your Discord user ID"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            <p className="text-xs text-muted-foreground">
              Who can manage this bot. Numeric Discord user ID.
            </p>
          </div>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            {step === 'input' || step === 'verifying' ? (
              <button
                onClick={s.verify}
                disabled={!tokenValid || loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
              </button>
            ) : (
              <button
                onClick={s.connect}
                disabled={loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-center py-4">
          <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
          <p className="font-medium">{step === 'captured' ? 'Discord ready' : 'Discord connected!'}</p>
          {s.botUsername && <p className="text-sm text-muted-foreground">Bot: {s.botUsername}</p>}
          <p className="text-sm text-muted-foreground">
            {step === 'captured' ? 'Will activate when the agent is created.' : 'Restart the agent to activate.'}
          </p>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90">
            Done
          </button>
        </div>
      )}
    </div>
  )
}

// ── Slack ─────────────────────────────────────────────────────────────────────

function SlackBody({ s, onClose }: { s: Hook; onClose: () => void }) {
  const { step, error, loading } = s
  // Slack needs two tokens: a bot token (xoxb-) for API calls and an app-level
  // token (xapp-) for the Socket Mode websocket. Verify checks the bot token via
  // auth.test; the app token is format-checked here (it only authenticates the
  // websocket, exercised at gateway connect time).
  const botValid = s.token.trim().startsWith('xoxb-')
  const appValid = s.appToken.trim().startsWith('xapp-')
  const formValid = botValid && appValid
  const isTerminal = step === 'done' || step === 'captured'

  function handleFieldChange() {
    if (step === 'verified') s.setStep('input')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-[var(--accent)]" />
        <h2 className="text-lg font-semibold">Connect Slack</h2>
      </div>

      {!isTerminal ? (
        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-muted/50 text-sm space-y-2">
            <p className="font-medium">Setup instructions:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Create a Slack app at <strong>api.slack.com/apps</strong></li>
              <li>Enable <strong>Socket Mode</strong> &rarr; generate an app-level token (<code>xapp-</code>) with <code>connections:write</code></li>
              <li>Add bot scopes (<code>app_mentions:read</code>, <code>chat:write</code>, <code>channels:history</code>, <code>im:history</code>)</li>
              <li>Install to the workspace and copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-</code>)</li>
            </ol>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Bot Token</label>
            <input
              type="text"
              value={s.token}
              onChange={(e) => { s.setToken(e.target.value); handleFieldChange() }}
              placeholder="xoxb-..."
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-sm font-mono"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            {s.token && !botValid && (
              <p className="text-xs text-[var(--danger)]">Bot tokens start with <code>xoxb-</code></p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">App Token</label>
            <input
              type="text"
              value={s.appToken}
              onChange={(e) => { s.setAppToken(e.target.value); handleFieldChange() }}
              placeholder="xapp-..."
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-base md:text-sm font-mono"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            {s.appToken && !appValid && (
              <p className="text-xs text-[var(--danger)]">App-level tokens start with <code>xapp-</code></p>
            )}
          </div>

          {step === 'verified' && (
            <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--success)]/10 border border-[var(--success)]/20">
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
              <span className="text-sm">Verified: <strong>{s.botUsername}</strong></span>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">Admin (optional)</label>
            <input
              type="text"
              value={s.adminUser}
              onChange={(e) => s.setAdminUser(e.target.value)}
              placeholder="Your Slack user ID (U...)"
              className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm"
              disabled={step === 'verifying' || step === 'connecting'}
            />
            <p className="text-xs text-muted-foreground">
              Who can manage this bot. Slack user ID (e.g. U01234567).
            </p>
          </div>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
              Cancel
            </button>
            {step === 'input' || step === 'verifying' ? (
              <button
                onClick={s.verify}
                disabled={!formValid || loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
              </button>
            ) : (
              <button
                onClick={s.connect}
                disabled={loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-center py-4">
          <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
          <p className="font-medium">{step === 'captured' ? 'Slack ready' : 'Slack connected!'}</p>
          {s.botUsername && <p className="text-sm text-muted-foreground">Bot: {s.botUsername}</p>}
          <p className="text-sm text-muted-foreground">
            {step === 'captured' ? 'Will activate when the agent is created.' : 'Restart the agent to activate.'}
          </p>
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90">
            Done
          </button>
        </div>
      )}
    </div>
  )
}
