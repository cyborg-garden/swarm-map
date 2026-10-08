import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { AuthGuard } from '@/components/auth/auth-guard'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title: 'Swarm Map',
  description: 'Agent orchestration GUI for Hermes',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
          {/* Redirect any 401 from the auth gate to /login — covers the setup
              wizard too, which runs before the dashboard layout mounts. */}
          <AuthGuard />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
