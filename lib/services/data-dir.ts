import path from 'path'
import os from 'os'

/** Where Swarm Map keeps its own state (harnesses.json, settings, audit). */
export const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR.replace('~', os.homedir())
  : path.join(os.homedir(), '.hermes-swarm-map')
