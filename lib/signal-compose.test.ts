import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { signalComposeUpCommand } from './signal-compose'

describe('signalComposeUpCommand', () => {
  it('names the override file only when the deploy wrote one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-cmd-'))
    expect(signalComposeUpCommand(dir)).toBe('cd ~/.hermes-swarm && docker compose -f docker-compose.signal.yml up -d')
    fs.writeFileSync(path.join(dir, 'docker-compose.signal.override.yml'), 'services: {}\n')
    expect(signalComposeUpCommand(dir)).toBe(
      'cd ~/.hermes-swarm && docker compose -f docker-compose.signal.yml -f docker-compose.signal.override.yml up -d',
    )
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
