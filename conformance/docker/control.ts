// The control: the one container that is on the sink's network on purpose.
// It hits the sink once and leaves. If the sink's log does not then hold that
// one line, the sink or its log is broken and the run proves nothing.
import net from 'node:net'
import { SINK_PORT } from './compose.ts'

const nonce = process.env.SWARMLAB_NONCE ?? ''
const deadline = Date.now() + 20_000

function attempt(): void {
  const socket = net.connect({ host: 'sink', port: SINK_PORT })
  socket.setTimeout(2000, () => socket.destroy(new Error('timeout')))
  socket.on('connect', () => socket.write(`GET /control-${nonce} HTTP/1.0\r\n\r\n`))
  socket.on('data', () => { console.log('CONTROL-OK'); process.exit(0) })
  socket.on('error', () => {
    if (Date.now() > deadline) { console.log('CONTROL-FAILED'); process.exit(1) }
    setTimeout(attempt, 250)
  })
}
attempt()
