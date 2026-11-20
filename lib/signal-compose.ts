import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The shell command that starts the deployed signal-cli stack by hand. The
 * deploy route writes docker-compose.signal.yml to ~/.hermes-swarm, plus
 * docker-compose.signal.override.yml when the deployment has a local override
 * (the per-agent attachment mounts). The override has to be passed too, or the
 * daemon comes up unable to read those agents' attachments.
 */
export function signalComposeUpCommand(swarmDir: string = path.join(os.homedir(), '.hermes-swarm')): string {
  const files = ['docker-compose.signal.yml']
  if (fs.existsSync(path.join(swarmDir, 'docker-compose.signal.override.yml'))) {
    files.push('docker-compose.signal.override.yml')
  }
  return `cd ~/.hermes-swarm && docker compose ${files.map((f) => `-f ${f}`).join(' ')} up -d`
}
