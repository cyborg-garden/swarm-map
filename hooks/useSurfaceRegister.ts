// hooks/useSurfaceRegister.ts
'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { generateClientPin } from '@/components/surfaces/signal-pin-field'
import { SURFACES, type SurfaceSlug } from '@/lib/surfaces/registry'

export type SurfacePlatform = SurfaceSlug

/**
 * Where the captured connection should go.
 * - harness: existing Surfaces-tab behavior — call POST /api/harnesses/{id}/surfaces/connect inline.
 * - pending: wizard mode — no harness exists yet, so run harness-independent steps and
 *   hand the captured config to onCaptured instead of connecting.
 */
export type SurfaceTarget =
  | { kind: 'harness'; harnessId: string }
  | { kind: 'pending' }

/** Connection config shapes captured per platform (pending mode) / sent to connect (harness mode). */
export type SignalCapturedConfig = {
  phone: string
  url: string
  profileName?: string
  adminUser?: string
}
export type TelegramCapturedConfig = {
  token: string
  adminUser?: string
}
export type MattermostCapturedConfig = {
  url: string
  token: string
  adminUser?: string
}
export type DiscordCapturedConfig = {
  token: string
  adminUser?: string
}
export type SlackCapturedConfig = {
  botToken: string
  appToken: string
  adminUser?: string
}
export type CapturedConfig =
  | SignalCapturedConfig
  | TelegramCapturedConfig
  | MattermostCapturedConfig
  | DiscordCapturedConfig
  | SlackCapturedConfig

export type SurfaceStep =
  // signal
  | 'phone'
  | 'registering'
  | 'captcha'
  | 'verify'
  | 'profile'
  // telegram / mattermost
  | 'input'
  | 'verifying'
  | 'verified'
  | 'connecting'
  // terminal
  | 'done' // harness mode terminal (connect succeeded)
  | 'captured' // pending mode terminal (config captured)
  | 'error'

export type UseSurfaceRegisterOptions = {
  platform: SurfacePlatform
  target: SurfaceTarget
  /** Default display name (e.g. harness name) for signal profile. */
  defaultDisplayName?: string
  /** Called when a harness connect succeeds (harness mode only). */
  onConnected?: () => void
  /** Called with the captured config when pending mode reaches the captured step. */
  onCaptured?: (config: CapturedConfig) => void
}

const SIGNAL_DOCKER_URL = 'http://host.docker.internal:8080'

function initialStep(platform: SurfacePlatform): SurfaceStep {
  return platform === 'signal' ? 'phone' : 'input'
}

const SIGNAL = 'signal'

export function useSurfaceRegister(opts: UseSurfaceRegisterOptions) {
  const { platform, target, defaultDisplayName, onConnected, onCaptured } = opts
  const isPending = target.kind === 'pending'
  const harnessId = target.kind === 'harness' ? target.harnessId : undefined

  // Shared
  const [step, setStep] = useState<SurfaceStep>(() => initialStep(platform))
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [adminUser, setAdminUser] = useState('')

  // Signal-specific
  const [phone, setPhone] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [displayName, setDisplayName] = useState(defaultDisplayName || '')
  const [hasExistingNumber, setHasExistingNumber] = useState(false)
  const [daemonHealthy, setDaemonHealthy] = useState<boolean | null>(null)
  const [healthChecking, setHealthChecking] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [pin, setPin] = useState('')

  // Telegram / Mattermost / Discord-specific (token = bot token for all of these)
  const [token, setToken] = useState('')
  const [url, setUrl] = useState('')
  // Slack-specific: a second token (app-level xapp- token for Socket Mode)
  const [appToken, setAppToken] = useState('')
  const [botUsername, setBotUsername] = useState('')
  // Telegram-specific: true when BotFather Group Privacy is ON (getMe reports
  // can_read_all_group_messages: false) — the bot won't see regular group
  // messages. Non-blocking warning in the dialog; null = unknown/not checked.
  const [privacyModeOn, setPrivacyModeOn] = useState<boolean | null>(null)

  // ── Signal: daemon health + deploy ────────────────────────────────────────

  const checkHealth = useCallback(async () => {
    setHealthChecking(true)
    try {
      const res = await fetch('/api/surfaces/signal')
      const data = await res.json()
      setDaemonHealthy(data.healthy === true)
    } catch {
      setDaemonHealthy(false)
    } finally {
      setHealthChecking(false)
    }
  }, [])

  const deploy = useCallback(async () => {
    setDeploying(true)
    try {
      const res = await fetch('/api/surfaces/signal/deploy', { method: 'POST' })
      const data = await res.json()
      if (data.healthy) {
        setDaemonHealthy(true)
        toast.success('Signal daemon started')
      } else if (data.status === 'already_running') {
        setDaemonHealthy(true)
        toast.info('Signal daemon already running')
      } else {
        toast.error('Daemon started but health check failed — it may still be booting')
        setTimeout(checkHealth, 5000)
      }
    } catch {
      toast.error('Failed to deploy Signal daemon')
    } finally {
      setDeploying(false)
    }
  }, [checkHealth])

  // ── Shared captured-config builder ────────────────────────────────────────

  const buildConfig = useCallback((): CapturedConfig => {
    switch (platform) {
      case 'signal':
        return {
          phone,
          url: SIGNAL_DOCKER_URL,
          profileName: displayName || undefined,
          adminUser: adminUser || undefined,
        }
      case 'telegram':
        return {
          token: token.trim(),
          ...(adminUser.trim() ? { adminUser: adminUser.trim() } : {}),
        }
      case 'mattermost':
        return {
          url: url.trim(),
          token: token.trim(),
          ...(adminUser.trim() ? { adminUser: adminUser.trim() } : {}),
        }
      case 'discord':
        return {
          token: token.trim(),
          ...(adminUser.trim() ? { adminUser: adminUser.trim() } : {}),
        }
      case 'slack':
        return {
          botToken: token.trim(),
          appToken: appToken.trim(),
          ...(adminUser.trim() ? { adminUser: adminUser.trim() } : {}),
        }
    }
  }, [platform, phone, displayName, adminUser, token, url, appToken])

  /**
   * Persist the connection. In harness mode, POST to the connect route. In
   * pending mode, hand config to onCaptured and reach the 'captured' step
   * (no harness exists yet).
   */
  const connectSurface = useCallback(async (): Promise<boolean> => {
    const config = buildConfig()

    if (isPending) {
      onCaptured?.(config)
      setStep('captured')
      return true
    }

    const res = await fetch(`/api/harnesses/${harnessId}/surfaces/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, config }),
    })
    const data = await res.json()

    if (data.success) {
      setStep('done')
      toast.success(`${SURFACES[platform].label} connected`)
      if (data.warning) toast.warning(data.warning)
      onConnected?.()
      return true
    } else {
      setError(data.error || 'Failed to save config')
      return false
    }
  }, [buildConfig, isPending, onCaptured, harnessId, platform, onConnected])

  // ── Signal: register / verify / existing-number ───────────────────────────

  const register = useCallback(
    async (captcha?: string) => {
      setLoading(true)
      setError('')
      try {
        const res = await fetch('/api/surfaces/signal/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, captcha }),
        })
        const data = await res.json()

        if (data.success) {
          setStep('verify')
        } else if (data.needsCaptcha) {
          if (captcha) {
            setError(data.error || 'Captcha failed — try a new one')
            setCaptchaToken('')
          }
          setStep('captcha')
        } else {
          setError(data.error || 'Registration failed')
          setStep('error')
        }
      } catch {
        setError('Network error')
        setStep('error')
      } finally {
        setLoading(false)
      }
    },
    [phone]
  )

  const verifySignal = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/surfaces/signal/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: verifyCode, displayName, pin, harnessId }),
      })
      const data = await res.json()

      if (data.success) {
        await connectSurface()
      } else {
        setError(data.error || 'Verification failed')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [phone, verifyCode, displayName, pin, harnessId, connectSurface])

  const connectExistingNumber = useCallback(async () => {
    setLoading(true)
    setError('')

    // Set PIN on existing account (harness mode only — needs a real account context).
    if (pin) {
      try {
        const pinRes = await fetch('/api/surfaces/signal/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, pin, harnessId }),
        })
        const pinData = await pinRes.json()
        if (!pinData.success) {
          toast.warning(`Registration lock not set: ${pinData.error}`)
        }
      } catch {
        toast.warning('Could not set registration lock PIN')
      }
    }

    await connectSurface()
    setLoading(false)
  }, [pin, phone, harnessId, connectSurface])

  // ── Telegram / Mattermost: verify ─────────────────────────────────────────

  const verifyTelegram = useCallback(async () => {
    setLoading(true)
    setError('')
    setStep('verifying')
    try {
      const res = await fetch(`https://api.telegram.org/bot${token.trim()}/getMe`)
      const data = await res.json()
      if (data.ok) {
        setBotUsername(data.result.username || data.result.first_name || 'Bot')
        setPrivacyModeOn(data.result.can_read_all_group_messages === false)
        setStep('verified')
      } else {
        setError(data.description || 'Invalid bot token')
        setStep('input')
      }
    } catch {
      setError('Failed to reach Telegram API — check your network')
      setStep('input')
    } finally {
      setLoading(false)
    }
  }, [token])

  const verifyMattermost = useCallback(async () => {
    setLoading(true)
    setError('')
    setStep('verifying')
    try {
      const res = await fetch('/api/surfaces/mattermost/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), token: token.trim() }),
      })
      const data = await res.json()
      if (data.valid) {
        setBotUsername(data.username || 'Bot')
        setStep('verified')
      } else {
        setError(data.error || 'Invalid token or URL')
        setStep('input')
      }
    } catch {
      setError('Failed to verify — check your network')
      setStep('input')
    } finally {
      setLoading(false)
    }
  }, [url, token])

  const verifyDiscord = useCallback(async () => {
    setLoading(true)
    setError('')
    setStep('verifying')
    try {
      const res = await fetch('/api/surfaces/discord/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const data = await res.json()
      if (data.valid) {
        setBotUsername(data.username || 'Bot')
        setStep('verified')
      } else {
        setError(data.error || 'Invalid bot token')
        setStep('input')
      }
    } catch {
      setError('Failed to verify — check your network')
      setStep('input')
    } finally {
      setLoading(false)
    }
  }, [token])

  const verifySlack = useCallback(async () => {
    setLoading(true)
    setError('')
    setStep('verifying')
    try {
      // Validate the bot token via Slack auth.test (server-side). The app token
      // authenticates the websocket, not a REST call, so it's format-checked in
      // the dialog and only truly exercised at gateway connect time.
      const res = await fetch('/api/surfaces/slack/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      })
      const data = await res.json()
      if (data.valid) {
        setBotUsername(data.username || 'Bot')
        setStep('verified')
      } else {
        setError(data.error || 'Invalid bot token')
        setStep('input')
      }
    } catch {
      setError('Failed to verify — check your network')
      setStep('input')
    } finally {
      setLoading(false)
    }
  }, [token])

  // ── Telegram / Mattermost: connect ────────────────────────────────────────

  const connectMessaging = useCallback(async () => {
    setLoading(true)
    setError('')
    setStep('connecting')
    try {
      const ok = await connectSurface()
      if (!ok) setStep('verified')
    } catch {
      setError('Network error')
      setStep('verified')
    } finally {
      setLoading(false)
    }
  }, [connectSurface])

  // ── Unified dispatchers ───────────────────────────────────────────────────

  const verify = useCallback(async () => {
    if (platform === 'telegram') return verifyTelegram()
    if (platform === 'mattermost') return verifyMattermost()
    if (platform === 'discord') return verifyDiscord()
    if (platform === 'slack') return verifySlack()
    return verifySignal()
  }, [platform, verifyTelegram, verifyMattermost, verifyDiscord, verifySlack, verifySignal])

  /** Telegram/Mattermost connect (signal connects via verify/existing-number). */
  const connect = useCallback(async () => {
    return connectMessaging()
  }, [connectMessaging])

  // ── Reset (mirror dialog open/close reset semantics) ──────────────────────

  const reset = useCallback(() => {
    setStep(initialStep(platform))
    setError('')
    setLoading(false)
    setAdminUser('')
    // signal
    setPhone('')
    setCaptchaToken('')
    setVerifyCode('')
    setDisplayName(defaultDisplayName || '')
    setHasExistingNumber(false)
    setDaemonHealthy(null)
    setDeploying(false)
    setPin('')
    // messaging
    setToken('')
    setUrl('')
    setAppToken('')
    setBotUsername('')
    setPrivacyModeOn(null)
  }, [platform, defaultDisplayName])

  /**
   * Called when the host dialog opens. For signal, kicks off the daemon health
   * check and seeds a client PIN (mirrors the existing dialog's open effect).
   */
  const onOpen = useCallback(() => {
    if (platform === SIGNAL) {
      checkHealth()
      setPin(generateClientPin())
    }
  }, [platform, checkHealth])

  return {
    // state
    step,
    setStep,
    error,
    setError,
    loading,
    adminUser,
    setAdminUser,
    // signal state
    phone,
    setPhone,
    captchaToken,
    setCaptchaToken,
    verifyCode,
    setVerifyCode,
    displayName,
    setDisplayName,
    hasExistingNumber,
    setHasExistingNumber,
    daemonHealthy,
    healthChecking,
    deploying,
    pin,
    setPin,
    // messaging state
    token,
    setToken,
    url,
    setUrl,
    appToken,
    setAppToken,
    botUsername,
    privacyModeOn,
    // signal actions
    checkHealth,
    deploy,
    register,
    connectExistingNumber,
    // messaging + unified actions
    verify,
    connect,
    // lifecycle
    onOpen,
    reset,
    // meta
    isPending,
  }
}
