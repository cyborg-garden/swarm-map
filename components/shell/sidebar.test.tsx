/**
 * The nav only offers pages that exist. Each entry is checked against the
 * dashboard's route folders, so a link to a placeholder or a deleted page
 * fails here.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { render, screen } from '@testing-library/react'
import { Sidebar, MobileNav, NAV_ITEMS } from './sidebar'
import { Topbar } from './topbar'

vi.mock('next/navigation', () => ({ usePathname: () => '/harnesses' }))
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }))

const dashboard = path.resolve(__dirname, '../../app/(dashboard)')

describe('navigation', () => {
  it.each(NAV_ITEMS.map((i) => [i.label, i.href] as const))('%s leads to a page that exists', (_label, href) => {
    const page = path.join(dashboard, href === '/' ? '' : href.slice(1), 'page.tsx')
    expect(fs.existsSync(page), page).toBe(true)
  })

  it('has no entry for the removed placeholder pages', () => {
    render(<><Sidebar /><MobileNav /></>)
    expect(screen.getAllByRole('link', { name: 'Keys' })).toHaveLength(2)
    for (const label of ['Tools', 'Memory', 'Permissions']) {
      expect(screen.queryByRole('link', { name: label })).toBeNull()
    }
  })
})

describe('Topbar', () => {
  it('does not advertise a search that is not there', () => {
    render(<Topbar />)
    expect(screen.queryByText(/search/i)).toBeNull()
    expect(screen.queryByText(/cmd\+k/i)).toBeNull()
  })
})
