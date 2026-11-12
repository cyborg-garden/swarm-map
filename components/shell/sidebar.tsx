'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Bot, MessageSquare, Wrench, KeyRound,
  Brain, Users, ScrollText, Settings, Plug,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const icons: Record<string, LucideIcon> = {
  LayoutDashboard, Bot, MessageSquare, Wrench, KeyRound,
  Brain, Users, ScrollText, Settings, Plug,
}

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: 'LayoutDashboard' },
  { label: 'Harnesses', href: '/harnesses', icon: 'Bot' },
  // { label: 'Surfaces', href: '/surfaces', icon: 'Plug' },
  { label: 'Tools', href: '/tools', icon: 'Wrench' },
  { label: 'Keys', href: '/keys', icon: 'KeyRound' },
  { label: 'Memory', href: '/memory', icon: 'Brain' },
  { label: 'Audit', href: '/audit', icon: 'ScrollText' },
  { label: 'Settings', href: '/settings', icon: 'Settings' },
] as const

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden md:flex flex-col w-56 border-r border-[var(--border)] bg-[var(--surface)] h-screen sticky top-0">
      <div className="px-4 py-5">
        <h1 className="text-base font-semibold">Swarm Map</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Hermes Orchestration</p>
      </div>
      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = icons[item.icon]
          const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? 'bg-accent/10 text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}

/**
 * Horizontal, scrollable nav for small screens (< md), rendered under the
 * topbar. The sidebar is hidden below md — without this there is no way to
 * navigate on a phone.
 */
export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Mobile" className="md:hidden flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
      {NAV_ITEMS.map((item) => {
        const Icon = icons[item.icon]
        const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-md text-sm whitespace-nowrap shrink-0 transition-colors ${
              isActive
                ? 'bg-accent/10 text-accent-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
