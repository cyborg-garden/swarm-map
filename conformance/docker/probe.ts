// The probe: run inside a container of the rig, it tries every way out we
// know of and reports what happened. It is test equipment. It is in the cell
// image so a tool run by the harness can run it, and so the rig can run it
// there from outside.
//
//   node probe.ts nonce=<nonce> sink=<ip> hostip=<ip> hostport=<port> [out=<file>]
//
// It prints one line of JSON, or writes it to `out`. Every network answer is
// either `open` (a connection was made, a name was resolved) or the reason it
// was not. Only the door may be open. It reports names and places, never the
// contents of what it finds.
import { execFileSync } from 'node:child_process'
import dns from 'node:dns'
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { BRAIN_PORT, ROUTE_PORT, SINK_PORT, SWARM_ROOT } from './compose.ts'
import type { ProbeReport } from './report.ts'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)] }))
const nonce = args.nonce ?? ''
const WAIT = 2500

function connect(host: string, port: number, hello?: string): Promise<string> {
  return new Promise((resolve) => {
    let socket: net.Socket
    const done = (answer: string): void => { socket?.destroy(); resolve(answer) }
    try { socket = net.connect({ host, port }) } catch (err) { resolve((err as NodeJS.ErrnoException).code ?? 'error'); return }
    socket.setTimeout(WAIT, () => done('timeout'))
    socket.on('connect', () => { if (hello) socket.write(hello); done('open') })
    socket.on('error', (err: NodeJS.ErrnoException) => done(err.code ?? 'error'))
  })
}
const resolve4 = (name: string): Promise<string> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), WAIT * 2)
    dns.resolve4(name, (err) => { clearTimeout(timer); resolve(err ? err.code ?? 'error' : 'open') })
  })
/** Asks a public resolver directly, over UDP, skipping the resolver Docker gives the container. */
const askResolver = (server: string, name: string): Promise<string> =>
  new Promise((resolve) => {
    const resolver = new dns.Resolver({ timeout: WAIT, tries: 1 })
    resolver.setServers([server])
    const timer = setTimeout(() => { resolver.cancel(); resolve('timeout') }, WAIT * 2)
    resolver.resolve4(name, (err) => { clearTimeout(timer); resolve(err ? err.code ?? 'error' : 'open') })
  })
/** The first address of each network this container is on: where Docker's own side of that network sits. */
function gateways(): string[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && a.cidr)
    .map((a) => {
      const [address, bits] = a!.cidr!.split('/')
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
      const n = address.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0)
      const first = ((n & mask) >>> 0) + 1
      return [first >>> 24, (first >>> 16) & 255, (first >>> 8) & 255, first & 255].join('.')
    })
}
const lookup = (name: string): Promise<string> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), WAIT * 2)
    dns.lookup(name, (err) => { clearTimeout(timer); resolve(err ? err.code ?? 'error' : 'open') })
  })

/** Says hello to the door with a token that is not this cell's. `refused` means the door hung up. */
function wrongToken(): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'door', port: BRAIN_PORT })
    let got = ''
    const timer = setTimeout(() => { socket.destroy(); resolve(got === '' ? 'kept-open' : 'answered') }, WAIT)
    socket.on('connect', () => socket.write(JSON.stringify({ t: 'hello', token: `BRAIN-${nonce}-ffffffffffffffff`, protocol: 1, caps: {} }) + '\n'))
    socket.on('data', (chunk) => { got += chunk.toString() })
    socket.on('close', () => { clearTimeout(timer); resolve(got === '' ? 'refused' : 'answered') })
    socket.on('error', () => {})
  })
}

/** Every place this run's model key or chat token can be read from here: files, and other processes. */
function findSecrets(): { found: string[]; files: number; procs: number } {
  const needles = [Buffer.from(`UPSTREAM-${nonce}`), Buffer.from(`FAKECHAT-${nonce}`)]
  const holds = (buf: Buffer): boolean => needles.some((n) => buf.includes(n))
  const found: string[] = []
  let files = 0
  let procs = 0
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue
    for (const what of ['environ', 'cmdline']) {
      try {
        const buf = readFileSync(`/proc/${pid}/${what}`)
        procs++
        if (holds(buf)) found.push(`/proc/${pid}/${what}`)
      } catch { /* not ours to read, or gone */ }
    }
  }
  if (needles.some((n) => Object.values(process.env).some((v) => v !== undefined && v.includes(n.toString())))) found.push('env')
  const walk = (dir: string): void => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const file = path.join(dir, name)
      if (['/proc', '/sys', '/dev'].includes(file)) continue
      let stat
      try { stat = lstatSync(file) } catch { continue }
      if (stat.isDirectory()) walk(file)
      else if (stat.isFile() && stat.size > 0 && stat.size < 64 * 1024 * 1024) {
        try {
          const buf = readFileSync(file)
          files++
          if (holds(buf)) found.push(file)
        } catch { /* unreadable to this user */ }
      }
    }
  }
  walk('/')
  return { found, files, procs }
}

function tryWrite(file: string): string {
  try {
    if (existsSync(file) && lstatSync(file).isDirectory()) writeFileSync(path.join(file, `probe-${nonce}`), 'x')
    else appendFileSync(file, '\n// probe\n')
    return 'written'
  } catch (err) { return (err as NodeJS.ErrnoException).code ?? 'error' }
}

function piBinary(): string {
  try { return execFileSync('sh', ['-c', 'readlink -f "$(command -v pi)"']).toString().trim() } catch { return '/usr/local/bin/pi' }
}

async function main(): Promise<void> {
  const hostPort = Number(args.hostport) || 80
  const netChecks: Record<string, Promise<string>> = {
    'the sink, by name': connect('sink', SINK_PORT, `GET /probe-by-name-${nonce} HTTP/1.0\r\n\r\n`),
    'a public address': connect('1.1.1.1', 443),
    'a public address over IPv6': connect('2606:4700:4700::1111', 443),
    'a public name, asked of DNS': resolve4('example.com'),
    'the name of this machine as Docker gives it': lookup('host.docker.internal'),
    'a listener on this machine, by name': connect('host.docker.internal', hostPort, `GET /probe-${nonce} HTTP/1.0\r\n\r\n`),
    'a listener on this machine, by the gateway name': connect('gateway.docker.internal', hostPort, `GET /probe-${nonce} HTTP/1.0\r\n\r\n`),
    'the cloud metadata address': connect('169.254.169.254', 80),
    'a public resolver, asked directly over UDP': askResolver('1.1.1.1', 'example.com'),
  }
  if (args.hostip) netChecks['a listener on this machine, by address'] = connect(args.hostip, hostPort, `GET /probe-${nonce} HTTP/1.0\r\n\r\n`)
  for (const gateway of gateways()) {
    // Where a Docker engine would answer if it were ever put on the network, and this machine's listener again.
    for (const port of [2375, 2376, hostPort]) netChecks[`port ${port === hostPort ? 'of this machine\'s listener' : port} on Docker's side of the network (${gateway})`] = connect(gateway, port)
  }
  if (args.sink) netChecks['the sink, by address'] = connect(args.sink, SINK_PORT, `GET /probe-by-address-${nonce} HTTP/1.0\r\n\r\n`)
  const netAnswers: Record<string, string> = {}
  for (const [what, answer] of Object.entries(netChecks)) netAnswers[what] = await answer

  const status = readFileSync('/proc/self/status', 'utf8')
  const field = (name: string): string => status.match(new RegExp(`^${name}:\\s*(\\S+)`, 'm'))?.[1] ?? '?'
  const secrets = findSecrets()
  const report: ProbeReport = {
    who: os.hostname(),
    uid: process.getuid?.() ?? -1,
    door: await connect('door', BRAIN_PORT),
    doorRoute: await connect('door', ROUTE_PORT),
    net: netAnswers,
    wrongToken: await wrongToken(),
    secrets: secrets.found,
    searched: { files: secrets.files, procs: secrets.procs },
    writes: {
      'the gate': tryWrite(`${SWARM_ROOT}/lib/runtimes/pi/cell/gate.ts`),
      'the shim': tryWrite(`${SWARM_ROOT}/lib/runtimes/pi/shim.ts`),
      'the cell entry': tryWrite(`${SWARM_ROOT}/conformance/docker/cell-main.ts`),
      'the folder the shim is in': tryWrite(`${SWARM_ROOT}/lib/runtimes/pi`),
      'the harness binary': tryWrite(piBinary()),
      'the root of the disk': tryWrite('/'),
    },
    dockerSocket: ['/var/run/docker.sock', '/run/docker.sock'].some((p) => existsSync(p)),
    mounts: readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean)
      .map((line) => { const [left, right] = line.split(' - '); return `${left.split(' ')[4]} ${right.split(' ')[0]}` })
      .filter((m) => !/ (overlay|proc|sysfs|tmpfs|devpts|mqueue|cgroup2?|shm|devtmpfs)$/.test(m))
      .filter((m) => !['/etc/resolv.conf', '/etc/hostname', '/etc/hosts'].includes(m.split(' ')[0])),
    noNewPrivs: field('NoNewPrivs'),
    capEff: field('CapEff'),
    ipv6: Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv6' && !a.internal).map((a) => a!.address),
  }
  const line = JSON.stringify(report)
  if (args.out) writeFileSync(args.out, line + '\n')
  else console.log(line)
}

if (path.resolve(process.argv[1] ?? '') === import.meta.filename) await main()
