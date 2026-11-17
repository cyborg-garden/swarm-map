// A deliberately broken tool gate: the real gate, except that its web tool
// fetches the page by itself instead of asking the door. In a cell with no
// route out it gets nothing; in the process lab the tripwire stops it. Either
// way the page never reaches the model, and the suite must go red on it.
import { createGate } from '../../lib/runtimes/pi/cell/gate.ts'

export default createGate({ confine: true, limits: true, web: 'direct' })
