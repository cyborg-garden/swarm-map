/**
 * End-to-end check of the real login submit path: whatever `?next=` holds,
 * a successful sign-in must only navigate to a same-origin path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let nextParam: string | null = null
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nextParam === null ? '' : `next=${encodeURIComponent(nextParam)}`),
}))

import LoginPage from './page'

const ORIGIN = 'http://localhost:3000'
let assigned: string | undefined
const realLocation = window.location

beforeEach(() => {
  assigned = undefined
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      origin: ORIGIN,
      get href() { return `${ORIGIN}/login` },
      set href(v: string) { assigned = v },
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  vi.unstubAllGlobals()
})

async function signIn(next: string | null): Promise<string | undefined> {
  nextParam = next
  render(<LoginPage />)
  fireEvent.change(await screen.findByPlaceholderText('Operator token'), { target: { value: 't' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  await waitFor(() => expect(assigned).toBeDefined())
  return assigned
}

describe('login ?next= handling', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '/\t/evil.com',
    '/\n/evil.com',
    '/.//evil.com',
  ])('sends %j to / after sign-in', async (attack) => {
    expect(await signIn(attack)).toBe('/')
  })

  it('keeps a legit same-origin target', async () => {
    expect(await signIn('/agents/foo?x=1#h')).toBe('/agents/foo?x=1#h')
  })

  it('defaults to / with no next', async () => {
    expect(await signIn(null)).toBe('/')
  })
})
