'use client'

import { useState, useEffect } from 'react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Sun, Moon } from 'lucide-react'

export function Topbar() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  return (
    <header className="flex items-center justify-end h-14 px-4 md:px-6 border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="h-8 w-8"
        >
          {mounted ? (theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />) : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  )
}
