import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'

function agentDataDir(harnessId: string): string {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  if (name === 'personal') return path.join(os.homedir(), '.hermes')
  return path.join(os.homedir(), `.hermes-${name}`)
}

type ApprovedEntry = {
  user_name: string
  approved_at: number
}

type PairingUser = {
  userId: string
  userName: string
  approvedAt: number
  platform: string
}

const PLATFORMS = ['signal', 'telegram', 'mattermost', 'discord', 'slack']

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const dataDir = agentDataDir(id)
  const pairingDir = path.join(dataDir, 'platforms', 'pairing')

  const users: PairingUser[] = []

  for (const platform of PLATFORMS) {
    const filePath = path.join(pairingDir, `${platform}-approved.json`)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(content) as Record<string, ApprovedEntry>
      for (const [userId, entry] of Object.entries(data)) {
        users.push({
          userId,
          userName: entry.user_name || '',
          approvedAt: entry.approved_at,
          platform,
        })
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  return NextResponse.json({ users })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await request.json()
  const { platform, userId } = body as { platform: string; userId: string }

  if (!platform || !userId) {
    return NextResponse.json({ error: 'Missing platform or userId' }, { status: 400 })
  }

  const dataDir = agentDataDir(id)
  const filePath = path.join(dataDir, 'platforms', 'pairing', `${platform}-approved.json`)

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Pairing file not found' }, { status: 404 })
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const data = JSON.parse(content) as Record<string, ApprovedEntry>

  if (!(userId in data)) {
    return NextResponse.json({ error: 'User not found in pairing store' }, { status: 404 })
  }

  delete data[userId]
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })

  return NextResponse.json({ ok: true })
}
