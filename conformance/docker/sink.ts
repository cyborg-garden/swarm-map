// The sink: it stands in for "the internet". It sits on a network the cell
// and the sidecar are not on, accepts every connection, and writes one line
// per connection to its output. The rig reads that output from outside:
// exactly one line, from the control, means nothing else got here.
import net from 'node:net'
import { SINK_PORT } from './compose.ts'

const server = net.createServer((socket) => {
  let said = false
  const log = (first: string): void => {
    if (said) return
    said = true
    // Only what can be printed safely: the caller's address and the start of its first line.
    console.log(`SINK-HIT ${socket.remoteAddress ?? '?'} ${first.split(/\r?\n/)[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 120)}`)
    socket.end('HTTP/1.0 200 OK\r\ncontent-type: text/plain\r\n\r\nsink\n')
  }
  socket.once('data', (chunk) => log(chunk.toString('latin1')))
  socket.setTimeout(1500, () => { log('(connected and said nothing)'); socket.destroy() })
  socket.on('close', () => log('(connected and said nothing)'))
  socket.on('error', () => {})
})
server.listen(SINK_PORT, '0.0.0.0', () => console.log('SINK-UP'))
process.on('SIGTERM', () => process.exit(0))
