#!/usr/bin/env node
// Host CLI for the token broker. See README.md. Prints no values.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, adoptKey, createBroker, listen, startMonitor } from './lib.mjs'
import { agentsHoldingAppKey, purgeBackups, rollout, undo } from './rollout.mjs'

const dir = process.env.GITHUB_BROKER_DIR ?? path.join(os.homedir(), '.config', 'hermes', 'github-app')
const homeRoot = process.env.GITHUB_BROKER_HOME_ROOT ?? os.homedir()
const [cmd, ...args] = process.argv.slice(2)

function report({ lines, ok }) {
  for (const l of lines) console.log(l)
  process.exitCode = ok ? 0 : 1
}

async function readStdin() {
  let raw = ''
  process.stdin.setEncoding('utf-8')
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

switch (cmd) {
  case 'serve': {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
    const port = config.port ?? DEFAULT_PORT
    const broker = createBroker({ dir })
    await listen(broker, { host: '127.0.0.1', port })
    startMonitor(broker)
    console.log(`token broker listening on 127.0.0.1:${port}`)
    break
  }
  case 'adopt-key': {
    try {
      await adoptKey({ dir, pem: await readStdin() })
    } catch (err) {
      console.error(`Key NOT changed: ${err.message}`)
      process.exit(1)
    }
    console.log('New key proved with a test mint and in use. No downtime.')
    const holding = agentsHoldingAppKey(homeRoot)
    if (holding.length) console.log(`HOLD: keep the old key for now. These agents still use it: ${holding.join(', ')}`)
    break
  }
  case 'rollout':
    report(await rollout({
      agent: args[0], homeRoot, dir, apply: args.includes('--apply'), acceptLoss: args.includes('--accept-loss'),
    }))
    break
  case 'undo':
    report(await undo({ agent: args[0], homeRoot, dir }))
    break
  case 'purge-backups':
    purgeBackups({ dir })
    console.log('Backups deleted.')
    break
  default:
    console.error('usage: broker.mjs serve | adopt-key | rollout <agent> [--apply] [--accept-loss] | undo <agent> | purge-backups')
    process.exit(2)
}
