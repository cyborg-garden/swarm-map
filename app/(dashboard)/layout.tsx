import { Sidebar, MobileNav } from '@/components/shell/sidebar'
import { Topbar } from '@/components/shell/topbar'
import { redirect } from 'next/navigation'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Force dynamic rendering — onboarding state changes at runtime
export const dynamic = 'force-dynamic'

function isOnboarded(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.hermes-swarm-map', 'settings.json')
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(raw)
    return settings?.onboarded === true
  } catch {
    return false
  }
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!isOnboarded()) {
    redirect('/setup')
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <MobileNav />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  )
}
