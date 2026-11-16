// A deliberately broken tool gate: the real gate with the scratch-folder
// check left out, so a file tool is asked about and run with whatever path
// it was given. The suite must go red on it.
import { createGate } from '../../lib/runtimes/pi/cell/gate.ts'

export default createGate({ confine: false, limits: true })
