// A deliberately broken tool gate: the real gate with the limits left out,
// so a shell call is given no time limit and a tool's output is handed to the
// model whole. The suite must go red on it.
import { createGate } from '../../lib/runtimes/pi/cell/gate.ts'

export default createGate({ confine: true, limits: false })
