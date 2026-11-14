// The relay: a pipe, for when the door runs on the machine itself and the
// cell runs in a container on a network with no way out. It sits on the
// cell's network under the door's name and passes two ports through to the
// door, byte for byte. It holds no token and no key, reads nothing it
// carries, and listens for nothing else.
//
//   SMLAB_RELAY="7801=host.docker.internal:50001,7802=host.docker.internal:50002"
import net from 'node:net'

const PAIR = /^(\d{2,5})=([A-Za-z0-9.-]+):(\d{2,5})$/
const pairs = (process.env.SMLAB_RELAY ?? '').split(',').filter(Boolean)
if (pairs.length === 0 || !pairs.every((pair) => PAIR.test(pair))) {
  console.error('relay: SMLAB_RELAY must be a list of port=host:port')
  process.exit(2)
}

for (const pair of pairs) {
  const [, listen, host, port] = pair.match(PAIR) as RegExpMatchArray
  net.createServer((inner) => {
    const outer = net.connect({ host, port: Number(port) })
    const end = (): void => { inner.destroy(); outer.destroy() }
    inner.on('error', end)
    outer.on('error', end)
    inner.on('close', end)
    outer.on('close', end)
    inner.pipe(outer)
    outer.pipe(inner)
  }).listen(Number(listen), '0.0.0.0')
}
console.log('RELAY-UP')
process.on('SIGTERM', () => process.exit(0))
