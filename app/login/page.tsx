'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { safeNextPath } from '@/lib/auth/safe-next'

function LoginForm() {
  const searchParams = useSearchParams()
  const rawNext = searchParams.get('next')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        // Full navigation so the freshly-set cookie is sent on the next load.
        // Validated at navigation time: only same-origin paths, else `/`.
        window.location.href = safeNextPath(rawNext, window.location.origin)
        return
      }
      setError(res.status === 401 ? 'Invalid operator token.' : `Login failed (${res.status}).`)
    } catch {
      setError('Login request failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <h1 className="text-lg font-semibold">Operator sign-in</h1>
            <p className="text-sm text-muted-foreground">
              Enter the operator token to manage the swarm.
            </p>
          </div>
          <Input
            type="password"
            autoComplete="off"
            placeholder="Operator token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" disabled={submitting || !token}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
